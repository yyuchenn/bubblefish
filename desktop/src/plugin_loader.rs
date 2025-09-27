use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use libloading::{Library, Symbol};
use serde_json::Value;
use tauri::Manager;

/// Callbacks provided to plugins
#[repr(C)]
pub struct HostCallbacks {
    pub call_service: extern "C" fn(
        plugin_id: *const c_char,
        service: *const c_char,
        method: *const c_char,
        params: *const c_char,
    ) -> *mut c_char,
    pub read_image_file: extern "C" fn(
        file_path: *const c_char,
        data_ptr: *mut *mut u8,
        data_len: *mut usize,
    ) -> i32,
    pub free_host_memory: extern "C" fn(ptr: *mut c_void),
    pub log_message: extern "C" fn(level: i32, message: *const c_char),
}

/// Loaded plugin instance
struct LoadedPlugin {
    library: Library,
    metadata: PluginMetadata,
    enabled: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub subscribed_events: Vec<String>,
}

/// Plugin loader manages all native plugins
pub struct PluginLoader {
    plugins: Arc<Mutex<HashMap<String, LoadedPlugin>>>,
    _app_handle: tauri::AppHandle,
}

impl PluginLoader {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            plugins: Arc::new(Mutex::new(HashMap::new())),
            _app_handle: app_handle,
        }
    }
    
    /// Resolve plugin path from Tauri resources
    fn resolve_resource_path(&self, file_name: &str) -> Option<PathBuf> {
        // Try to get the resource directory from Tauri
        self._app_handle
            .path()
            .resource_dir()
            .ok()
            .and_then(|resource_dir| {
                // Look for plugin in resources/plugins directory
                let plugin_path = resource_dir.join("resources").join("plugins").join(file_name);
                if plugin_path.exists() {
                    Some(plugin_path)
                } else {
                    // Also try without the resources prefix (some platforms)
                    let plugin_path = resource_dir.join("plugins").join(file_name);
                    if plugin_path.exists() {
                        Some(plugin_path)
                    } else {
                        None
                    }
                }
            })
    }

    /// Load a native plugin from dynamic library
    pub fn load_plugin(&self, plugin_path: &str) -> Result<PluginMetadata, String> {
        // If it's an absolute path, load directly
        if plugin_path.starts_with('/') || plugin_path.starts_with("\\") || plugin_path.contains(':') {
            let path = PathBuf::from(plugin_path);
            if path.exists() {
                return self.load_plugin_from_path(&path);
            }
        }
        
        // First check if we should load from bundled resources
        // This happens when plugin_path is just a filename or plugins/filename
        if !plugin_path.contains('/') || plugin_path.starts_with("plugins/") {
            // Extract just the filename
            let file_name = if plugin_path.starts_with("plugins/") {
                &plugin_path[8..] // Skip "plugins/"
            } else {
                plugin_path
            };
            
            // Try to load from app data directory first (for uploaded plugins)
            if let Ok(data_dir) = self._app_handle.path().app_data_dir() {
                let uploaded_path = data_dir.join("plugins").join(file_name);
                if uploaded_path.exists() {
                    return self.load_plugin_from_path(&uploaded_path);
                }
            }
            
            // Try to load from Tauri resources directory (for bundled plugins)
            if let Some(resource_path) = self.resolve_resource_path(file_name) {
                if resource_path.exists() {
                    return self.load_plugin_from_path(&resource_path);
                }
            }
            
            // If not found in resources, try target/release directory (for development)
            let target_path = std::env::current_dir()
                .ok()
                .and_then(|cwd| {
                    let base = if cwd.ends_with("desktop") {
                        cwd.parent()?.to_path_buf()
                    } else {
                        cwd
                    };
                    Some(base.join("target").join("release").join(file_name))
                });
            
            if let Some(target_path) = target_path {
                if target_path.exists() {
                    return self.load_plugin_from_path(&target_path);
                }
            }
        }
        
        // First, try to resolve the path directly
        let initial_path = PathBuf::from(plugin_path);
        
        // If it's a relative path starting with ../
        let resolved_path = if plugin_path.starts_with("../") {
            // Get the current working directory
            let cwd = std::env::current_dir()
                .map_err(|e| format!("Failed to get current directory: {}", e))?;
            
            // Check if we're running from the desktop directory
            let base_dir = if cwd.ends_with("desktop") {
                // We're in desktop/, go up one level to project root
                cwd.parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or(cwd.clone())
            } else {
                // We're likely at project root already
                cwd
            };
            
            // Join the relative path (strip the ../)
            base_dir.join(plugin_path.trim_start_matches("../"))
        } else if !initial_path.is_absolute() {
            // For other relative paths, resolve from current directory
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(plugin_path)
        } else {
            // It's already an absolute path
            initial_path
        };
        
        // Check if the resolved path exists
        if !resolved_path.exists() {
            // Try some alternative locations
            let file_name = Path::new(plugin_path)
                .file_name()
                .ok_or_else(|| format!("Invalid plugin path: {}", plugin_path))?;
            
            let alternatives = vec![
                // Try in workspace root target/release
                std::env::current_dir()
                    .ok()
                    .map(|d| {
                        if d.ends_with("desktop") {
                            d.parent().unwrap().join("target/release").join(file_name)
                        } else {
                            d.join("target/release").join(file_name)
                        }
                    }),
                // Try in workspace root target/debug
                std::env::current_dir()
                    .ok()
                    .map(|d| {
                        if d.ends_with("desktop") {
                            d.parent().unwrap().join("target/debug").join(file_name)
                        } else {
                            d.join("target/debug").join(file_name)
                        }
                    }),
            ];
            
            for alt_path in alternatives.into_iter().flatten() {
                if alt_path.exists() {
                    return self.load_plugin_from_path(&alt_path);
                }
            }
            
            return Err(format!(
                "Plugin file not found: {} (resolved to: {})", 
                plugin_path, 
                resolved_path.display()
            ));
        }
        
        self.load_plugin_from_path(&resolved_path)
    }
    
    fn load_plugin_from_path(&self, path: &Path) -> Result<PluginMetadata, String> {

        unsafe {
            // Load the dynamic library
            let library = Library::new(path)
                .map_err(|e| format!("Failed to load plugin library: {}", e))?;

            // Set host callbacks
            let set_callbacks: Symbol<extern "C" fn(HostCallbacks)> = library
                .get(b"plugin_set_host_callbacks")
                .map_err(|e| format!("Failed to find plugin_set_host_callbacks: {}", e))?;

            let callbacks = HostCallbacks {
                call_service: host_call_service,
                read_image_file: host_read_image_file,
                free_host_memory: host_free_host_memory,
                log_message: host_log_message,
            };

            set_callbacks(callbacks);

            // Initialize plugin
            let init: Symbol<extern "C" fn(*const c_char) -> i32> = library
                .get(b"plugin_init")
                .map_err(|e| format!("Failed to find plugin_init: {}", e))?;

            // Generate plugin ID from filename
            // Remove lib prefix and _plugin suffix to get the actual plugin name
            let file_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown");
            
            // Extract plugin ID from filename
            // e.g. "libdummy_ocr_plugin.dylib" -> "dummy-ocr-plugin"
            let plugin_id = file_stem
                .strip_prefix("lib")
                .unwrap_or(file_stem)
                .replace('_', "-");

            let plugin_id_c = CString::new(plugin_id.clone())
                .map_err(|e| format!("Invalid plugin ID: {}", e))?;

            let result = init(plugin_id_c.as_ptr());
            if result != 0 {
                return Err(format!("Plugin initialization failed with code: {}", result));
            }

            // Get metadata
            let get_metadata: Symbol<extern "C" fn() -> *mut c_char> = library
                .get(b"plugin_get_metadata")
                .map_err(|e| format!("Failed to find plugin_get_metadata: {}", e))?;

            let metadata_ptr = get_metadata();
            if metadata_ptr.is_null() {
                return Err("Failed to get plugin metadata".to_string());
            }

            let metadata_str = CStr::from_ptr(metadata_ptr).to_string_lossy();
            let metadata: PluginMetadata = serde_json::from_str(&metadata_str)
                .map_err(|e| format!("Failed to parse plugin metadata: {}", e))?;

            // Free the metadata string
            let free_string: Symbol<extern "C" fn(*mut c_char)> = library
                .get(b"plugin_free_string")
                .map_err(|_| "Failed to find plugin_free_string".to_string())?;

            free_string(metadata_ptr);

            // Activate the plugin after initialization
            let activate: Symbol<extern "C" fn() -> i32> = library
                .get(b"plugin_activate")
                .map_err(|e| format!("Failed to find plugin_activate: {}", e))?;
            
            let activate_result = activate();
            if activate_result != 0 {
                // Plugin activation failed, but continue anyway
            }

            // Store the loaded plugin with the metadata's ID (not the generated one)
            let mut plugins = self.plugins.lock().unwrap();
            let stored_id = metadata.id.clone(); // Use the ID from metadata
            
            // Check if there's already a plugin with this ID
            if let Some(existing_plugin) = plugins.get(&stored_id) {
                // If there's an existing plugin, we need to deactivate it first
                if let Ok(deactivate) = existing_plugin.library.get::<Symbol<extern "C" fn() -> i32>>(b"plugin_deactivate") {
                    let _ = deactivate();
                }
                if let Ok(cleanup) = existing_plugin.library.get::<Symbol<extern "C" fn()>>(b"plugin_cleanup") {
                    cleanup();
                }
                log::info!("Replaced existing plugin with ID: {}", stored_id);
            }
            
            plugins.insert(
                stored_id,
                LoadedPlugin {
                    library,
                    metadata: metadata.clone(),
                    enabled: true,
                },
            );

            Ok(metadata)
        }
    }

    /// Unload a plugin
    pub fn unload_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self.plugins.lock().unwrap();
        
        if let Some(plugin) = plugins.get(plugin_id) {
            unsafe {
                // Call destroy before unloading
                if let Ok(destroy) = plugin.library.get::<Symbol<extern "C" fn()>>(b"plugin_destroy") {
                    destroy();
                }
            }
        }

        plugins.remove(plugin_id);
        Ok(())
    }

    /// Dispatch event to plugin
    pub fn dispatch_event(&self, plugin_id: &str, event: &Value) -> Result<(), String> {
        let plugins = self.plugins.lock().unwrap();
        
        if let Some(plugin) = plugins.get(plugin_id) {
            if !plugin.enabled {
                return Ok(());
            }

            unsafe {
                let on_event: Symbol<extern "C" fn(*const c_char) -> i32> = plugin.library
                    .get(b"plugin_on_event")
                    .map_err(|e| format!("Failed to find plugin_on_event: {}", e))?;

                let event_json = serde_json::to_string(event)
                    .map_err(|e| format!("Failed to serialize event: {}", e))?;
                
                let event_c = CString::new(event_json)
                    .map_err(|e| format!("Invalid event JSON: {}", e))?;

                let result = on_event(event_c.as_ptr());
                if result != 0 {
                    return Err(format!("Event handling failed with code: {}", result));
                }
            }
        }

        Ok(())
    }

    /// Send message to plugin
    pub fn send_message(&self, to: &str, from: &str, message: &Value) -> Result<(), String> {
        let plugins = self.plugins.lock().unwrap();

        if let Some(plugin) = plugins.get(to) {
            if !plugin.enabled {
                return Ok(());
            }

            unsafe {
                let on_message: Symbol<extern "C" fn(*const c_char, *const c_char) -> i32> = 
                    plugin.library
                        .get(b"plugin_on_message")
                        .map_err(|e| format!("Failed to find plugin_on_message: {}", e))?;

                let from_c = CString::new(from)
                    .map_err(|e| format!("Invalid from string: {}", e))?;
                let message_json = serde_json::to_string(message)
                    .map_err(|e| format!("Failed to serialize message: {}", e))?;
                let message_c = CString::new(message_json)
                    .map_err(|e| format!("Invalid message JSON: {}", e))?;

                let result = on_message(from_c.as_ptr(), message_c.as_ptr());
                if result != 0 {
                    return Err(format!("Message handling failed with code: {}", result));
                }
            }
        }

        Ok(())
    }

    /// Enable/disable plugin
    pub fn set_plugin_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), String> {
        let mut plugins = self.plugins.lock().unwrap();
        
        if let Some(plugin) = plugins.get_mut(plugin_id) {
            if enabled && !plugin.enabled {
                // Activate plugin
                unsafe {
                    if let Ok(activate) = plugin.library.get::<Symbol<extern "C" fn() -> i32>>(b"plugin_activate") {
                        let result = activate();
                        if result != 0 {
                            return Err(format!("Plugin activation failed with code: {}", result));
                        }
                    }
                }
            } else if !enabled && plugin.enabled {
                // Deactivate plugin
                unsafe {
                    if let Ok(deactivate) = plugin.library.get::<Symbol<extern "C" fn() -> i32>>(b"plugin_deactivate") {
                        let result = deactivate();
                        if result != 0 {
                            return Err(format!("Plugin deactivation failed with code: {}", result));
                        }
                    }
                }
            }
            
            plugin.enabled = enabled;
        }

        Ok(())
    }

    /// Get list of loaded plugins
    pub fn list_plugins(&self) -> Vec<PluginMetadata> {
        let plugins = self.plugins.lock().unwrap();
        plugins.values().map(|p| p.metadata.clone()).collect()
    }

    /// Call service from plugin
    pub fn call_plugin_service(
        &self,
        _plugin_id: &str,
        service: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value, String> {
        // This would call into the Core module's service system
        // For now, we'll implement a basic version
        match service {
            "markers" => self.handle_marker_service(method, params),
            "images" => self.handle_image_service(method, params),
            "project" => self.handle_project_service(method, params),
            "files" => self.handle_file_service(method, params),
            "bunny" => self.handle_bunny_service(method, params),
            "events" => self.handle_events_service(method, params),
            _ => Err(format!("Unknown service: {}", service)),
        }
    }

    fn handle_marker_service(&self, method: &str, params: &Value) -> Result<Value, String> {
        // Forward to Core module through Tauri commands
        use bubblefish_core::api::{marker, project, image};
        use bubblefish_core::common::dto::marker::MarkerGeometryDTO;
        
        match method {
            "get_all_markers" => {
                let project_id = params["project_id"].as_str()
                    .ok_or("Missing project_id")?
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?;
                
                // Get all markers for the project
                let mut all_markers = Vec::new();
                if let Some(project) = project::get_project_info(project_id) {
                    for image_id in project.image_ids {
                        if let Some(image) = image::get_image_info(image_id.into()) {
                            for marker_id in image.marker_ids {
                                if let Some(marker) = marker::get_marker_info(marker_id.into()) {
                                    // Convert to plugin SDK's expected format
                                    // Extract x, y from geometry enum
                                    let (x, y) = match &marker.geometry {
                                        MarkerGeometryDTO::Point { x, y } => (*x, *y),
                                        MarkerGeometryDTO::Rectangle { x, y, .. } => (*x, *y),
                                    };
                                    
                                    let marker_json = serde_json::json!({
                                        "id": marker_id.to_string(),
                                        "image_id": image_id.to_string(),
                                        "text": "", // MarkerDTO doesn't have text field
                                        "translation": marker.translation,
                                        "marker_type": "text", // Default type
                                        "x": x,
                                        "y": y,
                                    });
                                    all_markers.push(marker_json);
                                }
                            }
                        }
                    }
                }
                Ok(serde_json::Value::Array(all_markers))
            }
            "get_marker" => {
                let marker_id = params["marker_id"].as_str()
                    .ok_or("Missing marker_id")?
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?;
                
                let marker = marker::get_marker_info(marker_id)
                    .ok_or("Marker not found")?;
                
                // Convert to plugin SDK's expected format
                // Import the enum type
                use bubblefish_core::common::dto::marker::MarkerGeometryDTO;
                
                // Extract x, y from geometry enum
                let (x, y) = match &marker.geometry {
                    MarkerGeometryDTO::Point { x, y } => (*x, *y),
                    MarkerGeometryDTO::Rectangle { x, y, .. } => (*x, *y),
                };
                
                let marker_json = serde_json::json!({
                    "id": marker_id.to_string(),
                    "image_id": marker.image_id.to_string(),
                    "text": "", // MarkerDTO doesn't have text field
                    "translation": marker.translation,
                    "marker_type": "text", // Default type
                    "x": x,
                    "y": y,
                });
                
                Ok(marker_json)
            }
            _ => Err(format!("Unknown marker method: {}", method)),
        }
    }

    fn handle_image_service(&self, method: &str, params: &Value) -> Result<Value, String> {
        use bubblefish_core::api::image;
        
        match method {
            "get_image_data" => {
                let image_id = params["image_id"].as_str()
                    .ok_or("Missing image_id")?
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?;
                
                // Get image info to verify it exists
                let _image_info = image::get_image_info(image_id)
                    .ok_or("Image not found")?;
                
                // Get the actual file path from Core
                let file_path = image::get_image_file_path(image_id)
                    .ok_or("Image file path not found")?;
                
                // Construct ImageData enum with real path
                let image_data = serde_json::json!({
                    "type": "FilePath",
                    "path": file_path
                });
                
                Ok(image_data)
            }
            "get_image" => {
                let image_id = params["image_id"].as_str()
                    .ok_or("Missing image_id")?
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?;
                
                let image_info = image::get_image_info(image_id)
                    .ok_or("Image not found")?;
                
                // Get the actual file path
                let file_path = image::get_image_file_path(image_id)
                    .unwrap_or_else(|| format!("./images/{}.png", image_id));
                
                // Convert to plugin SDK's expected format
                let image = serde_json::json!({
                    "id": image_id.to_string(),
                    "path": file_path,
                    "name": image_info.metadata.name,
                    "width": image_info.metadata.width,
                    "height": image_info.metadata.height,
                });
                
                Ok(image)
            }
            _ => Err(format!("Unknown image method: {}", method)),
        }
    }

    fn handle_project_service(&self, method: &str, _params: &Value) -> Result<Value, String> {
        use bubblefish_core::api::project;
        
        match method {
            "get_current" => {
                // Get all projects and find the current one
                let projects = project::get_all_projects_info();
                // For now, return the first project if available
                if let Some(project) = projects.first() {
                    serde_json::to_value(project).map_err(|e| e.to_string())
                } else {
                    Ok(serde_json::Value::Null)
                }
            }
            _ => Err(format!("Unknown project method: {}", method)),
        }
    }

    fn handle_file_service(&self, method: &str, _params: &Value) -> Result<Value, String> {
        match method {
            "read_binary" => {
                // This is handled differently for native plugins
                // They should use the read_image_file callback instead
                Err("Use read_image_file callback for native plugins".to_string())
            }
            _ => Err(format!("Unknown file method: {}", method)),
        }
    }

    fn handle_bunny_service(&self, method: &str, params: &Value) -> Result<Value, String> {
        use bubblefish_core::api::bunny;
        use bubblefish_core::service::bunny::{OCRServiceInfo, TranslationServiceInfo, BUNNY_SERVICE_REGISTRY};

        match method {
            "register_ocr_service" => {
                // Parse plugin_id and service info from params
                let plugin_id = params["plugin_id"].as_str()
                    .ok_or("Missing plugin_id")?;
                let service_info: OCRServiceInfo = serde_json::from_value(
                    params["service_info"].clone()
                ).map_err(|e| format!("Invalid service info: {}", e))?;

                BUNNY_SERVICE_REGISTRY
                    .write()
                    .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                    .register_ocr_service(plugin_id.to_string(), service_info)?;

                Ok(serde_json::json!({"success": true}))
            }
            "register_translation_service" => {
                // Parse plugin_id and service info from params
                let plugin_id = params["plugin_id"].as_str()
                    .ok_or("Missing plugin_id")?;
                let service_info: TranslationServiceInfo = serde_json::from_value(
                    params["service_info"].clone()
                ).map_err(|e| format!("Invalid service info: {}", e))?;

                BUNNY_SERVICE_REGISTRY
                    .write()
                    .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                    .register_translation_service(plugin_id.to_string(), service_info)?;

                Ok(serde_json::json!({"success": true}))
            }
            "unregister_service" => {
                let service_id = params["service_id"].as_str()
                    .ok_or("Missing service_id")?;

                BUNNY_SERVICE_REGISTRY
                    .write()
                    .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                    .unregister_service(service_id)?;

                Ok(serde_json::json!({"success": true}))
            }
            "get_ocr_services" => {
                let services = bunny::get_available_ocr_services();
                Ok(serde_json::to_value(services).unwrap_or(serde_json::json!([])))
            }
            "get_translation_services" => {
                let services = bunny::get_available_translation_services();
                Ok(serde_json::to_value(services).unwrap_or(serde_json::json!([])))
            }
            _ => Err(format!("Unknown bunny method: {}", method)),
        }
    }

    fn handle_events_service(&self, method: &str, params: &Value) -> Result<Value, String> {
        use bubblefish_core::common::EVENT_SYSTEM;

        match method {
            "emit_business_event" => {
                let event_name = params["event_name"].as_str()
                    .ok_or("Missing event_name")?;
                let data = params["data"].clone();

                EVENT_SYSTEM.emit_business_event(event_name.to_string(), data)
                    .map_err(|e| format!("Failed to emit event: {:?}", e))?;

                Ok(serde_json::json!({"success": true}))
            }
            "emit_log_event" => {
                let level = params["level"].as_str().unwrap_or("info");
                let message = params["message"].as_str()
                    .ok_or("Missing message")?;
                let data = params["data"].clone();

                // Convert level to LogLevel enum
                use bubblefish_core::common::LogLevel;
                let log_level = match level {
                    "debug" => LogLevel::Debug,
                    "info" => LogLevel::Info,
                    "warn" => LogLevel::Warn,
                    "error" => LogLevel::Error,
                    _ => LogLevel::Info,
                };

                EVENT_SYSTEM.emit_log(log_level, message.to_string(), Some(data))
                    .map_err(|e| format!("Failed to emit log: {}", e))?;

                Ok(serde_json::json!({"success": true}))
            }
            _ => Err(format!("Unknown events method: {}", method)),
        }
    }
}

