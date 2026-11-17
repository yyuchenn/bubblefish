use bubblefish_plugin_sdk::{
    export_plugin, plugin_metadata, Plugin, PluginContext, ServiceProxyManager, 
    CoreEvent, PluginMetadata
};

pub struct MD5CalculatorPlugin {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
    current_image_id: Option<String>,
}

impl MD5CalculatorPlugin {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
            current_image_id: None,
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
            web_sys::console::log_1(&format!("[MD5Calculator] {} {}", prefix, message).into());
        }
        
        #[cfg(feature = "native")]
        {
            println!("[MD5Calculator] {} {}", prefix, message);
        }
    }

    fn calculate_md5(&self, data: &[u8]) -> String {
        // Calculate real MD5 hash
        let digest = md5::compute(data);
        format!("{:x}", digest)
    }

    fn process_image(&mut self, image_id: &str) {
        if let Some(services) = &self.services {
            // Get image metadata
            match services.images().get_image(image_id) {
                Ok(image) => {
                    self.log("info", &format!("Processing image: {} ({}x{})", 
                        image.name, image.width, image.height));
                }
                Err(e) => {
                    self.log("error", &format!("Failed to get image info: {}", e));
                    return;
                }
            }

            // Get image binary data (handles both FilePath and Binary types)
            match services.images().get_image_binary(image_id) {
                Ok(data) => {
                    // Calculate MD5 hash
                    let md5_hash = self.calculate_md5(&data);
                    self.log("success", &format!("📊 MD5 Hash: {}", md5_hash));
                    self.log("info", &format!("Image size: {} bytes", data.len()));
                }
                Err(e) => {
                    self.log("error", &format!("Failed to get image data: {}", e));
                }
            }
        }
    }
}

impl Plugin for MD5CalculatorPlugin {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context);
        self.services = Some(services);
        
        self.log("success", "MD5 Calculator plugin initialized!");
        self.log("info", "Will calculate MD5 hash when images are selected");
        
        Ok(())
    }

    fn on_core_event(&mut self, event: &CoreEvent) -> Result<(), String> {
        match event {
            CoreEvent::ImageSelected { image_id, image: _ } => {
                self.log("info", &format!("🖼️ Image selected: {}", image_id));
                
                // Check if it's a different image
                if self.current_image_id.as_ref() != Some(image_id) {
                    self.current_image_id = Some(image_id.clone());
                    self.process_image(image_id);
                }
            }
            
            CoreEvent::ProjectOpened { project: _ } => {
                self.log("info", "Project opened, ready to calculate MD5 for images");
                self.current_image_id = None;
            }
            
            _ => {}
        }
        
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: serde_json::Value) -> Result<(), String> {
        self.log("info", &format!("📬 Message from {}: {:?}", from, message));
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("success", "🟢 MD5 Calculator activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("warning", "🟠 MD5 Calculator deactivated");
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("info", "MD5 Calculator destroyed");
        self.context = None;
        self.services = None;
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata![
            "ImageSelected",
            "ProjectOpened"
        ]
    }
}

export_plugin!(MD5CalculatorPlugin);