use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    OCRProvider, OCRServiceInfo, OCROptions, OCRResult, MarkerGeometry,
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
        // Handle OCR requests from frontend (relayed from backend)
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "ocr_request" {
                self.log(&format!("Received OCR request from {}", from));

                let task_id = message.get("task_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Extract image data
                let image_data = message.get("image_data")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u8))
                            .collect::<Vec<u8>>()
                    })
                    .unwrap_or_else(Vec::new);

                // Extract image format
                let image_format = message.get("image_format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                // Extract marker geometry
                let marker_geometry = message.get("marker_geometry");
                let marker_type = marker_geometry
                    .and_then(|g| g.get("markerType"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                // Extract options
                let options = message.get("options");
                let source_language = options
                    .and_then(|o| o.get("source_language"))
                    .and_then(|v| v.as_str());

                self.log(&format!("Processing OCR for marker type: {}, format: {}, language: {:?}, {} bytes",
                    marker_type, image_format, source_language, image_data.len()));

                // Demonstrate plugin capabilities: calculate image hash
                let image_hash = self.calculate_hash(&image_data);
                self.log(&format!("Image hash: {}", image_hash));

                // Perform dummy OCR with enhanced info
                let result = self.perform_ocr(&image_data, marker_type, image_format, &image_hash, source_language);
                self.log(&format!("OCR result: {}", result));

                // Send result back to frontend (which will relay to backend)
                if let Some(ctx) = &self.context {
                    // Emit OCR completion event
                    let event = serde_json::json!({
                        "task_id": task_id,
                        "text": result,
                        "model": "dummy-ocr"
                    });

                    // The frontend will intercept this and call handle_ocr_completed
                    match ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "plugin:ocr_result",
                        "data": event
                    })) {
                        Ok(_) => self.log("OCR result event emitted successfully"),
                        Err(e) => self.log(&format!("Failed to emit OCR result event: {}", e)),
                    }
                }
            } else if msg_type == "translation_request" {
                self.log(&format!("Received translation request from {}", from));

                let task_id = message.get("task_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let text = message.get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Extract options
                let options = message.get("options");
                let source_language = options
                    .and_then(|o| o.get("source_language"))
                    .and_then(|v| v.as_str());
                let target_language = options
                    .and_then(|o| o.get("target_language"))
                    .and_then(|v| v.as_str());

                self.log(&format!("Translating text: {} chars, {:?} -> {:?}",
                    text.len(), source_language, target_language));

                // Perform dummy translation
                let result = self.perform_translation(text);
                self.log(&format!("Translation result: {}", result));

                // Send result back to frontend (which will relay to backend)
                if let Some(ctx) = &self.context {
                    let event = serde_json::json!({
                        "task_id": task_id,
                        "translated_text": result,
                        "service": "dummy-ocr"
                    });

                    match ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "plugin:translation_result",
                        "data": event
                    })) {
                        Ok(_) => self.log("Translation result event emitted successfully"),
                        Err(e) => self.log(&format!("Failed to emit translation result event: {}", e)),
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
    /// Calculate hash of data (demonstrates plugin's ability to process image data)
    fn calculate_hash(&self, data: &[u8]) -> String {
        // Simple hash implementation for demonstration
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        data.hash(&mut hasher);
        let hash = hasher.finish();

        // Format as hex string (simplified for demo purposes)
        format!("{:016x}", hash)
    }

    fn perform_ocr(&self, image_data: &[u8], marker_type: &str, image_format: &str, image_hash: &str, source_language: Option<&str>) -> String {
        // This is a dummy implementation with enhanced information display
        self.log(&format!("Processing {} bytes for {} marker in {} format",
            image_data.len(), marker_type, image_format));

        // Build result with enhanced information
        let base_text = match marker_type {
            "rectangle" => {
                if image_data.len() > 100000 {
                    "Large text area:\n这是一个大段文本。\nLorem ipsum dolor sit amet."
                } else {
                    "Rectangle text.\n矩形文本。"
                }
            },
            "point" => {
                "Point annotation\n点注释"
            },
            _ => {
                "Unknown marker type\n未知类型"
            }
        };

        // Add metadata footer showing plugin capabilities
        format!(
            "{}\n\n---\n[Dummy OCR Plugin]\nImage Format: {}\nImage Hash: {}\nLanguage: {}\nImage size: {} bytes",
            base_text,
            image_format,
            image_hash,
            source_language.unwrap_or("auto"),
            image_data.len()
        )
    }

    fn perform_translation(&self, text: &str) -> String {
        // This is a dummy implementation
        format!("[Translated] {}", text)
    }
}

// Export the plugin
export_plugin!(DummyOCRPlugin);