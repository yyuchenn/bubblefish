use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    OCRProvider, OCRServiceInfo, OCROptions, OCRResult,
    plugin_metadata, export_plugin
};
use serde_json::Value;

pub struct DummyOCRPlugin {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
}

impl DummyOCRPlugin {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
        }
    }

    fn log(&self, message: &str) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[DummyOCR] {}", message).into());

        #[cfg(not(target_arch = "wasm32"))]
        println!("[DummyOCR] {}", message);
    }
}

impl Plugin for DummyOCRPlugin {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context.clone());
        self.services = Some(services);

        self.log("DummyOCR plugin initialized");

        // Register our OCR service
        if let Some(ctx) = &self.context {
            let service_info = serde_json::json!({
                "id": "dummy-ocr",
                "name": "Dummy OCR Service",
                "plugin_id": ctx.plugin_id.clone(),
                "supported_languages": ["en", "zh", "ja"],
                "supported_image_formats": ["png", "jpg", "jpeg"]
            });

            match ctx.call_service("bunny", "register_ocr_service", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "service_info": service_info
            })) {
                Ok(_) => self.log("OCR service registered successfully"),
                Err(e) => self.log(&format!("Failed to register OCR service: {}", e)),
            }
        }

        Ok(())
    }

    fn on_core_event(&mut self, event: &CoreEvent) -> Result<(), String> {
        // Handle events if needed
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String> {
        // Handle OCR requests forwarded from the core
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "ocr_request" {
                self.log(&format!("Received OCR request from {}", from));

                // Extract marker ID
                let marker_id = message.get("marker_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                // Extract image data
                let image_data = message.get("image_data")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u8))
                            .collect::<Vec<u8>>()
                    })
                    .unwrap_or_else(Vec::new);

                // Perform dummy OCR
                let result = self.perform_ocr(&image_data);
                self.log(&format!("OCR result for marker {}: {}", marker_id, result));

                // Send result back via bunny event
                if let Some(ctx) = &self.context {
                    // Emit OCR completion event
                    let event = serde_json::json!({
                        "marker_id": marker_id,
                        "original_text": result,
                        "model": "dummy-ocr",
                        "task_id": message.get("task_id").and_then(|v| v.as_str()).unwrap_or("")
                    });

                    // Call the event system to emit the OCR completed event
                    match ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "bunny:ocr_completed",
                        "data": event
                    })) {
                        Ok(_) => self.log("OCR completion event emitted successfully"),
                        Err(e) => self.log(&format!("Failed to emit OCR completion event: {}", e)),
                    }
                }
            }
        }
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("DummyOCR plugin activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("DummyOCR plugin deactivated");
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("DummyOCR plugin destroyed");

        // Unregister our service
        if let Some(ctx) = &self.context {
            let _ = ctx.call_service("bunny", "unregister_service", serde_json::json!({
                "service_id": "dummy-ocr"
            }));
        }

        self.context = None;
        self.services = None;
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata!("*")
    }
}

impl DummyOCRPlugin {
    fn perform_ocr(&self, image_data: &[u8]) -> String {
        // This is a dummy implementation
        // Real implementation would process the image data
        self.log(&format!("Processing image with {} bytes", image_data.len()));

        // Return some dummy text based on image size
        if image_data.len() > 100000 {
            "This is a large image with lots of text content.\n\
             第二行是中文文本。\n\
             The third line contains mixed content.\n\
             [Dummy OCR Result]".to_string()
        } else {
            "Small image text content.\n\
             简短的文本内容。\n\
             [Dummy OCR Result]".to_string()
        }
    }
}

// Export the plugin
export_plugin!(DummyOCRPlugin);