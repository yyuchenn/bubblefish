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
                "version": "1.0.0",
                "supported_languages": ["en", "zh", "ja"],
                "supported_image_formats": ["png", "jpg", "jpeg"],
                "max_image_size": null
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

                // Extract context
                let context = message.get("context").ok_or("Missing context")?;

                let marker_id = context.get("markerId")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                let image_id = context.get("imageId")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                // Extract marker geometry
                let geometry = context.get("markerGeometry");
                let marker_type = geometry
                    .and_then(|g| g.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                self.log(&format!("OCR request for marker {} (type: {}) on image {}",
                    marker_id, marker_type, image_id));

                // Extract image data
                let image_data = context.get("imageData")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u8))
                            .collect::<Vec<u8>>()
                    })
                    .unwrap_or_else(Vec::new);

                // Perform dummy OCR with context awareness
                let result = self.perform_ocr_with_context(&image_data, marker_type);
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
    fn perform_ocr_with_context(&self, image_data: &[u8], marker_type: &str) -> String {
        // This is a dummy implementation with context awareness
        // Real implementation would process the image data using marker geometry
        self.log(&format!("Processing {} bytes for {} marker",
            image_data.len(), marker_type));

        // Return different dummy text based on marker type and image size
        // Note: JSON uses lowercase "point" and "rectangle" due to camelCase serialization
        match marker_type {
            "rectangle" => {
                if image_data.len() > 100000 {
                    "Rectangle marker - Large text area:\n\
                     这是一个矩形区域内的大段文本。\n\
                     Lorem ipsum dolor sit amet.\n\
                     [Context-aware Dummy OCR]".to_string()
                } else {
                    "Rectangle marker text.\n\
                     矩形标记文本。\n\
                     [Context-aware Dummy OCR]".to_string()
                }
            },
            "point" => {
                "Point marker annotation\n\
                 点标记注释\n\
                 [Context-aware Dummy OCR]".to_string()
            },
            _ => {
                format!("Unknown marker type '{}'\n\
                        未知标记类型\n\
                        [Context-aware Dummy OCR]", marker_type)
            }
        }
    }
}

// Export the plugin
export_plugin!(DummyOCRPlugin);