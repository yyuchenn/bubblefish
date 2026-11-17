//! Installed plugin files and supervised native children. No document engine lives here.
use bubblefish_plugin_protocol::{
    validate_manifest, validate_message, validate_package_path, PluginManifest, PluginMessage,
    PluginRuntimeRole, MAX_BINARY_BYTES, MAX_JSON_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock, Weak,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RECORD: &str = ".bubblefish-host.json";
const MAX_PACKAGE_FILES: usize = 10_000;
const MAX_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);

fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}
fn guard<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Plugin host state lock was poisoned".into())
}
fn token() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        || !id.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err("Invalid plugin ID".into());
    }
    Ok(())
}
fn check_path(path: &str) -> Result<(), String> {
    validate_package_path(path).map_err(|e| e.message)?;
    if path
        .split('/')
        .any(|part| part == RECORD || part.starts_with(".bubblefish-host-"))
    {
        return Err("Plugin package uses a reserved host filename".into());
    }
    Ok(())
}
/// Reject symlinks in every existing component before reading or creating files.
fn confined(root: &Path, path: &str, create_parents: bool) -> Result<PathBuf, String> {
    check_path(path)?;
    let mut current = root.to_owned();
    if fs::symlink_metadata(&current)
        .map_err(error)?
        .file_type()
        .is_symlink()
    {
        return Err("Plugin directory cannot be a symbolic link".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Plugin paths cannot contain symbolic links".into());
                }
                if index + 1 < parts.len() && !metadata.is_dir() {
                    return Err("Plugin path parent is not a directory".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if create_parents && index + 1 < parts.len() {
                    fs::create_dir(&current).map_err(error)?;
                }
            }
            Err(e) => return Err(error(e)),
        }
    }
    Ok(current)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub config: Value,
}
struct Staged {
    record: InstalledPlugin,
    files: HashSet<String>,
    size: u64,
}
pub struct PluginStore {
    root: PathBuf,
    staged: Mutex<HashMap<String, Arc<Mutex<Staged>>>>,
    state_writes: Mutex<()>,
}
impl PluginStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("installed")).map_err(error)?;
        fs::create_dir_all(root.join("staging")).map_err(error)?;
        if fs::symlink_metadata(&root)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err("Plugin storage cannot be a symbolic link".into());
        }
        for name in ["installed", "staging"] {
            if fs::symlink_metadata(root.join(name))
                .map_err(error)?
                .file_type()
                .is_symlink()
            {
                return Err("Plugin storage cannot contain symbolic links".into());
            }
        }
        Ok(Self {
            root,
            staged: Mutex::new(HashMap::new()),
            state_writes: Mutex::new(()),
        })
    }
    fn installation(&self, plugin_id: &str) -> Result<PathBuf, String> {
        valid_id(plugin_id)?;
        let root = self.root.join("installed").join(plugin_id);
        let metadata = fs::symlink_metadata(&root).map_err(error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Invalid installed plugin directory".into());
        }
        Ok(root)
    }
    pub fn get(&self, plugin_id: &str) -> Result<InstalledPlugin, String> {
        let root = self.installation(plugin_id)?;
        let metadata = fs::symlink_metadata(root.join(RECORD)).map_err(error)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_JSON_BYTES as u64
        {
            return Err("Invalid installed plugin registration".into());
        }
        let record: InstalledPlugin =
            serde_json::from_slice(&fs::read(root.join(RECORD)).map_err(error)?).map_err(error)?;
        validate_manifest(&record.manifest).map_err(|e| e.message)?;
        if record.manifest.id != plugin_id || !record.config.is_object() {
            return Err("Invalid installed plugin registration".into());
        }
        Ok(record)
    }
    pub fn list(&self) -> Result<Vec<InstalledPlugin>, String> {
        let mut result = Vec::new();
        for entry in fs::read_dir(self.root.join("installed")).map_err(error)? {
            let entry = entry.map_err(error)?;
            if let Some(id) = entry.file_name().to_str() {
                if let Ok(plugin) = self.get(id) {
                    result.push(plugin);
                }
            }
        }
        result.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        Ok(result)
    }
    pub fn begin(&self, manifest: PluginManifest) -> Result<String, String> {
        validate_manifest(&manifest).map_err(|e| e.message)?;
        valid_id(&manifest.id)?;
        if self.root.join("installed").join(&manifest.id).exists() {
            return Err("Plugin is already installed; uninstall it before replacing it".into());
        }
        let token = token();
        fs::create_dir(self.root.join("staging").join(&token)).map_err(error)?;
        let config = Value::Object(
            manifest
                .contributes
                .configuration
                .iter()
                .flatten()
                .filter_map(|field| {
                    field
                        .default
                        .clone()
                        .map(|value| (field.key.clone(), value))
                })
                .collect(),
        );
        guard(&self.staged)?.insert(
            token.clone(),
            Arc::new(Mutex::new(Staged {
                record: InstalledPlugin {
                    manifest,
                    enabled: false,
                    config,
                },
                files: HashSet::new(),
                size: 0,
            })),
        );
        Ok(token)
    }
    fn stage(&self, token: &str) -> Result<Arc<Mutex<Staged>>, String> {
        guard(&self.staged)?
            .get(token)
            .cloned()
            .ok_or_else(|| "Unknown plugin installation token".into())
    }
    pub fn write_file(&self, token: &str, path: &str, bytes: &[u8]) -> Result<(), String> {
        let staged = self.stage(token)?;
        let mut staged = guard(&staged)?;
        if bytes.len() > MAX_BINARY_BYTES
            || staged.files.len() >= MAX_PACKAGE_FILES
            || staged.size + bytes.len() as u64 > MAX_PACKAGE_BYTES
        {
            return Err("Plugin package exceeds installation limits".into());
        }
        if staged.files.contains(path) {
            return Err("Plugin package contains a duplicate path".into());
        }
        let target = confined(&self.root.join("staging").join(token), path, true)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(error)?;
        file.write_all(bytes).map_err(error)?;
        staged.files.insert(path.into());
        staged.size += bytes.len() as u64;
        Ok(())
    }
    pub fn commit(&self, token: &str) -> Result<InstalledPlugin, String> {
        let staged = self.stage(token)?;
        let staged = guard(&staged)?;
        let source = self.root.join("staging").join(token);
        let manifest = &staged.record.manifest;
        let mut required = Vec::new();
        if let Some(web) = &manifest.entrypoints.web {
            required.push(web.as_str());
        }
        if let Some(native) = &manifest.entrypoints.native {
            required.extend(native.values().map(String::as_str));
        }
        if let Some(panels) = &manifest.contributes.panels {
            required.extend(panels.iter().map(|panel| panel.entry.as_str()));
        }
        for path in required {
            if !confined(&source, path, false)?.is_file() {
                return Err(format!("Missing plugin entrypoint: {path}"));
            }
        }
        #[cfg(unix)]
        if let Some(native) = &manifest.entrypoints.native {
            use std::os::unix::fs::PermissionsExt;
            for path in native.values() {
                fs::set_permissions(
                    confined(&source, path, false)?,
                    fs::Permissions::from_mode(0o755),
                )
                .map_err(error)?;
            }
        }
        let record = staged.record.clone();
        let destination = self.root.join("installed").join(&manifest.id);
        if destination.exists() {
            return Err("Plugin is already installed".into());
        }
        fs::write(
            source.join(RECORD),
            serde_json::to_vec(&record).map_err(error)?,
        )
        .map_err(error)?;
        fs::rename(&source, destination).map_err(error)?;
        drop(staged);
        guard(&self.staged)?.remove(token);
        Ok(record)
    }
    pub fn abort(&self, token: &str) -> Result<(), String> {
        let staged = self.stage(token)?;
        let _stage = guard(&staged)?;
        guard(&self.staged)?.remove(token);
        fs::remove_dir_all(self.root.join("staging").join(token)).map_err(error)
    }
    pub fn read_file(&self, plugin_id: &str, path: &str) -> Result<Vec<u8>, String> {
        self.get(plugin_id)?;
        let target = confined(&self.installation(plugin_id)?, path, false)?;
        let metadata = fs::metadata(&target).map_err(error)?;
        if !metadata.is_file() || metadata.len() > MAX_BINARY_BYTES as u64 {
            return Err("Plugin resource exceeds size limit or is not a file".into());
        }
        fs::read(target).map_err(error)
    }
    pub fn panel_html(&self, plugin_id: &str, panel_id: &str) -> Result<Vec<u8>, String> {
        let record = self.get(plugin_id)?;
        let panel = record
            .manifest
            .contributes
            .panels
            .as_ref()
            .and_then(|panels| panels.iter().find(|panel| panel.id == panel_id))
            .ok_or("Plugin panel is not registered")?;
        let target = confined(&self.installation(plugin_id)?, &panel.entry, false)?;
        let metadata = fs::metadata(&target).map_err(error)?;
        if !metadata.is_file() || metadata.len() > MAX_JSON_BYTES as u64 {
            return Err("Plugin panel exceeds size limit or is not a file".into());
        }
        fs::read(target).map_err(error)
    }
    pub fn set_state(
        &self,
        plugin_id: &str,
        enabled: Option<bool>,
        config: Option<Value>,
    ) -> Result<(), String> {
        // Keep enabled/config updates atomic when separate IPC calls overlap.
        let _writing = guard(&self.state_writes)?;
        let mut record = self.get(plugin_id)?;
        if let Some(enabled) = enabled {
            record.enabled = enabled;
        }
        if let Some(config) = config {
            if !config.is_object() {
                return Err("Plugin configuration must be an object".into());
            }
            record.config = config;
        }
        let root = self.installation(plugin_id)?;
        let temporary = root.join(format!(".bubblefish-host-{}.tmp", token()));
        fs::write(&temporary, serde_json::to_vec(&record).map_err(error)?).map_err(error)?;
        if let Err(e) = fs::rename(&temporary, root.join(RECORD)) {
            let _ = fs::remove_file(temporary);
            return Err(error(e));
        }
        Ok(())
    }
    pub fn remove(&self, plugin_id: &str) -> Result<(), String> {
        self.get(plugin_id)?;
        fs::remove_dir_all(self.installation(plugin_id)?).map_err(error)
    }
    fn executable(&self, plugin_id: &str, target: &str) -> Result<(PathBuf, PathBuf), String> {
        let record = self.get(plugin_id)?;
        let entry = record
            .manifest
            .entrypoints
            .native
            .as_ref()
            .and_then(|entries| entries.get(target))
            .ok_or("Plugin has no native entrypoint for this target")?;
        let root = self.installation(plugin_id)?;
        let executable = confined(&root, entry, false)?;
        if !executable.is_file() {
            return Err("Native plugin entrypoint is not a file".into());
        }
        let canonical = executable.canonicalize().map_err(error)?;
        if !canonical.starts_with(root.canonicalize().map_err(error)?) {
            return Err("Native plugin entrypoint escapes its installation".into());
        }
        Ok((canonical, root))
    }
}

