//! Signed desktop updates. The renderer never supplies URLs, paths, keys or installer bytes.
use futures_util::future::{AbortHandle, Abortable};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const EVENT: &str = "bf://updater-state";
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Gitee,
    Github,
}
impl Source {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Gitee => "https://gitee.com/yyuchenn/bubblefish/raw/updater/latest.json",
            Self::Github => {
                "https://raw.githubusercontent.com/yyuchenn/bubblefish/updater/latest.json"
            }
        }
    }
    fn alternate(self) -> Self {
        match self {
            Self::Gitee => Self::Github,
            Self::Github => Self::Gitee,
        }
    }
}
async fn source_fallback<T, F, Fut>(source: Source, mut fetch: F) -> Result<(Source, T), String>
where
    F: FnMut(Source) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut errors = Vec::new();
    for actual in [source, source.alternate()] {
        match fetch(actual).await {
            Ok(value) => return Ok((actual, value)),
            Err(error) => errors.push(format!("{actual:?}: {error}")),
        }
    }
    Err(errors.join("；"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    id: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    source: Source,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    phase: &'static str,
    current_version: String,
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    unsupported_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release: Option<Release>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready: Option<Release>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_checked: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Clone)]
struct Candidate {
    update: Update,
    info: Release,
}
fn advances_staged(version: &str, ready_version: Option<&str>) -> bool {
    let Ok(version) = semver::Version::parse(version) else {
        return false;
    };
    let Some(ready_version) = ready_version else {
        return true;
    };
    let Ok(ready) = semver::Version::parse(ready_version) else {
        return false;
    };
    version.cmp_precedence(&ready).is_gt()
}
impl Candidate {
    fn new(update: Update, source: Source) -> Result<Self, String> {
        if update.download_url.scheme() != "https" {
            return Err("更新下载地址必须使用 HTTPS".into());
        }
        let id = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}\n{}\n{}",
                update.target, update.version, update.signature
            ))
        );
        let info = Release {
            id,
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update.date.and_then(|date| {
                date.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            }),
            source,
        };
        Ok(Self { update, info })
    }
}
struct Inner {
    snapshot: Snapshot,
    candidate: Option<Candidate>,
    ready: Option<Candidate>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheRecord {
    schema: u32,
    source: Source,
    raw_json: Value,
}
#[derive(Deserialize, Serialize)]
struct Pointer {
    generation: String,
}
struct Cache {
    root: PathBuf,
}
impl Cache {
    fn generation_name(name: &str) -> bool {
        name.is_ascii()
            && name.len() > 65
            && name.len() < 110
            && name.as_bytes().get(64) == Some(&b'-')
            && name[..64].bytes().all(|c| c.is_ascii_hexdigit())
            && name[65..].bytes().all(|c| c.is_ascii_digit())
    }
    fn read(&self) -> Result<Option<(CacheRecord, Vec<u8>)>, String> {
        let pointer = self.root.join("ready.json");
        if !pointer.exists() {
            return Ok(None);
        }
        regular(&pointer)?;
        let pointer: Pointer =
            serde_json::from_slice(&fs::read(pointer).map_err(super::err)?).map_err(super::err)?;
        if !Self::generation_name(&pointer.generation) {
            return Err("更新缓存索引无效".into());
        }
        let directory = self.root.join(&pointer.generation);
        if fs::symlink_metadata(&directory)
            .map_err(super::err)?
            .file_type()
            .is_symlink()
        {
            return Err("更新缓存不能使用符号链接".into());
        }
        let metadata = directory.join("metadata.json");
        let package = directory.join("package.bin");
        regular(&metadata)?;
        let size = regular(&package)?.len();
        if size == 0 || size > MAX_PACKAGE {
            return Err("更新缓存大小无效".into());
        }
        let record: CacheRecord =
            serde_json::from_slice(&fs::read(metadata).map_err(super::err)?).map_err(super::err)?;
        if record.schema != 1 {
            return Err("更新缓存版本不受支持".into());
        }
        Ok(Some((record, fs::read(package).map_err(super::err)?)))
    }
    fn store(&self, candidate: &Candidate, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_PACKAGE {
            return Err("更新包大小无效".into());
        }
        fs::create_dir_all(&self.root).map_err(super::err)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(super::err)?
            .as_nanos();
        let generation = format!("{}-{nonce}", candidate.info.id);
        let staging = self.root.join(format!(".partial-{generation}"));
        let destination = self.root.join(&generation);
        fs::create_dir(&staging).map_err(super::err)?;
        let result = (|| {
            super::atomic_write(&staging.join("package.bin"), bytes)?;
            let record = CacheRecord {
                schema: 1,
                source: candidate.info.source,
                raw_json: candidate.update.raw_json.clone(),
            };
            super::atomic_write(
                &staging.join("metadata.json"),
                &serde_json::to_vec(&record).map_err(super::err)?,
            )?;
            fs::rename(&staging, &destination).map_err(super::err)?;
            super::atomic_write(
                &self.root.join("ready.json"),
                &serde_json::to_vec(&Pointer {
                    generation: generation.clone(),
                })
                .map_err(super::err)?,
            )?;
            self.cleanup(Some(&generation));
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(staging);
        }
        result
    }
    fn clear(&self) {
        let _ = fs::remove_file(self.root.join("ready.json"));
        self.cleanup(None);
    }
    fn cleanup(&self, keep: Option<&str>) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if Some(name) != keep && (Self::generation_name(name) || name.starts_with(".partial-"))
            {
                if entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}
fn regular(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(super::err)?;
    if !metadata.is_file() {
        return Err("更新缓存必须为普通文件".into());
    }
    Ok(metadata)
}
fn validate_package_kind(target: &str, bytes: &[u8]) -> Result<(), String> {
    let valid = if target.ends_with("-msi") {
        bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    } else if target.ends_with("-nsis") {
        bytes.starts_with(b"MZ")
    } else if target.starts_with("darwin-") {
        bytes.starts_with(&[0x1f, 0x8b, 0x08])
    } else {
        false
    };
    if valid {
        Ok(())
    } else {
        Err("更新包类型与当前安装类型不一致，请重新检查更新".into())
    }
}
fn restore_candidate(
    updater: &Updater,
    record: CacheRecord,
    bytes: &[u8],
) -> Result<Option<Candidate>, String> {
    let Some(update) = updater
        .restore_update(record.raw_json)
        .map_err(super::err)?
    else {
        return Ok(None);
    };
    update.verify(bytes).map_err(super::err)?;
    validate_package_kind(&update.target, bytes)?;
    Candidate::new(update, record.source).map(Some)
}

/// Explicit targets prohibit a newer NSIS client from falling back to the legacy MSI feed.
fn target_for(
    os: &str,
    arch: &str,
    bundle: Option<tauri::utils::config::BundleType>,
) -> Result<String, String> {
    use tauri::utils::config::BundleType;
    match (os, arch, bundle) {
        ("windows", "x86_64", Some(BundleType::Msi)) => Ok("windows-x86_64-msi".into()),
        ("windows", "x86_64", Some(BundleType::Nsis)) => Ok("windows-x86_64-nsis".into()),
        ("macos", "aarch64", _) => Ok("darwin-aarch64-app".into()),
        _ => Err("当前安装类型或平台不支持自动更新，请使用正式安装包".into()),
    }
}
fn installation_support() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("开发构建可以检查更新，但不能安装更新".into());
    }
    target_for(
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::utils::platform::bundle_type(),
    )?;
    #[cfg(target_os = "macos")]
    {
        let path = std::env::current_exe().map_err(super::err)?;
        let macos = path.parent().ok_or("应用路径无效")?;
        let contents = macos.parent().ok_or("应用路径无效")?;
        let app = contents.parent().ok_or("应用路径无效")?;
        if macos.file_name().is_none_or(|name| name != "MacOS")
            || contents.file_name().is_none_or(|name| name != "Contents")
            || app.extension().is_none_or(|ext| ext != "app")
        {
            return Err("请从 Bubblefish.app 中启动后安装更新".into());
        }
    }
    Ok(())
}

pub struct UpdateManager {
    app: tauri::AppHandle,
    inner: Mutex<Inner>,
    cache: Cache,
    busy: AtomicBool,
    exiting: AtomicBool,
    generation: AtomicU64,
    abort: Mutex<Option<AbortHandle>>,
}
impl UpdateManager {
    pub fn new(app: tauri::AppHandle) -> Result<Self, String> {
        let support = installation_support();
        let manager = Self {
            cache: Cache {
                root: app
                    .path()
                    .app_cache_dir()
                    .map_err(super::err)?
                    .join("updater"),
            },
            inner: Mutex::new(Inner {
                snapshot: Snapshot {
                    revision: 0,
                    phase: "idle",
                    current_version: app.package_info().version.to_string(),
                    supported: support.is_ok(),
                    unsupported_reason: support.err(),
                    release: None,
                    ready: None,
                    progress: None,
                    last_checked: None,
                    error: None,
                },
                candidate: None,
                ready: None,
            }),
            app,
            busy: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            abort: Mutex::new(None),
        };
        if manager.snapshot()?.supported {
            if let Err(error) = manager.restore() {
                manager.cache.clear();
                manager.change(|inner| {
                    inner.snapshot.phase = "error";
                    inner.snapshot.error = Some(format!("已移除无效更新缓存：{error}"));
                });
            }
        }
        Ok(manager)
    }
    fn builder(&self, source: Source) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
        // The default hook destroys Tauri resources before Windows knows whether launch succeeded.
        // Native children are quiesced separately, and a failed launch leaves the app recoverable.
        let mut builder = self
            .app
            .updater_builder()
            .on_before_exit(|| {})
            .timeout(Duration::from_secs(25));
        match target_for(
            std::env::consts::OS,
            std::env::consts::ARCH,
            tauri::utils::platform::bundle_type(),
        ) {
            Ok(target) => builder = builder.target(target),
            Err(_) if cfg!(debug_assertions) && cfg!(windows) => {
                builder = builder.target("windows-x86_64-msi")
            }
            Err(error) => return Err(error),
        }
        builder
            .endpoints(vec![source.endpoint().parse().map_err(super::err)?])
            .map_err(super::err)
    }
    fn updater(&self, source: Source) -> Result<Updater, String> {
        self.builder(source)?.build().map_err(super::err)
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        Ok(super::lock(&self.inner)?.snapshot.clone())
    }
    fn change(&self, operation: impl FnOnce(&mut Inner)) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        operation(&mut inner);
        inner.snapshot.revision = inner.snapshot.revision.saturating_add(1);
        let snapshot = inner.snapshot.clone();
        drop(inner);
        let _ = self.app.emit(EVENT, snapshot);
    }
    fn restore(&self) -> Result<(), String> {
        let Some((record, bytes)) = self.cache.read()? else {
            self.cache.cleanup(None);
            return Ok(());
        };
        let Some(candidate) = restore_candidate(&self.updater(record.source)?, record, &bytes)?
        else {
            self.cache.clear();
            return Ok(());
        };
        self.change(|inner| {
            inner.snapshot.phase = "ready";
            inner.snapshot.ready = Some(candidate.info.clone());
            inner.ready = Some(candidate);
        });
        Ok(())
    }
    fn start(&self) -> Result<(AbortHandle, futures_util::future::AbortRegistration), String> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("已有更新任务正在进行".into());
        }
        let (handle, registration) = AbortHandle::new_pair();
        let mut abort = super::lock(&self.abort)?;
        if self.exiting.load(Ordering::SeqCst) {
            self.busy.store(false, Ordering::SeqCst);
            return Err("应用正在退出".into());
        }
        *abort = Some(handle.clone());
        Ok((handle, registration))
    }
    fn complete(&self, result: &Result<Snapshot, String>) {
        if let Ok(mut abort) = self.abort.lock() {
            *abort = None;
        }
        self.busy.store(false, Ordering::SeqCst);
        if !self.exiting.load(Ordering::SeqCst) {
            if let Err(error) = result {
                if error != "更新任务已取消" {
                    self.change(|inner| {
                        inner.snapshot.phase = "error";
                        inner.snapshot.progress = None;
                        inner.snapshot.error = Some(error.clone());
                    });
                }
            }
        }
    }
    pub async fn check(&self, source: Source) -> Result<Snapshot, String> {
        let (_, registration) = self.start()?;
        let generation = self.generation.load(Ordering::SeqCst);
        let result = Abortable::new(
            async {
                if self.exiting.load(Ordering::SeqCst) {
                    return Err("更新任务已取消".into());
                }
                self.change(|inner| {
                    inner.snapshot.phase = "checking";
                    inner.snapshot.error = None;
                });
                let (actual, update) = source_fallback(source, |actual| async move {
                    self.updater(actual)?.check().await.map_err(super::err)
                })
                .await?;
                if self.generation.load(Ordering::SeqCst) != generation {
                    return Err("更新任务已取消".into());
                }
                let candidate = update
                    .map(|update| Candidate::new(update, actual))
                    .transpose()?;
                self.change(|inner| {
                    let candidate = candidate.filter(|candidate| {
                        advances_staged(
                            &candidate.info.version,
                            inner
                                .ready
                                .as_ref()
                                .map(|ready| ready.info.version.as_str()),
                        )
                    });
                    inner.snapshot.last_checked = Some(
                        time::OffsetDateTime::now_utc()
                            .format(&time::format_description::well_known::Rfc3339)
                            .unwrap_or_default(),
                    );
                    inner.snapshot.release = candidate.as_ref().map(|value| value.info.clone());
                    inner.snapshot.phase = if inner.ready.is_some() {
                        "ready"
                    } else if candidate.is_some() {
                        "available"
                    } else {
                        "idle"
                    };
                    inner.candidate = candidate;
                });
                self.snapshot()
            },
            registration,
        )
        .await
        .unwrap_or_else(|_| Err("更新任务已取消".into()));
        self.complete(&result);
        result
    }
    async fn download_bytes(
        &self,
        candidate: &Candidate,
        limit_exceeded: &AtomicBool,
    ) -> Result<Vec<u8>, tauri_plugin_updater::Error> {
        let mut update = candidate.update.clone();
        update.timeout = Some(Duration::from_secs(600));
        let abort = self.abort.lock().ok().and_then(|handle| handle.clone());
        let generation = self.generation.load(Ordering::SeqCst);
        let mut downloaded = 0u64;
        let mut last_progress = std::time::Instant::now() - Duration::from_millis(100);
        update
            .download(
                |length, total| {
                    if self.generation.load(Ordering::SeqCst) != generation
                        || self.exiting.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    downloaded = downloaded.saturating_add(length as u64);
                    if downloaded > MAX_PACKAGE || total.is_some_and(|total| total > MAX_PACKAGE) {
                        limit_exceeded.store(true, Ordering::SeqCst);
                        if let Some(abort) = &abort {
                            abort.abort();
                        }
                        return;
                    }
                    if last_progress.elapsed() >= Duration::from_millis(100)
                        || total == Some(downloaded)
                    {
                        self.change(|inner| {
                            inner.snapshot.progress = Some(Progress { downloaded, total })
                        });
                        last_progress = std::time::Instant::now();
                    }
                },
                || {
                    if self.generation.load(Ordering::SeqCst) == generation
                        && !self.exiting.load(Ordering::SeqCst)
                    {
                        self.change(|inner| inner.snapshot.phase = "verifying");
                    }
                },
            )
            .await
    }
    pub async fn download(&self, release_id: String) -> Result<Snapshot, String> {
        installation_support()?;
        let (_, registration) = self.start()?;
        let generation = self.generation.load(Ordering::SeqCst);
        let limit_exceeded = AtomicBool::new(false);
        let result = Abortable::new(
            async {
                let mut candidate = {
                    let inner = super::lock(&self.inner)?;
                    if inner
                        .ready
                        .as_ref()
                        .is_some_and(|value| value.info.id == release_id)
                    {
                        return Ok(inner.snapshot.clone());
                    }
                    let candidate = inner
                        .candidate
                        .clone()
                        .filter(|value| value.info.id == release_id)
                        .ok_or("更新信息已变化，请重新检查更新")?;
                    if !advances_staged(
                        &candidate.info.version,
                        inner
                            .ready
                            .as_ref()
                            .map(|ready| ready.info.version.as_str()),
                    ) {
                        return Err("已有相同或更新版本的已下载包".into());
                    }
                    candidate
                };
                self.change(|inner| {
                    inner.snapshot.phase = "downloading";
                    inner.snapshot.progress = Some(Progress {
                        downloaded: 0,
                        total: None,
                    });
                    inner.snapshot.error = None;
                });
                let bytes = match self.download_bytes(&candidate, &limit_exceeded).await {
                    Ok(bytes) => bytes,
                    Err(error)
                        if matches!(
                            error,
                            tauri_plugin_updater::Error::Reqwest(_)
                                | tauri_plugin_updater::Error::Network(_)
                        ) =>
                    {
                        let source = candidate.info.source.alternate();
                        let update = self
                            .updater(source)?
                            .check()
                            .await
                            .map_err(super::err)?
                            .ok_or("备用源暂未同步该更新")?;
                        let alternate = Candidate::new(update, source)?;
                        if alternate.info.version != candidate.info.version
                            || alternate.info.id != candidate.info.id
                        {
                            return Err("备用源更新尚未同步，请稍后重新检查".into());
                        }
                        if self.exiting.load(Ordering::SeqCst)
                            || self.generation.load(Ordering::SeqCst) != generation
                        {
                            return Err("更新任务已取消".into());
                        }
                        candidate = alternate;
                        self.change(|inner| {
                            inner.snapshot.phase = "downloading";
                            inner.snapshot.release = Some(candidate.info.clone());
                            inner.snapshot.progress = Some(Progress {
                                downloaded: 0,
                                total: None,
                            });
                            inner.candidate = Some(candidate.clone());
                        });
                        self.download_bytes(&candidate, &limit_exceeded)
                            .await
                            .map_err(super::err)?
                    }
                    Err(error) => return Err(format!("更新包校验失败：{error}")),
                };
                if self.exiting.load(Ordering::SeqCst)
                    || self.generation.load(Ordering::SeqCst) != generation
                {
                    return Err("更新任务已取消".into());
                }
                validate_package_kind(&candidate.update.target, &bytes)?;
                // Hold the state lock across atomic cache publication so exit sees a complete generation.
                {
                    let mut inner = super::lock(&self.inner)?;
                    if self.exiting.load(Ordering::SeqCst)
                        || self.generation.load(Ordering::SeqCst) != generation
                    {
                        return Err("更新任务已取消".into());
                    }
                    if !advances_staged(
                        &candidate.info.version,
                        inner
                            .ready
                            .as_ref()
                            .map(|ready| ready.info.version.as_str()),
                    ) {
                        return Err("已有相同或更新版本的已下载包".into());
                    }
                    self.cache.store(&candidate, &bytes)?;
                    inner.snapshot.phase = "ready";
                    inner.snapshot.ready = Some(candidate.info.clone());
                    inner.snapshot.release = Some(candidate.info.clone());
                    inner.snapshot.progress = None;
                    inner.ready = Some(candidate.clone());
                    inner.candidate = Some(candidate);
                }
                self.change(|_| {});
                self.snapshot()
            },
            registration,
        )
        .await
        .unwrap_or_else(|_| Err("更新任务已取消".into()));
        let result = if limit_exceeded.load(Ordering::SeqCst) {
            Err("更新包超过 512 MiB 大小上限".into())
        } else {
            result
        };
        self.complete(&result);
        result
    }
    fn cancel_pending(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(handle) = self.abort.lock() {
            if let Some(handle) = handle.as_ref() {
                handle.abort();
            }
        }
    }
    fn exit_failed(&self, error: &str) {
        self.exiting.store(false, Ordering::SeqCst);
        self.change(|inner| {
            inner.snapshot.phase = "error";
            inner.snapshot.progress = None;
            inner.snapshot.error = Some(error.into());
        });
    }
    fn prepared_update(&self) -> Result<Option<(Update, Vec<u8>)>, String> {
        let mut inner = super::lock(&self.inner)?;
        let Some(expected) = inner.ready.clone() else {
            return Ok(None);
        };
        installation_support()?;
        let result = (|| {
            let Some((record, bytes)) = self.cache.read()? else {
                return Err("已下载的更新包不存在，请重新下载".into());
            };
            let Some(candidate) = restore_candidate(&self.updater(record.source)?, record, &bytes)?
            else {
                return Err("更新缓存已经过期，请重新检查".into());
            };
            if candidate.info.id != expected.info.id {
                return Err("更新缓存与已确认版本不一致，请重新下载".into());
            }
            Ok(Some((candidate.update, bytes)))
        })();
        if result.is_err() {
            self.cache.clear();
            inner.ready = None;
            inner.snapshot.ready = None;
            inner.snapshot.release = Some(expected.info.clone());
            inner.candidate = Some(expected);
        }
        result
    }
}