// Global plugin loader instance
static PLUGIN_LOADER: OnceLock<Arc<PluginLoader>> = OnceLock::new();

pub fn init_plugin_loader(app_handle: tauri::AppHandle) {
    let _ = PLUGIN_LOADER.set(Arc::new(PluginLoader::new(app_handle)));
}

pub fn get_plugin_loader() -> Option<Arc<PluginLoader>> {
    PLUGIN_LOADER.get().cloned()
}

// Host callback implementations
extern "C" fn host_call_service(
    plugin_id: *const c_char,
    service: *const c_char,
    method: *const c_char,
    params: *const c_char,
) -> *mut c_char {
    unsafe {
        let plugin_id = CStr::from_ptr(plugin_id).to_string_lossy();
        let service = CStr::from_ptr(service).to_string_lossy();
        let method = CStr::from_ptr(method).to_string_lossy();
        let params_str = CStr::from_ptr(params).to_string_lossy();
        
        let params: Value = match serde_json::from_str(&params_str) {
            Ok(v) => v,
            Err(_) => return std::ptr::null_mut(),
        };

        if let Some(loader) = get_plugin_loader() {
            match loader.call_plugin_service(&plugin_id, &service, &method, &params) {
                Ok(result) => {
                    let result_json = serde_json::to_string(&result).unwrap_or_default();
                    CString::new(result_json)
                        .map(|s| s.into_raw())
                        .unwrap_or(std::ptr::null_mut())
                }
                Err(e) => {
                    eprintln!("[PluginLoader] Service call error: service={}, method={}, error={}", service, method, e);
                    std::ptr::null_mut()
                }
            }
        } else {
            eprintln!("[PluginLoader] Plugin loader not initialized");
            std::ptr::null_mut()
        }
    }
}