/// Validate in place so large image buffers are never converted to JSON arrays.
pub fn validate_wire_frame(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 {
        return Err("Truncated plugin frame".into());
    }
    let json_len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let binary_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if json_len == 0
        || json_len > MAX_JSON_BYTES
        || binary_len > MAX_BINARY_BYTES
        || bytes.len() != 8 + json_len + binary_len
    {
        return Err("Invalid plugin frame size".into());
    }
    let json = &bytes[8..8 + json_len];
    let message: PluginMessage = serde_json::from_slice(json).map_err(error)?;
    validate_message(&message, binary_len).map_err(error)?;
    Ok(())
}
fn read_wire_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0u8; 8];
    match reader.read(&mut header[..1]).map_err(error)? {
        0 => return Ok(None),
        _ => {}
    }
    reader.read_exact(&mut header[1..]).map_err(error)?;
    let json_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
    let binary_len = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if json_len == 0 || json_len > MAX_JSON_BYTES || binary_len > MAX_BINARY_BYTES {
        return Err("Native plugin frame exceeds size limits".into());
    }
    let mut bytes = vec![0; 8 + json_len + binary_len];
    bytes[..8].copy_from_slice(&header);
    reader.read_exact(&mut bytes[8..]).map_err(error)?;
    validate_wire_frame(&bytes)?;
    Ok(Some(bytes))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub plugin_id: String,
    pub generation: String,
    pub runtime_role: PluginRuntimeRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub code: Option<i32>,
}
pub type MessageSink = Arc<dyn Fn(Vec<u8>) -> Result<(), String> + Send + Sync>;
pub type EventSink = Arc<dyn Fn(NativePluginEvent) + Send + Sync>;
struct NativeProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stopping: AtomicBool,
    stdout_done: AtomicBool,
    generation: String,
}
impl NativeProcess {
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
    fn stop_and_wait(&self) -> Result<(), String> {
        self.stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if guard(&self.child)?.try_wait().map_err(error)?.is_some() {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Native plugin did not stop before the timeout".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
enum Instance {
    Starting(String, u64),
    Running(Arc<NativeProcess>),
    Removing,
}
pub struct PluginManager {
    pub store: PluginStore,
    pub resources: crate::local_resources::LocalResourceStore,
    processes: Mutex<HashMap<(String, PluginRuntimeRole), Instance>>,
    closing: AtomicBool,
    epoch: AtomicU64,
    lifecycle: RwLock<()>,
    children: Mutex<Vec<Weak<NativeProcess>>>,
}
impl PluginManager {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let store = PluginStore::new(root.clone())?;
        Ok(Self {
            resources: crate::local_resources::LocalResourceStore::new(root.join("resources"))?,
            store,
            processes: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            lifecycle: RwLock::new(()),
            children: Mutex::new(Vec::new()),
        })
    }
    #[cfg(test)]
    pub fn start(
        self: &Arc<Self>,
        plugin_id: String,
        generation: String,
        target: &str,
        on_message: MessageSink,
        on_event: EventSink,
    ) -> Result<(), String> {
        self.start_role(
            plugin_id,
            generation,
            PluginRuntimeRole::Main,
            target,
            on_message,
            on_event,
        )
    }
    pub fn start_role(
        self: &Arc<Self>,
        plugin_id: String,
        generation: String,
        runtime_role: PluginRuntimeRole,
        target: &str,
        on_message: MessageSink,
        on_event: EventSink,
    ) -> Result<(), String> {
        let _starting = self.lifecycle.read().map_err(error)?;
        if generation.is_empty() || generation.len() > 128 {
            return Err("Invalid native plugin generation".into());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err("Native plugin supervisor is shutting down".into());
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        let key = (plugin_id.clone(), runtime_role);
        {
            let mut processes = guard(&self.processes)?;
            if processes.contains_key(&key) {
                return Err("Plugin already has a native process".into());
            }
            processes.insert(key.clone(), Instance::Starting(generation.clone(), epoch));
        }
        let result = (|| {
            let (executable, root) = self.store.executable(&plugin_id, target)?;
            let mut command = Command::new(executable);
            command
                .current_dir(root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().map_err(error)?;
            let stdin = child
                .stdin
                .take()
                .ok_or("Native plugin stdin unavailable")?;
            let mut stdout = child
                .stdout
                .take()
                .ok_or("Native plugin stdout unavailable")?;
            let mut stderr = child
                .stderr
                .take()
                .ok_or("Native plugin stderr unavailable")?;
            let process = Arc::new(NativeProcess {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                stopping: AtomicBool::new(false),
                stdout_done: AtomicBool::new(false),
                generation: generation.clone(),
            });
            {
                let mut children = guard(&self.children)?;
                children.retain(|child| child.strong_count() > 0);
                children.push(Arc::downgrade(&process));
            }
            {
                let mut processes = guard(&self.processes)?;
                if self.closing.load(Ordering::SeqCst)
                    || self.epoch.load(Ordering::SeqCst) != epoch
                    || !matches!(processes.get(&key), Some(Instance::Starting(value, reserved_epoch)) if value == &generation && *reserved_epoch == epoch)
                {
                    drop(processes);
                    process.stop_and_wait()?;
                    return Err("Native plugin start was cancelled".into());
                }
                processes.insert(key.clone(), Instance::Running(process.clone()));
            }
            let event = {
                let plugin_id = plugin_id.clone();
                let generation = generation.clone();
                let on_event = on_event.clone();
                Arc::new(move |kind, message, code| {
                    on_event(NativePluginEvent {
                        kind,
                        plugin_id: plugin_id.clone(),
                        generation: generation.clone(),
                        runtime_role,
                        message,
                        code,
                    })
                })
            };
            let reader_process = process.clone();
            let reader_event = event.clone();
            thread::spawn(move || {
                loop {
                    match read_wire_frame(&mut stdout) {
                        Ok(Some(bytes)) => {
                            if let Err(e) = on_message(bytes) {
                                reader_event("error", Some(e), None);
                                reader_process.stop();
                                break;
                            }
                        }
                        Ok(None) => {
                            if !reader_process.stopping.load(Ordering::SeqCst) {
                                reader_process.stop();
                            }
                            break;
                        }
                        Err(e) => {
                            if !reader_process.stopping.load(Ordering::SeqCst) {
                                reader_event("error", Some(e), None);
                            }
                            reader_process.stop();
                            break;
                        }
                    }
                }
                reader_process.stdout_done.store(true, Ordering::SeqCst);
            });
            let log_event = event.clone();
            thread::spawn(move || {
                let mut buffer = [0; 4096];
                loop {
                    match stderr.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(length) => log_event(
                            "stderr",
                            Some(String::from_utf8_lossy(&buffer[..length]).into_owned()),
                            None,
                        ),
                    }
                }
            });
            let manager = Arc::downgrade(self);
            let key = key.clone();
            thread::spawn(move || {
                loop {
                    let status = process
                        .child
                        .lock()
                        .map_err(|_| ())
                        .and_then(|mut child| child.try_wait().map_err(|_| ()));
                    match status {
                        Ok(Some(status)) => {
                            let deadline = std::time::Instant::now() + Duration::from_millis(500);
                            while !process.stdout_done.load(Ordering::SeqCst)
                                && std::time::Instant::now() < deadline
                            {
                                thread::sleep(Duration::from_millis(5));
                            }
                            event("exit", Some(status.to_string()), status.code());
                            break;
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(25)),
                        Err(()) => {
                            event(
                                "error",
                                Some("Could not wait for native plugin".into()),
                                None,
                            );
                            process.stop();
                            break;
                        }
                    }
                }
                if let Some(manager) = manager.upgrade() {
                    if let Ok(mut processes) = manager.processes.lock() {
                        if matches!(processes.get(&key), Some(Instance::Running(value)) if Arc::ptr_eq(value, &process))
                        {
                            processes.remove(&key);
                        }
                    }
                }
            });
            Ok(())
        })();
        if result.is_err() {
            let mut processes = guard(&self.processes)?;
            if matches!(processes.get(&key), Some(Instance::Starting(value, reserved_epoch)) if value == &generation && *reserved_epoch == epoch)
            {
                processes.remove(&key);
            }
        }
        result
    }
    #[cfg(test)]
    pub fn send(&self, plugin_id: &str, generation: &str, bytes: &[u8]) -> Result<(), String> {
        self.send_role(plugin_id, generation, PluginRuntimeRole::Main, bytes)
    }
    pub fn send_role(
        &self,
        plugin_id: &str,
        generation: &str,
        runtime_role: PluginRuntimeRole,
        bytes: &[u8],
    ) -> Result<(), String> {
        validate_wire_frame(bytes)?;
        let process = match guard(&self.processes)?.get(&(plugin_id.into(), runtime_role)) {
            Some(Instance::Running(process)) if process.generation == generation => process.clone(),
            _ => return Err("Native plugin generation is no longer active".into()),
        };
        if process.stopping.load(Ordering::SeqCst) {
            return Err("Native plugin is stopping".into());
        }
        let mut stdin = guard(&process.stdin)?;
        stdin
            .write_all(bytes)
            .and_then(|()| stdin.flush())
            .map_err(error)
    }
    #[cfg(test)]
    pub fn stop(&self, plugin_id: &str, generation: &str) -> Result<(), String> {
        self.stop_role(plugin_id, generation, PluginRuntimeRole::Main)
    }
    pub fn stop_role(
        &self,
        plugin_id: &str,
        generation: &str,
        runtime_role: PluginRuntimeRole,
    ) -> Result<(), String> {
        let key = (plugin_id.into(), runtime_role);
        let process = {
            let mut processes = guard(&self.processes)?;
            let matches = match processes.get(&key) {
                Some(Instance::Starting(value, _)) => value == generation,
                Some(Instance::Running(value)) => value.generation == generation,
                Some(Instance::Removing) => false,
                None => false,
            };
            if matches {
                processes.remove(&key)
            } else {
                None
            }
        };
        if let Some(Instance::Running(process)) = process {
            process.stop();
        }
        Ok(())
    }
    pub fn remove(&self, plugin_id: &str) -> Result<(), String> {
        let processes = {
            let mut processes = guard(&self.processes)?;
            let keys = [
                (plugin_id.into(), PluginRuntimeRole::Main),
                (plugin_id.into(), PluginRuntimeRole::Hooks),
            ];
            if keys
                .iter()
                .any(|key| matches!(processes.get(key), Some(Instance::Removing)))
            {
                return Err("Plugin is already being removed".into());
            }
            keys.into_iter()
                .filter_map(|key| processes.insert(key, Instance::Removing))
                .collect::<Vec<_>>()
        };
        let result = (|| {
            for process in &processes {
                if let Instance::Running(process) = process {
                    process.stop();
                }
            }
            for process in &processes {
                if let Instance::Running(process) = process {
                    process.stop_and_wait()?;
                }
            }
            self.resources.remove_plugin(plugin_id)?;
            self.store.remove(plugin_id)
        })();
        guard(&self.processes)?.retain(|(id, _), _| id != plugin_id);
        result
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.reset();
    }
    /// The updater can fail before launching an installer, so this gate is reversible.
    pub fn pause_for_exit(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::SeqCst);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let result = (|| {
            // Wait for in-flight spawn/setup to register its child or kill and reap it.
            let _exclusive = self.lifecycle.write().map_err(error)?;
            self.resources.reset()?;
            guard(&self.processes)?.clear();
            // Include children already retired by reset/stop but not yet reaped.
            let processes: Vec<_> = guard(&self.children)?
                .iter()
                .filter_map(Weak::upgrade)
                .collect();
            for process in &processes {
                process.stop();
            }
            for process in processes {
                process.stop_and_wait()?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.resume_after_exit_failure();
        }
        result
    }
    pub fn resume_after_exit_failure(&self) {
        self.closing.store(false, Ordering::SeqCst);
    }
    /// A fresh renderer owns a fresh runtime; persisted plugin registrations remain.
    pub fn reset(&self) -> Result<(), String> {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.resources.reset()?;
        let processes: Vec<_> = guard(&self.processes)?
            .drain()
            .map(|(_, process)| process)
            .collect();
        for process in processes {
            if let Instance::Running(process) = process {
                process.stop();
            }
        }
        Ok(())
    }
}
impl Drop for PluginManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("bf-native-plugin-test-{}", token())))
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn manifest() -> PluginManifest {
        serde_json::from_value(serde_json::json!({
            "id":"example.echo", "name":"Echo", "version":"0.1.0", "apiVersion":1,
            "entrypoints":{"web":"main.js","native":{"test-target":"bin/echo"}},
            "contributes":{"panels":[{"id":"settings","title":"Settings","entry":"panel.html"}],
                "configuration":[{"key":"language","label":"Language","type":"string","default":"en"}]}
        }))
        .unwrap()
    }
    fn install(store: &PluginStore, executable: &[u8]) -> InstalledPlugin {
        let token = store.begin(manifest()).unwrap();
        store.write_file(&token, "main.js", b"export {}").unwrap();
        store
            .write_file(&token, "panel.html", b"<p>Settings</p>")
            .unwrap();
        store.write_file(&token, "bin/echo", executable).unwrap();
        store.commit(&token).unwrap()
    }
    fn frame(binary: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(&serde_json::json!({
            "kind":"request", "apiVersion":1, "id":"test", "method":"echo", "params":{"test":true},
            "binary":{"byteLength":binary.len(), "mimeType":"application/octet-stream"}
        }))
        .unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(binary.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(binary);
        bytes
    }
    #[test]
    fn installation_persists_registration_and_binary_resources() {
        let dir = TestDirectory::new();
        let store = PluginStore::new(dir.0.clone()).unwrap();
        let record = install(&store, &[0, 255, 1, 128]);
        assert!(!record.enabled);
        assert_eq!(record.config["language"], "en");
        assert_eq!(
            store.read_file("example.echo", "bin/echo").unwrap(),
            [0, 255, 1, 128]
        );
        store
            .set_state(
                "example.echo",
                Some(true),
                Some(serde_json::json!({"language":"ja"})),
            )
            .unwrap();
        let restored = PluginStore::new(dir.0.clone()).unwrap().list().unwrap();
        assert!(restored[0].enabled);
        assert_eq!(restored[0].config["language"], "ja");
        assert!(store.begin(manifest()).is_err());
        store.remove("example.echo").unwrap();
        assert!(store.list().unwrap().is_empty());
    }
    #[test]
    fn installation_rejects_traversal_duplicate_paths_and_missing_entrypoints() {
        let dir = TestDirectory::new();
        let store = PluginStore::new(dir.0.clone()).unwrap();
        let token = store.begin(manifest()).unwrap();
        for path in [
            "../escape",
            "/absolute",
            "a/../../escape",
            "a\\escape",
            "C:escape",
            RECORD,
        ] {
            assert!(store.write_file(&token, path, b"bad").is_err(), "{path}");
        }
        assert!(store.write_file("not-a-token", "main.js", b"bad").is_err());
        store.write_file(&token, "main.js", b"ok").unwrap();
        assert!(store.write_file(&token, "main.js", b"overwrite").is_err());
        assert!(store.commit(&token).is_err());
        store.abort(&token).unwrap();
        assert!(store.commit(&token).is_err());
        assert!(store.list().unwrap().is_empty());
    }
    #[test]
    fn only_declared_panel_and_registered_executable_are_accessible() {
        let dir = TestDirectory::new();
        let store = PluginStore::new(dir.0.clone()).unwrap();
        install(&store, b"binary");
        assert_eq!(
            store.panel_html("example.echo", "settings").unwrap(),
            b"<p>Settings</p>"
        );
        assert!(store.panel_html("example.echo", "main.js").is_err());
        assert!(store.read_file("../example.echo", "main.js").is_err());
        assert!(store.executable("missing", "test-target").is_err());
        assert!(store.executable("example.echo", "other-target").is_err());
        assert!(store
            .executable("example.echo", "test-target")
            .unwrap()
            .0
            .starts_with(dir.0.canonicalize().unwrap()));
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_resources_and_entrypoints_are_rejected() {
        use std::os::unix::fs::symlink;
        let dir = TestDirectory::new();
        let store = PluginStore::new(dir.0.clone()).unwrap();
        install(&store, b"binary");
        let root = store.installation("example.echo").unwrap();
        fs::remove_file(root.join("bin/echo")).unwrap();
        symlink("/bin/sh", root.join("bin/echo")).unwrap();
        assert!(store.executable("example.echo", "test-target").is_err());
        assert!(store.read_file("example.echo", "bin/echo").is_err());
        symlink("/tmp", root.join("outside")).unwrap();
        assert!(store.read_file("example.echo", "outside/file").is_err());
    }
    #[test]
    fn framing_rejects_bad_lengths_versions_and_truncation_before_allocating() {
        let bytes = frame(&[0, 255, 3, 128]);
        validate_wire_frame(&bytes).unwrap();
        assert_eq!(
            read_wire_frame(&mut bytes.as_slice()).unwrap().unwrap(),
            bytes
        );
        assert!(read_wire_frame(&mut [255u8; 8].as_slice()).is_err());
        assert!(validate_wire_frame(&bytes[..bytes.len() - 1]).is_err());
        let mut wrong_length = bytes.clone();
        wrong_length[4..8].copy_from_slice(&2u32.to_le_bytes());
        assert!(validate_wire_frame(&wrong_length).is_err());
        assert!(read_wire_frame(&mut [].as_slice()).unwrap().is_none());
    }
    #[cfg(unix)]
    #[test]
    fn supervisor_transfers_binary_and_invalidates_stopped_generations() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nexec /bin/cat\n");
        let (messages, received) = mpsc::channel();
        let (events, exited) = mpsc::channel();
        manager
            .start(
                "example.echo".into(),
                "one".into(),
                "test-target",
                Arc::new(move |bytes| messages.send(bytes).map_err(error)),
                Arc::new(move |event| {
                    let _ = events.send(event);
                }),
            )
            .unwrap();
        assert!(manager
            .start(
                "example.echo".into(),
                "one".into(),
                "test-target",
                Arc::new(|_| Ok(())),
                Arc::new(|_| {})
            )
            .is_err());
        let bytes = frame(&[0, 255, 1, 128]);
        assert!(manager.send("example.echo", "old", &bytes).is_err());
        manager.send("example.echo", "one", &bytes).unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            bytes
        );
        manager.stop("example.echo", "old").unwrap();
        manager.send("example.echo", "one", &bytes).unwrap();
        manager.shutdown();
        assert!(manager.send("example.echo", "one", &bytes).is_err());
        loop {
            if exited.recv_timeout(Duration::from_secs(5)).unwrap().kind == "exit" {
                break;
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_roles_are_isolated_and_removal_retires_both() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nexec /bin/cat\n");
        let (messages, received) = mpsc::channel();
        let (events, exited) = mpsc::channel();
        for role in [PluginRuntimeRole::Main, PluginRuntimeRole::Hooks] {
            let messages = messages.clone();
            let events = events.clone();
            manager
                .start_role(
                    "example.echo".into(),
                    "session:1".into(),
                    role,
                    "test-target",
                    Arc::new(move |bytes| messages.send((role, bytes)).map_err(error)),
                    Arc::new(move |event| {
                        let _ = events.send(event);
                    }),
                )
                .unwrap();
        }
        let bytes = frame(&[0, 255, 128]);
        manager
            .send_role(
                "example.echo",
                "session:1",
                PluginRuntimeRole::Hooks,
                &bytes,
            )
            .unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            (PluginRuntimeRole::Hooks, bytes.clone())
        );
        manager
            .stop_role("example.echo", "session:1", PluginRuntimeRole::Hooks)
            .unwrap();
        assert!(manager
            .send_role(
                "example.echo",
                "session:1",
                PluginRuntimeRole::Hooks,
                &bytes
            )
            .is_err());
        manager.send("example.echo", "session:1", &bytes).unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            (PluginRuntimeRole::Main, bytes)
        );
        // Generation equality does not let one role stop or read the other's pipe.
        manager.remove("example.echo").unwrap();
        assert!(guard(&manager.processes).unwrap().is_empty());
        assert!(manager.store.get("example.echo").is_err());
        let mut roles = HashSet::new();
        while roles.len() < 2 {
            let event = exited.recv_timeout(Duration::from_secs(5)).unwrap();
            if event.kind == "exit" {
                roles.insert(event.runtime_role);
            }
        }
    }
    #[test]
    fn failed_launch_releases_the_start_reservation() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bubblefish/nonexistent/interpreter\n");
        for generation in ["one", "two"] {
            assert!(manager
                .start(
                    "example.echo".into(),
                    generation.into(),
                    "test-target",
                    Arc::new(|_| Ok(())),
                    Arc::new(|_| {})
                )
                .is_err());
            assert!(guard(&manager.processes).unwrap().is_empty());
        }
        manager.shutdown();
        assert!(manager
            .start(
                "example.echo".into(),
                "three".into(),
                "test-target",
                Arc::new(|_| Ok(())),
                Arc::new(|_| {})
            )
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn update_pause_waits_for_children_and_can_resume_after_installer_failure() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nexec /bin/sleep 30\n");
        let start = |generation: &str| {
            manager.start(
                "example.echo".into(),
                generation.into(),
                "test-target",
                Arc::new(|_| Ok(())),
                Arc::new(|_| {}),
            )
        };
        start("before-update").unwrap();
        let process = {
            let processes = guard(&manager.processes).unwrap();
            match processes
                .get(&("example.echo".into(), PluginRuntimeRole::Main))
                .unwrap()
            {
                Instance::Running(process) => process.clone(),
                _ => panic!("Plugin was not running"),
            }
        };
        manager.pause_for_exit().unwrap();
        assert!(guard(&process.child).unwrap().try_wait().unwrap().is_some());
        assert!(start("while-paused").is_err());
        assert!(manager.store.get("example.echo").is_ok());
        manager.resume_after_exit_failure();
        start("after-failure").unwrap();
        manager.pause_for_exit().unwrap();
        assert!(guard(&manager.processes).unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn update_pause_waits_for_an_in_flight_spawn_and_reaps_retired_children() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        let starting = manager.lifecycle.read().unwrap();
        let pausing = manager.clone();
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            done.send(pausing.pause_for_exit()).unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !manager.closing.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        assert!(finished.try_recv().is_err());
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let process = Arc::new(NativeProcess {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stopping: AtomicBool::new(false),
            stdout_done: AtomicBool::new(false),
            generation: "in-flight".into(),
        });
        // A child can exist outside the active-instance map while spawn/setup or reset is finishing.
        guard(&manager.children)
            .unwrap()
            .push(Arc::downgrade(&process));
        drop(starting);
        finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(guard(&process.child).unwrap().try_wait().unwrap().is_some());
    }
    #[cfg(unix)]
    #[test]
    fn stopping_a_plugin_unblocks_a_full_stdin_pipe() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nexec /bin/sleep 30\n");
        manager
            .start(
                "example.echo".into(),
                "blocked".into(),
                "test-target",
                Arc::new(|_| Ok(())),
                Arc::new(|_| {}),
            )
            .unwrap();
        let sender = manager.clone();
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(sender.send(
                "example.echo",
                "blocked",
                &frame(&vec![1; 2 * 1024 * 1024]),
            ));
        });
        thread::sleep(Duration::from_millis(50));
        manager.stop("example.echo", "blocked").unwrap();
        assert!(finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn renderer_reset_stops_old_processes_and_allows_a_new_session() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nexec /bin/cat\n");
        manager
            .start(
                "example.echo".into(),
                "old:1".into(),
                "test-target",
                Arc::new(|_| Ok(())),
                Arc::new(|_| {}),
            )
            .unwrap();
        manager.reset().unwrap();
        let (messages, received) = mpsc::channel();
        manager
            .start(
                "example.echo".into(),
                "new:1".into(),
                "test-target",
                Arc::new(move |bytes| messages.send(bytes).map_err(error)),
                Arc::new(|_| {}),
            )
            .unwrap();
        let bytes = frame(&[0, 255, 128]);
        assert!(manager.send("example.echo", "old:1", &bytes).is_err());
        manager.stop("example.echo", "old:1").unwrap();
        manager.send("example.echo", "new:1", &bytes).unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            bytes
        );
        manager.shutdown();
    }
    #[cfg(unix)]
    #[test]
    fn invalid_stdout_is_reported_and_the_child_is_reaped() {
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, b"#!/bin/sh\nprintf 'bad data'\n");
        let (events, received) = mpsc::channel();
        manager
            .start(
                "example.echo".into(),
                "bad".into(),
                "test-target",
                Arc::new(|_| panic!("Invalid stdout must never be forwarded")),
                Arc::new(move |event| {
                    let _ = events.send(event);
                }),
            )
            .unwrap();
        let mut error_seen = false;
        loop {
            let event = received.recv_timeout(Duration::from_secs(5)).unwrap();
            if event.kind == "error" {
                error_seen = true;
            }
            if event.kind == "exit" {
                break;
            }
        }
        assert!(error_seen);
    }
    /// Run with BF_PLUGIN_ECHO_BIN pointing at the built Rust SDK echo example.
    #[test]
    #[ignore = "requires the Rust SDK echo executable"]
    fn rust_sdk_handshake_and_binary_roundtrip() {
        let executable = std::env::var("BF_PLUGIN_ECHO_BIN").expect("Set BF_PLUGIN_ECHO_BIN");
        let dir = TestDirectory::new();
        let manager = Arc::new(PluginManager::new(dir.0.clone()).unwrap());
        install(&manager.store, &fs::read(executable).unwrap());
        let (messages, received) = mpsc::channel();
        let (events, exited) = mpsc::channel();
        manager
            .start(
                "example.echo".into(),
                "sdk".into(),
                "test-target",
                Arc::new(move |bytes| messages.send(bytes).map_err(error)),
                Arc::new(move |event| {
                    let _ = events.send(event);
                }),
            )
            .unwrap();
        let handshake_json = serde_json::to_vec(&serde_json::json!({"kind":"request","apiVersion":1,"id":"hello","method":"handshake","params":{"apiVersion":1,"pluginId":"example.echo","hostVersion":env!("CARGO_PKG_VERSION"),"platform":"native","permissions":[]}})).unwrap();
        let mut handshake = Vec::new();
        handshake.extend_from_slice(&(handshake_json.len() as u32).to_le_bytes());
        handshake.extend_from_slice(&0u32.to_le_bytes());
        handshake.extend_from_slice(&handshake_json);
        manager.send("example.echo", "sdk", &handshake).unwrap();
        let reply = received.recv_timeout(Duration::from_secs(5)).unwrap();
        let json_len = u32::from_le_bytes(reply[..4].try_into().unwrap()) as usize;
        let json: Value = serde_json::from_slice(&reply[8..8 + json_len]).unwrap();
        assert_eq!(json["result"]["pluginId"], "example.echo");
        assert_eq!(json["result"]["apiVersion"], 1);
        let binary = [0, 255, 1, 128];
        manager
            .send("example.echo", "sdk", &frame(&binary))
            .unwrap();
        let reply = received.recv_timeout(Duration::from_secs(5)).unwrap();
        let json_len = u32::from_le_bytes(reply[..4].try_into().unwrap()) as usize;
        assert_eq!(&reply[8 + json_len..], &binary);
        manager.shutdown();
        loop {
            if exited.recv_timeout(Duration::from_secs(5)).unwrap().kind == "exit" {
                break;
            }
        }
    }
}
