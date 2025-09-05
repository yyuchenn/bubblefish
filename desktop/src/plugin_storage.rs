use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{Manager, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredPluginInfo {
    pub id: String,
    pub filename: String,
    pub upload_time: u64,
}

pub struct PluginStorage {
    storage_dir: PathBuf,
}

impl PluginStorage {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let storage_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?
            .join("plugins");
        
        // Ensure the directory exists
        if !storage_dir.exists() {
            fs::create_dir_all(&storage_dir)
                .map_err(|e| format!("Failed to create plugin storage directory: {}", e))?;
        }
        
        Ok(Self { storage_dir })
    }
    
    pub fn get_storage_dir(&self) -> &Path {
        &self.storage_dir
    }
    
    pub fn save_plugin(&self, file_data: Vec<u8>, filename: String) -> Result<PathBuf, String> {
        // Validate filename has correct extension for the platform
        let expected_ext = get_platform_extension();
        if !filename.ends_with(expected_ext) {
            return Err(format!("Invalid plugin file extension. Expected {}", expected_ext));
        }
        
        let file_path = self.storage_dir.join(&filename);
        
        // Save the file
        fs::write(&file_path, file_data)
            .map_err(|e| format!("Failed to save plugin file: {}", e))?;
        
        // Make the file executable on Unix platforms
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&file_path)
                .map_err(|e| format!("Failed to get file metadata: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&file_path, perms)
                .map_err(|e| format!("Failed to set file permissions: {}", e))?;
        }
        
        // Save metadata
        let info = StoredPluginInfo {
            id: extract_plugin_id(&filename),
            filename: filename.clone(),
            upload_time: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        
        let metadata_path = file_path.with_extension("json");
        let metadata = serde_json::to_string_pretty(&info)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        fs::write(metadata_path, metadata)
            .map_err(|e| format!("Failed to save metadata: {}", e))?;
        
        Ok(file_path)
    }
    
    pub fn delete_plugin(&self, plugin_id: &str) -> Result<(), String> {
        // Find and delete the plugin file
        let entries = fs::read_dir(&self.storage_dir)
            .map_err(|e| format!("Failed to read plugin directory: {}", e))?;
        
        let mut found = false;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.contains(plugin_id) && !name.ends_with(".json") {
                            // Delete the plugin file
                            fs::remove_file(&path)
                                .map_err(|e| format!("Failed to delete plugin file: {}", e))?;
                            
                            // Delete the metadata file
                            let metadata_path = path.with_extension("json");
                            if metadata_path.exists() {
                                fs::remove_file(metadata_path).ok();
                            }
                            
                            found = true;
                            break;
                        }
                    }
                }
            }
        }
        
        if !found {
            return Err(format!("Plugin {} not found", plugin_id));
        }
        
        Ok(())
    }
    
    pub fn list_stored_plugins(&self) -> Vec<StoredPluginInfo> {
        let mut plugins = Vec::new();
        
        if let Ok(entries) = fs::read_dir(&self.storage_dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(info) = serde_json::from_str::<StoredPluginInfo>(&content) {
                                plugins.push(info);
                            }
                        }
                    }
                }
            }
        }
        
        plugins
    }
    
    pub fn get_plugin_path(&self, plugin_id: &str) -> Option<PathBuf> {
        let entries = fs::read_dir(&self.storage_dir).ok()?;
        
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.contains(plugin_id) && !name.ends_with(".json") {
                            return Some(path);
                        }
                    }
                }
            }
        }
        
        None
    }
}

fn get_platform_extension() -> &'static str {
    #[cfg(target_os = "macos")]
    return ".dylib";
    
    #[cfg(target_os = "linux")]
    return ".so";
    
    #[cfg(target_os = "windows")]
    return ".dll";
}

fn extract_plugin_id(filename: &str) -> String {
    let name = filename
        .trim_start_matches("lib")
        .trim_end_matches(".dylib")
        .trim_end_matches(".so")
        .trim_end_matches(".dll");
    
    name.to_string()
}

pub async fn load_stored_plugins_on_startup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let storage = PluginStorage::new(&app_handle)?;
    let plugins = storage.list_stored_plugins();
    
    for plugin_info in plugins {
        if let Some(path) = storage.get_plugin_path(&plugin_info.id) {
            if let Some(path_str) = path.to_str() {
                // Emit event to frontend to load the plugin
                app_handle
                    .emit("plugin:stored-plugin-found", path_str)
                    .map_err(|e| format!("Failed to emit event: {}", e))?;
            }
        }
    }
    
    Ok(())
}