use bubblefish_plugin_sdk::{
    export_plugin, plugin_metadata, Plugin, PluginContext, ServiceProxyManager, 
    CoreEvent, PluginMetadata
};
use std::collections::HashMap;

pub struct EnhancedMarkerLogger {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
    stats: HashMap<String, u32>,
}

impl EnhancedMarkerLogger {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
            stats: HashMap::new(),
        }
    }

    fn log(&self, level: &str, message: &str) {
        let prefix = match level {
            "info" => "ℹ️",
            "success" => "✅",
            "warning" => "⚠️",
            "error" => "❌",
            _ => "📝",
        };
        
        #[cfg(feature = "wasm")]
        {
            web_sys::console::log_1(&format!("[MarkerLogger] {} {}", prefix, message).into());
        }
        
        #[cfg(feature = "native")]
        {
            println!("[MarkerLogger] {} {}", prefix, message);
        }
    }

    fn update_stat(&mut self, key: &str) {
        *self.stats.entry(key.to_string()).or_insert(0) += 1;
        self.log("info", &format!("Stats - {}: {}", key, self.stats[key]));
    }
}

impl Plugin for EnhancedMarkerLogger {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context);
        self.services = Some(services.clone());
        
        self.log("success", "Plugin initialized with enhanced capabilities!");
        
        // 尝试获取当前项目信息
        if let Some(services) = &self.services {
            match services.project().get_current() {
                Ok(Some(project)) => {
                    self.log("info", &format!("Connected to project: {}", 
                        project.name));
                    self.log("info", &format!("  Description: {}", 
                        project.description));
                    
                    // 只有在项目存在时才获取统计信息
                    match services.stats().get_stats(&project.id) {
                        Ok(stats) => {
                            self.log("info", &format!("Project stats:"));
                            self.log("info", &format!("  Total images: {}", stats.total_images));
                            self.log("info", &format!("  Total markers: {}", stats.total_markers));
                            self.log("info", &format!("  Translated: {}", stats.translated_markers));
                        }
                        Err(_) => {
                            // 静默处理统计信息获取失败，这在项目刚创建时是正常的
                        }
                    }
                }
                Ok(None) => {
                    self.log("info", "No project currently open - waiting for project to be loaded");
                }
                Err(_) => {
                    // 静默处理项目获取失败，这在插件初始化时是正常的
                    self.log("info", "Waiting for project to be loaded");
                }
            }
        }
        
        Ok(())
    }

    fn on_core_event(&mut self, event: &CoreEvent) -> Result<(), String> {
        match event {
            CoreEvent::MarkerSelected { marker_id, marker } => {
                self.log("info", &format!("🎯 Marker selected: {}", marker_id));
                self.update_stat("marker_selections");
                
                // 使用Service API获取详细信息
                if let Some(services) = &self.services {
                    // 尝试从事件数据或Service获取marker信息
                    if let Some(marker_data) = marker {
                        if let Some(text) = marker_data["text"].as_str() {
                            self.log("info", &format!("  Text: {}", text));
                        }
                        if let Some(translation) = marker_data["translation"].as_str() {
                            if !translation.is_empty() {
                                self.log("info", &format!("  Translation: {}", translation));
                            }
                        }
                    } else {
                        // 从Service获取完整信息
                        match services.markers().get_marker(marker_id) {
                            Ok(marker) => {
                                self.log("info", &format!("  Text: {}", marker.text));
                                if !marker.translation.is_empty() {
                                    self.log("info", &format!("  Translation: {}", marker.translation));
                                }
                                
                                // 获取相关图片信息
                                match services.images().get_image(&marker.image_id) {
                                    Ok(image) => {
                                        self.log("info", &format!("  On image: {}", image.name));
                                    }
                                    Err(_) => {}
                                }
                            }
                            Err(e) => {
                                self.log("error", &format!("Failed to get marker details: {}", e));
                            }
                        }
                    }
                }
                
                self.log("info", "─".repeat(40).as_str());
            }
            
            CoreEvent::MarkerDeselected { marker_id } => {
                self.log("info", &format!("Marker deselected: {}", marker_id));
                self.update_stat("marker_deselections");
            }
            
            CoreEvent::MarkerCreated { marker } => {
                self.log("success", "✨ New marker created!");
                self.update_stat("markers_created");
                
                if let Some(text) = marker["text"].as_str() {
                    self.log("info", &format!("  Text: {}", text));
                }
            }
            
            CoreEvent::MarkerUpdated { old: _, new } => {
                self.log("info", "✏️ Marker updated");
                self.update_stat("markers_updated");
                
                if let Some(text) = new["text"].as_str() {
                    self.log("info", &format!("  New text: {}", text));
                }
            }
            
            CoreEvent::MarkerDeleted { marker_id } => {
                self.log("warning", &format!("🗑️ Marker deleted: {}", marker_id));
                self.update_stat("markers_deleted");
            }
            
            CoreEvent::ProjectOpened { project } => {
                if let Some(name) = project["name"].as_str() {
                    self.log("success", &format!("📂 Project opened: {}", name));
                }
            }
            
            CoreEvent::SystemReady => {
                self.log("success", "🚀 System ready!");
                self.log("info", &format!("Plugin stats: {:?}", self.stats));
            }
            
            _ => {
                // 记录其他事件
                self.log("info", &format!("Event: {}", event.event_type()));
            }
        }
        
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: serde_json::Value) -> Result<(), String> {
        self.log("info", &format!("📬 Message from {}: {:?}", from, message));
        
        // 处理来自其他插件的消息
        if let Some(command) = message["command"].as_str() {
            match command {
                "get_stats" => {
                    self.log("info", &format!("Sharing stats: {:?}", self.stats));
                }
                "reset_stats" => {
                    self.stats.clear();
                    self.log("info", "Stats reset");
                }
                _ => {
                    self.log("warning", &format!("Unknown command: {}", command));
                }
            }
        }
        
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("success", "🟢 Plugin activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("warning", "🟠 Plugin deactivated");
        self.log("info", &format!("Final stats: {:?}", self.stats));
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("info", "Plugin destroyed");
        self.context = None;
        self.services = None;
        self.stats.clear();
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata![
            "MarkerSelected",
            "MarkerDeselected",
            "MarkerCreated",
            "MarkerUpdated",
            "MarkerDeleted",
            "ProjectOpened",
            "SystemReady"
        ]
    }
}

export_plugin!(EnhancedMarkerLogger);