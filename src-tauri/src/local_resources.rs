//! Locally imported plugin resources. Each published set is an immutable version;
//! an atomically replaced catalog selects it only after all bytes are verified.
use bubblefish_plugin_protocol::{
    validate_package_path, PluginLocalResourceImport, PluginLocalResourceSet,
    MAX_LOCAL_RESOURCE_CHUNK_BYTES, MAX_LOCAL_RESOURCE_FILES, MAX_LOCAL_RESOURCE_SET_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

static NONCE: AtomicU64 = AtomicU64::new(0);
fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn nonce() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        now(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("Invalid local resource ID".into());
    }
    Ok(())
}
fn valid_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 512 {
        return Err("Invalid local resource owner".into());
    }
    Ok(())
}
fn valid_path(path: &str) -> Result<(), String> {
    validate_package_path(path).map_err(|e| e.message)?;
    if path.len() > 1024 || path.chars().any(|c| c.is_control() || "<>\"|*".contains(c)) {
        return Err("Invalid local resource path".into());
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.len() > 255
            || part.ends_with(['.', ' '])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("Local resource path is not portable".into());
        }
    }
    Ok(())
}
fn validate(mut input: PluginLocalResourceImport) -> Result<PluginLocalResourceImport, String> {
    valid_id(&input.id)?;
    valid_path(&input.id)?;
    if input.id.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err("Local resource IDs must use lowercase letters".into());
    }
    if input.files.is_empty() || input.files.len() > MAX_LOCAL_RESOURCE_FILES {
        return Err("Local resource set must have 1 to 100 files".into());
    }
    let mut paths = HashSet::new();
    let mut size = 0_u64;
    for file in &mut input.files {
        valid_path(&file.path)?;
        if !paths.insert(file.path.to_lowercase()) {
            return Err("Duplicate local resource path".into());
        }
        size = size
            .checked_add(file.byte_length)
            .ok_or("Local resource size overflow")?;
        if file.byte_length == 0 {
            return Err("Local resource files must not be empty".into());
        }
        if file.byte_length > MAX_LOCAL_RESOURCE_SET_BYTES || size > MAX_LOCAL_RESOURCE_SET_BYTES {
            return Err("Local resource set exceeds 512 MiB".into());
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid local resource SHA-256".into());
        }
        file.sha256.make_ascii_lowercase();
    }
    for path in &paths {
        if path
            .split('/')
            .scan(String::new(), |prefix, segment| {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                Some(prefix.clone())
            })
            .any(|prefix| prefix != *path && paths.contains(&prefix))
        {
            return Err("Local resource file conflicts with a directory path".into());
        }
    }
    Ok(input)
}
fn ensure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(error)?;
    let info = fs::symlink_metadata(path).map_err(error)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err("Local resource directories cannot be symbolic links".into());
    }
    Ok(())
}
fn confined(root: &Path, path: &str, create: bool) -> Result<PathBuf, String> {
    valid_path(path)?;
    let mut current = root.to_owned();
    let root_meta = fs::symlink_metadata(root).map_err(error)?;
    if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
        return Err("Invalid local resource root".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || (index + 1 < parts.len() && !meta.is_dir()) {
                    return Err(
                        "Local resource path contains a symbolic link or invalid directory".into(),
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if create && index + 1 < parts.len() {
                    fs::create_dir(&current).map_err(error)?;
                }
            }
            Err(e) => return Err(error(e)),
        }
    }
    Ok(current)
}
struct FileProgress {
    received: u64,
    hash: Sha256,
}
struct Import {
    plugin_id: String,
    owner: String,
    input: PluginLocalResourceImport,
    files: HashMap<String, FileProgress>,
}
#[derive(Default)]
struct State {
    imports: HashMap<String, Import>,
    revoked: HashSet<(String, String)>,
}
#[derive(Serialize, Deserialize)]
struct Published {
    info: PluginLocalResourceSet,
    version: String,
}
pub struct LocalResourceStore {
    root: PathBuf,
    state: Mutex<State>,
}
impl LocalResourceStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        ensure_directory(&root)?;
        ensure_directory(&root.join("sets"))?;
        ensure_directory(&root.join("staging"))?;
        // A store is created once per supervisor. Staging from a previous process
        // has no live connection and must never be published on restart.
        for entry in fs::read_dir(root.join("staging")).map_err(error)? {
            let entry = entry.map_err(error)?;
            if entry.file_type().map_err(error)?.is_dir() {
                fs::remove_dir_all(entry.path()).map_err(error)?;
            } else {
                fs::remove_file(entry.path()).map_err(error)?;
            }
        }
        let store = Self {
            root,
            state: Mutex::new(State::default()),
        };
        store.cleanup_unpublished();
        Ok(store)
    }
    fn cleanup_unpublished(&self) {
        let Ok(plugins) = fs::read_dir(self.root.join("sets")) else {
            return;
        };
        for plugin in plugins.flatten() {
            let plugin_id = plugin.file_name().to_string_lossy().into_owned();
            if valid_id(&plugin_id).is_err() || !plugin.file_type().is_ok_and(|kind| kind.is_dir())
            {
                continue;
            }
            let Ok(sets) = fs::read_dir(plugin.path()) else {
                continue;
            };
            for set in sets.flatten() {
                let id = set.file_name().to_string_lossy().into_owned();
                let Ok(root) = self.set_root(&plugin_id, &id, false) else {
                    continue;
                };
                if !root.join("current.json").exists() {
                    let _ = fs::remove_dir_all(root);
                    continue;
                }
                let Ok(published) = self.published(&root, &id) else {
                    continue;
                };
                let Ok(versions_root) = confined(&root, "versions", false) else {
                    continue;
                };
                let Ok(versions) = fs::read_dir(versions_root) else {
                    continue;
                };
                for version in versions.flatten() {
                    if version.file_name() != published.version.as_str() {
                        let _ = fs::remove_dir_all(version.path());
                    }
                }
                if let Ok(files) = fs::read_dir(root) {
                    for file in files.flatten() {
                        let name = file.file_name().to_string_lossy().into_owned();
                        if name.starts_with("current-") && name.ends_with(".tmp") {
                            let _ = fs::remove_file(file.path());
                        }
                    }
                }
            }
        }
    }
    fn state(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.state
            .lock()
            .map_err(|_| "Local resource state lock was poisoned".into())
    }
    fn set_root(&self, plugin_id: &str, id: &str, create: bool) -> Result<PathBuf, String> {
        valid_id(plugin_id)?;
        valid_id(id)?;
        valid_path(id)?;
        if id.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err("Local resource IDs must use lowercase letters".into());
        }
        let root = self.root.join("sets");
        let plugin = confined(&root, plugin_id, false)?;
        if create {
            ensure_directory(&plugin)?;
        }
        let set = confined(&plugin, id, false)?;
        if create {
            ensure_directory(&set)?;
        }
        Ok(set)
    }
    fn cleanup(&self, state: &mut State, token: &str) {
        state.imports.remove(token);
        let _ = fs::remove_dir_all(self.root.join("staging").join(token));
    }
    pub fn begin(
        &self,
        plugin_id: &str,
        owner: &str,
        input: PluginLocalResourceImport,
    ) -> Result<String, String> {
        valid_id(plugin_id)?;
        valid_owner(owner)?;
        let input = validate(input)?;
        let mut state = self.state()?;
        if state.revoked.contains(&(plugin_id.into(), owner.into())) {
            return Err("Local resource connection is closed".into());
        }
        if state.imports.len() >= 16 {
            return Err("Too many local resource imports".into());
        }
        let token = nonce();
        let directory = self.root.join("staging").join(&token);
        let created = (|| {
            ensure_directory(&directory)?;
            ensure_directory(&directory.join("files"))?;
            for file in &input.files {
                fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(confined(&directory.join("files"), &file.path, true)?)
                    .map_err(error)?;
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = created {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        let files = input
            .files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    FileProgress {
                        received: 0,
                        hash: Sha256::new(),
                    },
                )
            })
            .collect();
        state.imports.insert(
            token.clone(),
            Import {
                plugin_id: plugin_id.into(),
                owner: owner.into(),
                input,
                files,
            },
        );
        Ok(token)
    }
    fn owned(state: &State, plugin_id: &str, owner: &str, token: &str) -> bool {
        state
            .imports
            .get(token)
            .is_some_and(|import| import.plugin_id == plugin_id && import.owner == owner)
    }
    pub fn write(
        &self,
        plugin_id: &str,
        owner: &str,
        token: &str,
        path: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        let mut state = self.state()?;
        if !Self::owned(&state, plugin_id, owner, token) {
            return Err("Unknown local resource import or owner".into());
        }
        let result = (|| {
            if bytes.is_empty() || bytes.len() > MAX_LOCAL_RESOURCE_CHUNK_BYTES {
                return Err("Local resource chunks must contain 1 byte to 4 MiB".into());
            }
            let import = state.imports.get_mut(token).unwrap();
            let expected = import
                .input
                .files
                .iter()
                .find(|file| file.path == path)
                .ok_or("File is not declared in the import")?;
            let file = import
                .files
                .get_mut(path)
                .ok_or("Resource path is not declared")?;
            let next = offset
                .checked_add(bytes.len() as u64)
                .ok_or("Local resource offset overflow")?;
            if offset != file.received || next > expected.byte_length {
                return Err("Local resource chunk offset or length is invalid".into());
            }
            let target = confined(
                &self.root.join("staging").join(token).join("files"),
                path,
                false,
            )?;
            let meta = fs::metadata(&target).map_err(error)?;
            if !meta.is_file() || meta.len() != offset {
                return Err("Local resource staging file changed".into());
            }
            fs::OpenOptions::new()
                .append(true)
                .open(target)
                .map_err(error)?
                .write_all(bytes)
                .map_err(error)?;
            file.hash.update(bytes);
            file.received = next;
            Ok(())
        })();
        if result.is_err() {
            self.cleanup(&mut state, token);
        }
        result
    }
    fn published(&self, root: &Path, id: &str) -> Result<Published, String> {
        let path = confined(root, "current.json", false)?;
        let meta = fs::metadata(&path).map_err(error)?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Err("Invalid local resource catalog".into());
        }
        let mut published: Published =
            serde_json::from_slice(&fs::read(path).map_err(error)?).map_err(error)?;
        valid_id(&published.version)?;
        let checked = validate(PluginLocalResourceImport {
            id: published.info.id.clone(),
            files: published.info.files,
        })?;
        if checked.id != id {
            return Err("Local resource catalog ID mismatch".into());
        }
        published.info.files = checked.files;
        Ok(published)
    }
    pub fn commit(
        &self,
        plugin_id: &str,
        owner: &str,
        token: &str,
    ) -> Result<PluginLocalResourceSet, String> {
        let mut state = self.state()?;
        if !Self::owned(&state, plugin_id, owner, token) {
            return Err("Unknown local resource import or owner".into());
        }
        let mut installed: Option<PathBuf> = None;
        let result = (|| {
            let import = state.imports.get(token).unwrap();
            for expected in &import.input.files {
                let file = &import.files[&expected.path];
                if file.received != expected.byte_length {
                    return Err(format!("Local resource is incomplete: {}", expected.path));
                }
                let hash = format!("{:x}", file.hash.clone().finalize());
                if hash != expected.sha256 {
                    return Err(format!(
                        "Local resource SHA-256 mismatch: {}",
                        expected.path
                    ));
                }
            }
            let info = PluginLocalResourceSet {
                id: import.input.id.clone(),
                files: import.input.files.clone(),
                created_at: now(),
            };
            let root = self.set_root(plugin_id, &info.id, true)?;
            ensure_directory(&root.join("versions"))?;
            let destination = confined(&root.join("versions"), token, false)?;
            fs::rename(self.root.join("staging").join(token), &destination).map_err(error)?;
            installed = Some(destination);
            let record = Published {
                info: info.clone(),
                version: token.into(),
            };
            let temporary = confined(&root, &format!("current-{token}.tmp"), false)?;
            fs::write(&temporary, serde_json::to_vec(&record).map_err(error)?).map_err(error)?;
            fs::rename(&temporary, root.join("current.json")).map_err(error)?;
            // Reads take this same lock, so no reader still needs an old file.
            if let Ok(versions) = fs::read_dir(root.join("versions")) {
                for entry in versions.flatten() {
                    if entry.file_name() != token {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
            Ok(info)
        })();
        self.cleanup(&mut state, token);
        if result.is_err() {
            if let Some(path) = installed {
                let _ = fs::remove_dir_all(path);
            }
        }
        result
    }
    pub fn abort(&self, plugin_id: &str, owner: &str, token: &str) -> Result<(), String> {
        let mut state = self.state()?;
        if state.imports.contains_key(token) && !Self::owned(&state, plugin_id, owner, token) {
            return Err("Local resource import belongs to another connection".into());
        }
        if Self::owned(&state, plugin_id, owner, token) {
            self.cleanup(&mut state, token);
        }
        Ok(())
    }
    pub fn release_owner(&self, plugin_id: &str, owner: &str) -> Result<(), String> {
        valid_id(plugin_id)?;
        valid_owner(owner)?;
        let mut state = self.state()?;
        state.revoked.insert((plugin_id.into(), owner.into()));
        let tokens: Vec<_> = state
            .imports
            .iter()
            .filter(|(_, import)| import.plugin_id == plugin_id && import.owner == owner)
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            self.cleanup(&mut state, &token);
        }
        Ok(())
    }
    pub fn reset(&self) -> Result<(), String> {
        let mut state = self.state()?;
        let tokens: Vec<_> = state.imports.keys().cloned().collect();
        for token in tokens {
            if let Some(import) = state.imports.get(&token) {
                let owner = (import.plugin_id.clone(), import.owner.clone());
                state.revoked.insert(owner);
            }
            self.cleanup(&mut state, &token);
        }
        Ok(())
    }
    pub fn list(&self, plugin_id: &str) -> Result<Vec<PluginLocalResourceSet>, String> {
        valid_id(plugin_id)?;
        let _state = self.state()?;
        let plugin = confined(&self.root.join("sets"), plugin_id, false)?;
        if !plugin.exists() {
            return Ok(vec![]);
        }
        let mut sets = vec![];
        for entry in fs::read_dir(plugin).map_err(error)? {
            let entry = entry.map_err(error)?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let root = self.set_root(plugin_id, &id, false)?;
            if !root.join("current.json").exists() {
                continue;
            }
            sets.push(self.published(&root, &id)?.info);
        }
        sets.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(sets)
    }
    pub fn read(&self, plugin_id: &str, id: &str, path: &str) -> Result<Vec<u8>, String> {
        valid_path(path)?;
        let _state = self.state()?;
        let root = self.set_root(plugin_id, id, false)?;
        let published = self.published(&root, id)?;
        let file = published
            .info
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or("File is not in the local resource set")?;
        let target = confined(
            &root,
            &format!("versions/{}/files/{path}", published.version),
            false,
        )?;
        let meta = fs::metadata(&target).map_err(error)?;
        if !meta.is_file() || meta.len() != file.byte_length {
            return Err("Local resource file size differs from its catalog".into());
        }
        fs::read(target).map_err(error)
    }
    pub fn remove(&self, plugin_id: &str, id: &str) -> Result<(), String> {
        valid_id(plugin_id)?;
        valid_id(id)?;
        let mut state = self.state()?;
        let tokens: Vec<_> = state
            .imports
            .iter()
            .filter(|(_, import)| import.plugin_id == plugin_id && import.input.id == id)
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            self.cleanup(&mut state, &token);
        }
        let plugin = self.root.join("sets").join(plugin_id);
        if !plugin.exists() {
            return Ok(());
        }
        let root = self.set_root(plugin_id, id, false)?;
        if root.exists() {
            fs::remove_dir_all(root).map_err(error)?;
        }
        Ok(())
    }
    pub fn remove_plugin(&self, plugin_id: &str) -> Result<(), String> {
        valid_id(plugin_id)?;
        let mut state = self.state()?;
        let tokens: Vec<_> = state
            .imports
            .iter()
            .filter(|(_, import)| import.plugin_id == plugin_id)
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            self.cleanup(&mut state, &token);
        }
        let root = confined(&self.root.join("sets"), plugin_id, false)?;
        if root.exists() {
            fs::remove_dir_all(root).map_err(error)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bubblefish_plugin_protocol::PluginLocalResourceFile;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("bf-local-resource-test-{}", nonce())))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn descriptor(bytes: &[u8]) -> PluginLocalResourceImport {
        PluginLocalResourceImport {
            id: "model-v1".into(),
            files: vec![PluginLocalResourceFile {
                path: "models/encoder.onnx".into(),
                byte_length: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            }],
        }
    }
    fn import(
        store: &LocalResourceStore,
        plugin: &str,
        owner: &str,
        bytes: &[u8],
    ) -> PluginLocalResourceSet {
        let token = store.begin(plugin, owner, descriptor(bytes)).unwrap();
        for (index, bytes) in bytes.chunks(MAX_LOCAL_RESOURCE_CHUNK_BYTES).enumerate() {
            store
                .write(
                    plugin,
                    owner,
                    &token,
                    "models/encoder.onnx",
                    (index * MAX_LOCAL_RESOURCE_CHUNK_BYTES) as u64,
                    bytes,
                )
                .unwrap();
        }
        store.commit(plugin, owner, &token).unwrap()
    }
    #[test]
    fn multichunk_import_publishes_once_and_survives_restart() {
        let directory = Directory::new();
        let bytes = vec![137; MAX_LOCAL_RESOURCE_CHUNK_BYTES + 19];
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let token = store
            .begin("plugin", "instance", descriptor(&bytes))
            .unwrap();
        store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                &bytes[..MAX_LOCAL_RESOURCE_CHUNK_BYTES],
            )
            .unwrap();
        assert!(store.list("plugin").unwrap().is_empty());
        store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                MAX_LOCAL_RESOURCE_CHUNK_BYTES as u64,
                &bytes[MAX_LOCAL_RESOURCE_CHUNK_BYTES..],
            )
            .unwrap();
        let published = store.commit("plugin", "instance", &token).unwrap();
        assert_eq!(published.files[0].byte_length, bytes.len() as u64);
        assert!(published.created_at > 0);
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            bytes
        );
        drop(store);
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        assert_eq!(store.list("plugin").unwrap(), [published]);
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            bytes
        );
    }
    #[test]
    fn failed_hash_or_incomplete_replacement_preserves_previous_version() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let previous = import(&store, "plugin", "instance", b"old");
        let token = store
            .begin("plugin", "instance", descriptor(b"new"))
            .unwrap();
        store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                b"bad",
            )
            .unwrap();
        assert!(store
            .commit("plugin", "instance", &token)
            .unwrap_err()
            .contains("SHA-256"));
        assert!(!directory.0.join("staging").join(&token).exists());
        let token = store
            .begin("plugin", "instance", descriptor(b"new"))
            .unwrap();
        assert!(store
            .commit("plugin", "instance", &token)
            .unwrap_err()
            .contains("incomplete"));
        assert_eq!(store.list("plugin").unwrap(), [previous]);
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"old"
        );
        import(&store, "plugin", "instance", b"new");
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"new"
        );
        assert_eq!(
            fs::read_dir(directory.0.join("sets/plugin/model-v1/versions"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn catalog_write_failure_rolls_back_the_unpublished_version() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let old = import(&store, "plugin", "instance", b"ready");
        let token = store
            .begin("plugin", "instance", descriptor(b"new"))
            .unwrap();
        store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                b"new",
            )
            .unwrap();
        // A failed catalog write (e.g. disk quota or IO failure) must not replace
        // the already valid catalog after moving the new files into versions.
        fs::create_dir(
            directory
                .0
                .join(format!("sets/plugin/model-v1/current-{token}.tmp")),
        )
        .unwrap();
        assert!(store.commit("plugin", "instance", &token).is_err());
        assert_eq!(store.list("plugin").unwrap(), [old]);
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"ready"
        );
        assert_eq!(
            fs::read_dir(directory.0.join("sets/plugin/model-v1/versions"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn owner_and_plugin_isolation_cannot_abort_or_write_another_import() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let token = store
            .begin("plugin", "instance", descriptor(b"own"))
            .unwrap();
        assert!(store
            .write(
                "other",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                b"bad"
            )
            .is_err());
        assert!(store.abort("plugin", "another", &token).is_err());
        store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                b"own",
            )
            .unwrap();
        store.commit("plugin", "instance", &token).unwrap();
        assert!(store.list("other").unwrap().is_empty());
        assert!(store
            .read("other", "model-v1", "models/encoder.onnx")
            .is_err());
    }
    #[test]
    fn invalid_chunks_abort_only_the_owning_upload_and_revocation_is_terminal() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let token = store
            .begin("plugin", "instance", descriptor(b"data"))
            .unwrap();
        assert!(store
            .write("plugin", "instance", &token, "models/encoder.onnx", 1, b"d")
            .is_err());
        assert!(!directory.0.join("staging").join(&token).exists());
        let token = store
            .begin("plugin", "instance", descriptor(b"data"))
            .unwrap();
        assert!(store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                &vec![0; MAX_LOCAL_RESOURCE_CHUNK_BYTES + 1]
            )
            .is_err());
        let token = store
            .begin("plugin", "instance", descriptor(b"data"))
            .unwrap();
        store.release_owner("plugin", "instance").unwrap();
        assert!(store
            .write(
                "plugin",
                "instance",
                &token,
                "models/encoder.onnx",
                0,
                b"data"
            )
            .is_err());
        assert!(store
            .begin("plugin", "instance", descriptor(b"data"))
            .is_err());
        assert!(!directory.0.join("staging").join(&token).exists());
    }
    #[test]
    fn reset_and_startup_remove_temporary_bytes_without_removing_ready_models() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        import(&store, "plugin", "instance", b"ready");
        let token = store
            .begin("plugin", "instance", descriptor(b"new"))
            .unwrap();
        store
            .write("plugin", "instance", &token, "models/encoder.onnx", 0, b"n")
            .unwrap();
        store.reset().unwrap();
        assert!(!directory.0.join("staging").join(&token).exists());
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"ready"
        );
        let token = store
            .begin("plugin", "next-instance", descriptor(b"new"))
            .unwrap();
        let orphan = directory.0.join("sets/plugin/model-v1/versions/orphan");
        fs::create_dir(&orphan).unwrap();
        drop(store);
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        assert!(!directory.0.join("staging").join(token).exists());
        assert!(!orphan.exists());
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"ready"
        );
    }
    #[test]
    fn removal_cleans_matching_staging_and_keeps_other_plugins_separate() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        import(&store, "plugin", "instance", b"ready");
        import(&store, "other", "other-instance", b"other");
        let token = store
            .begin("plugin", "instance", descriptor(b"new"))
            .unwrap();
        store.remove("plugin", "model-v1").unwrap();
        assert!(store.list("plugin").unwrap().is_empty());
        assert!(store.commit("plugin", "instance", &token).is_err());
        import(&store, "plugin", "instance", b"again");
        store.remove_plugin("plugin").unwrap();
        assert!(store.list("plugin").unwrap().is_empty());
        assert_eq!(
            store
                .read("other", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"other"
        );
    }
    #[test]
    fn manifest_limits_and_portable_paths_are_checked_before_writing() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        for path in [
            "../escape",
            "/absolute",
            "bad\\path",
            "CON",
            "file.",
            "file ",
            "a:b",
        ] {
            let mut input = descriptor(b"data");
            input.files[0].path = path.into();
            assert!(store.begin("plugin", "instance", input).is_err(), "{path}");
        }
        let mut input = descriptor(b"data");
        input.files[0].byte_length = MAX_LOCAL_RESOURCE_SET_BYTES + 1;
        assert!(store.begin("plugin", "instance", input).is_err());
        let mut input = descriptor(b"data");
        let mut duplicate = input.files[0].clone();
        duplicate.path.make_ascii_uppercase();
        input.files.push(duplicate);
        assert!(store.begin("plugin", "instance", input).is_err());
        assert_eq!(
            fs::read_dir(directory.0.join("staging")).unwrap().count(),
            0
        );
        for id in ["Model", "con", "nul.txt", "model."] {
            let mut input = descriptor(b"data");
            input.id = id.into();
            assert!(store.begin("plugin", "instance", input).is_err(), "{id}");
        }
    }
    #[test]
    fn empty_files_are_rejected_without_changing_a_ready_model() {
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        let old = import(&store, "plugin", "instance", b"ready");
        assert!(store
            .begin("plugin", "instance", descriptor(b""))
            .unwrap_err()
            .contains("empty"));
        assert_eq!(store.list("plugin").unwrap(), [old]);
        assert_eq!(
            store
                .read("plugin", "model-v1", "models/encoder.onnx")
                .unwrap(),
            b"ready"
        );
        assert_eq!(
            fs::read_dir(directory.0.join("staging")).unwrap().count(),
            0
        );
    }
    #[cfg(unix)]
    #[test]
    fn resource_reads_reject_symlinks_instead_of_exposing_host_files() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let store = LocalResourceStore::new(directory.0.clone()).unwrap();
        import(&store, "plugin", "instance", b"ready");
        let current = store
            .published(&directory.0.join("sets/plugin/model-v1"), "model-v1")
            .unwrap();
        let target = directory.0.join(format!(
            "sets/plugin/model-v1/versions/{}/files/models/encoder.onnx",
            current.version
        ));
        fs::remove_file(&target).unwrap();
        let external = directory.0.join("private.txt");
        fs::write(&external, b"ready").unwrap();
        symlink(&external, &target).unwrap();
        assert!(store
            .read("plugin", "model-v1", "models/encoder.onnx")
            .unwrap_err()
            .contains("symbolic"));
    }
}