type State<'a> = tauri::State<'a, Arc<UpdateManager>>;
#[tauri::command]
pub fn updater_state(state: State<'_>) -> Result<Snapshot, String> {
    state.snapshot()
}
#[tauri::command]
pub async fn updater_check(state: State<'_>, source: Source) -> Result<Snapshot, String> {
    state.check(source).await
}
#[tauri::command]
pub async fn updater_download(state: State<'_>, release_id: String) -> Result<Snapshot, String> {
    state.download(release_id).await
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ExitMode {
    Quit,
    InstallRestart,
}
fn commit_exit<P>(
    mode: ExitMode,
    package: Option<P>,
    pause: impl FnOnce() -> Result<(), String>,
    install: impl FnOnce(P, bool) -> Result<(), String>,
    finish: impl FnOnce(bool),
) -> Result<(), String> {
    let restart = mode == ExitMode::InstallRestart;
    if restart && package.is_none() {
        return Err("没有已下载并校验的更新".into());
    }
    pause()?;
    if let Some(package) = package {
        install(package, restart)?;
    }
    finish(restart);
    Ok(())
}
#[tauri::command]
pub async fn platform_finish_exit(
    app: tauri::AppHandle,
    mode: ExitMode,
    skip_update: bool,
    install_on_exit: bool,
) -> Result<(), String> {
    let host = app.state::<super::HostState>();
    if host.closing.swap(true, Ordering::SeqCst) {
        return Err("应用已经在退出".into());
    }
    let manager = app.state::<Arc<UpdateManager>>().inner().clone();
    manager.cancel_pending();
    let plugins = app
        .state::<Arc<crate::plugin_host::PluginManager>>()
        .inner()
        .clone();
    let run_app = app.clone();
    let run_manager = manager.clone();
    let run_plugins = plugins.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if mode == ExitMode::InstallRestart {
            installation_support()?;
        }
        let update = if !skip_update && (install_on_exit || mode == ExitMode::InstallRestart) {
            run_manager.prepared_update()?
        } else {
            None
        };
        commit_exit(
            mode,
            update,
            || run_plugins.pause_for_exit(),
            |(update, bytes), restart| {
                run_manager.change(|inner| inner.snapshot.phase = "installing");
                // Windows never returns on successful installer launch. The cache survives cancellation.
                update
                    .restart_after_install(restart)
                    .install(bytes)
                    .map_err(super::err)?;
                #[cfg(not(windows))]
                run_manager.cache.clear();
                Ok(())
            },
            |restart| {
                if restart {
                    run_app.request_restart();
                } else {
                    run_app.exit(0);
                }
            },
        )
    })
    .await
    .map_err(super::err)
    .and_then(|result| result);
    if let Err(error) = &result {
        host.closing.store(false, Ordering::SeqCst);
        plugins.resume_after_exit_failure();
        manager.exit_failed(error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PACKAGE: &[u8] = include_bytes!("../tests/fixtures/updater/package.bin");
    const SIGNATURE: &str = include_str!("../tests/fixtures/updater/package.bin.sig");
    const PUBLIC_KEY: &str = include_str!("../tests/fixtures/updater/public.key");
    const TARGET: &str = "windows-x86_64-nsis";

    fn test_updater(current: bool) -> Updater {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({ "pubkey": PUBLIC_KEY.trim(), "requireSignedVersion": true }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let builder = app
            .updater_builder()
            .target(TARGET)
            .endpoints(vec!["https://example.invalid/latest.json".parse().unwrap()])
            .unwrap()
            .configure_client(|_| panic!("Offline cache tests must not access the network"))
            .on_before_exit(|| panic!("Tests must never install or launch an updater"));
        if current {
            builder.version_comparator(|_, _| false).build().unwrap()
        } else {
            builder.build().unwrap()
        }
    }
    fn record() -> CacheRecord {
        CacheRecord {
            schema: 1,
            source: Source::Gitee,
            raw_json: json!({
                "version": "2.0.0", "notes": "Offline test release", "pub_date": "2026-01-01T00:00:00Z",
                "platforms": { TARGET: { "url": "https://example.invalid/package.exe", "signature": SIGNATURE.trim() } },
            }),
        }
    }
    struct TestCache(Cache);
    impl TestCache {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(Cache {
                root: std::env::temp_dir()
                    .join(format!("bf-updater-test-{}-{nonce}", std::process::id())),
            })
        }
    }
    impl Drop for TestCache {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.root);
        }
    }

    #[test]
    fn public_cli_signed_cache_restores_offline_and_binds_version() {
        let updater = test_updater(false);
        let candidate = restore_candidate(&updater, record(), PACKAGE)
            .unwrap()
            .unwrap();
        assert_eq!(candidate.info.version, "2.0.0");
        let mut changed = record();
        changed.raw_json["version"] = json!("3.0.0");
        assert!(restore_candidate(&updater, changed, PACKAGE)
            .err()
            .unwrap()
            .contains("signed"));
        let mut corrupted = PACKAGE.to_vec();
        corrupted[3] ^= 1;
        assert!(restore_candidate(&updater, record(), &corrupted).is_err());
    }
    #[test]
    fn completed_version_is_not_reinstalled_and_cancelled_installer_keeps_cache() {
        let cache = TestCache::new();
        let updater = test_updater(false);
        let candidate = restore_candidate(&updater, record(), PACKAGE)
            .unwrap()
            .unwrap();
        cache.0.store(&candidate, PACKAGE).unwrap();
        let (metadata, bytes) = cache.0.read().unwrap().unwrap();
        assert!(restore_candidate(&updater, metadata, &bytes)
            .unwrap()
            .is_some());
        let (metadata, bytes) = cache.0.read().unwrap().unwrap();
        assert!(restore_candidate(&test_updater(true), metadata, &bytes)
            .unwrap()
            .is_none());
        cache.0.clear();
        assert!(cache.0.read().unwrap().is_none());
    }
    #[test]
    fn failed_or_interrupted_download_does_not_replace_ready_package() {
        let cache = TestCache::new();
        let candidate = restore_candidate(&test_updater(false), record(), PACKAGE)
            .unwrap()
            .unwrap();
        cache.0.store(&candidate, PACKAGE).unwrap();
        let pointer = fs::read(cache.0.root.join("ready.json")).unwrap();
        assert!(cache.0.store(&candidate, &[]).is_err());
        let staging = cache.0.root.join(".partial-interrupted");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("package.bin"), b"partial").unwrap();
        assert_eq!(fs::read(cache.0.root.join("ready.json")).unwrap(), pointer);
        assert_eq!(cache.0.read().unwrap().unwrap().1, PACKAGE);
        let pointer: Pointer = serde_json::from_slice(&pointer).unwrap();
        cache.0.cleanup(Some(&pointer.generation));
        assert!(!staging.exists());
    }
    #[test]
    fn cache_pointer_rejects_traversal_and_unicode_without_panicking() {
        let cache = TestCache::new();
        fs::create_dir_all(&cache.0.root).unwrap();
        for generation in [
            "../escape".to_owned(),
            "é".repeat(40),
            format!("{}-", "a".repeat(64)),
        ] {
            fs::write(
                cache.0.root.join("ready.json"),
                serde_json::to_vec(&Pointer { generation }).unwrap(),
            )
            .unwrap();
            assert!(cache.0.read().is_err());
        }
    }
    #[test]
    fn explicit_windows_family_cannot_use_legacy_generic_or_other_family() {
        use tauri::utils::config::BundleType;
        assert_eq!(
            target_for("windows", "x86_64", Some(BundleType::Msi)).unwrap(),
            "windows-x86_64-msi"
        );
        assert_eq!(
            target_for("windows", "x86_64", Some(BundleType::Nsis)).unwrap(),
            TARGET
        );
        assert!(target_for("windows", "x86_64", None).is_err());
        let mut missing = record();
        missing.raw_json["platforms"] = json!({"windows-x86_64": {"url":"https://example.invalid/old.msi","signature":SIGNATURE.trim()}});
        assert!(restore_candidate(&test_updater(false), missing, PACKAGE).is_err());
        assert!(validate_package_kind("windows-x86_64-msi", PACKAGE).is_err());
        assert!(
            validate_package_kind(TARGET, &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
                .is_err()
        );
    }
    #[test]
    fn release_ids_are_stable_across_mirrors_and_metadata_uses_actual_source() {
        let updater = test_updater(false);
        let first = restore_candidate(&updater, record(), PACKAGE)
            .unwrap()
            .unwrap();
        let mut alternate = record();
        alternate.source = Source::Github;
        alternate.raw_json["platforms"][TARGET]["url"] =
            json!("https://alternate.invalid/package.exe");
        let second = restore_candidate(&updater, alternate, PACKAGE)
            .unwrap()
            .unwrap();
        assert_eq!(first.info.id, second.info.id);
        assert_eq!(second.info.source, Source::Github);
    }
    #[test]
    fn updater_urls_are_fixed_https_and_source_enum_rejects_arbitrary_urls() {
        for source in [Source::Gitee, Source::Github] {
            assert!(source.endpoint().starts_with("https://"));
            assert_eq!(source.alternate().alternate(), source);
        }
        assert!(serde_json::from_value::<Source>(json!("https://evil.invalid")).is_err());
        let mut invalid = record();
        invalid.raw_json["platforms"][TARGET]["url"] = json!("http://example.invalid/package.exe");
        assert!(restore_candidate(&test_updater(false), invalid, PACKAGE).is_err());
    }
    #[test]
    fn fallback_reports_actual_source_and_a_successful_no_update_does_not_fall_back() {
        tauri::async_runtime::block_on(async {
            let calls = Mutex::new(Vec::new());
            let (source, value) = source_fallback(Source::Gitee, |source| {
                calls.lock().unwrap().push(source);
                std::future::ready(if source == Source::Gitee {
                    Err("offline".to_owned())
                } else {
                    Ok(7)
                })
            })
            .await
            .unwrap();
            assert_eq!((source, value), (Source::Github, 7));
            assert_eq!(*calls.lock().unwrap(), vec![Source::Gitee, Source::Github]);
            let calls = Mutex::new(Vec::new());
            let (source, value): (_, Option<u8>) = source_fallback(Source::Gitee, |source| {
                calls.lock().unwrap().push(source);
                std::future::ready(Ok(None))
            })
            .await
            .unwrap();
            assert_eq!(source, Source::Gitee);
            assert_eq!(value, None);
            assert_eq!(*calls.lock().unwrap(), vec![Source::Gitee]);
        });
    }
    #[test]
    fn quit_does_not_relaunch_but_explicit_install_does_and_failures_do_not_exit() {
        use std::cell::RefCell;
        for (mode, restart) in [(ExitMode::Quit, false), (ExitMode::InstallRestart, true)] {
            let events = RefCell::new(Vec::new());
            commit_exit(
                mode,
                Some("verified"),
                || {
                    events.borrow_mut().push("pause".to_owned());
                    Ok(())
                },
                |_, actual_restart| {
                    assert_eq!(actual_restart, restart);
                    events
                        .borrow_mut()
                        .push(format!("install:{actual_restart}"));
                    Ok(())
                },
                |actual_restart| {
                    assert_eq!(actual_restart, restart);
                    events.borrow_mut().push(format!("finish:{actual_restart}"));
                },
            )
            .unwrap();
            assert_eq!(
                *events.borrow(),
                vec![
                    "pause".to_owned(),
                    format!("install:{restart}"),
                    format!("finish:{restart}")
                ]
            );
        }
        let events = RefCell::new(Vec::new());
        let error = commit_exit(
            ExitMode::Quit,
            Some("verified"),
            || {
                events.borrow_mut().push("pause");
                Ok(())
            },
            |_, _| {
                events.borrow_mut().push("installer-denied");
                Err("denied".into())
            },
            |_| panic!("An installer failure must leave the process alive"),
        )
        .unwrap_err();
        assert_eq!(error, "denied");
        assert_eq!(*events.borrow(), vec!["pause", "installer-denied"]);
        assert!(commit_exit::<()>(
            ExitMode::InstallRestart,
            None,
            || panic!("Missing cache must fail before plugin shutdown"),
            |_, _| unreachable!(),
            |_| unreachable!(),
        )
        .is_err());
    }
    #[test]
    fn stale_mirror_or_equal_version_signature_cannot_replace_newer_ready_cache() {
        assert!(!advances_staged("0.4.1", Some("0.4.2")));
        assert!(!advances_staged("0.4.2", Some("0.4.2")));
        assert!(!advances_staged("0.4.2+resigned", Some("0.4.2")));
        assert!(advances_staged("0.4.3", Some("0.4.2")));
        assert!(advances_staged("0.4.10", Some("0.4.9")));
        let updater = test_updater(false);
        let staged = restore_candidate(&updater, record(), PACKAGE)
            .unwrap()
            .unwrap();
        let cache = TestCache::new();
        cache.0.store(&staged, PACKAGE).unwrap();
        let mut different_signature = record();
        different_signature.raw_json["platforms"][TARGET]["signature"] =
            json!("different signature for the same version");
        let candidate = Candidate::new(
            updater
                .restore_update(different_signature.raw_json)
                .unwrap()
                .unwrap(),
            Source::Github,
        )
        .unwrap();
        assert_ne!(candidate.info.id, staged.info.id);
        assert!(!advances_staged(
            &candidate.info.version,
            Some(&staged.info.version)
        ));
        assert_eq!(cache.0.read().unwrap().unwrap().1, PACKAGE);
    }
}