extern "C" fn host_read_image_file(
    file_path: *const c_char,
    data_ptr: *mut *mut u8,
    data_len: *mut usize,
) -> i32 {
    unsafe {
        let file_path = CStr::from_ptr(file_path).to_string_lossy();
        
        match std::fs::read(&*file_path) {
            Ok(data) => {
                let len = data.len();
                let ptr = data.as_ptr() as *mut u8;
                
                // Allocate memory and copy data
                let allocated = libc::malloc(len) as *mut u8;
                if allocated.is_null() {
                    return -1;
                }
                
                std::ptr::copy_nonoverlapping(ptr, allocated, len);
                
                *data_ptr = allocated;
                *data_len = len;
                0
            }
            Err(_) => -1,
        }
    }
}

extern "C" fn host_free_host_memory(ptr: *mut c_void) {
    unsafe {
        if !ptr.is_null() {
            libc::free(ptr);
        }
    }
}

extern "C" fn host_log_message(level: i32, message: *const c_char) {
    unsafe {
        let message = CStr::from_ptr(message).to_string_lossy();
        match level {
            0 => println!("[Plugin DEBUG] {}", message),
            1 => println!("[Plugin INFO] {}", message),
            2 => eprintln!("[Plugin WARN] {}", message),
            3 => eprintln!("[Plugin ERROR] {}", message),
            _ => println!("[Plugin] {}", message),
        }
    }
}