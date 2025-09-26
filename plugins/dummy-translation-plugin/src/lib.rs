use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    TranslationProvider, TranslationServiceInfo, TranslationOptions, TranslationResult,
    plugin_metadata, export_plugin
};
use serde_json::Value;

pub struct DummyTranslationPlugin {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
}

impl DummyTranslationPlugin {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
        }
    }

    fn log(&self, message: &str) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[DummyTranslation] {}", message).into());

        #[cfg(not(target_arch = "wasm32"))]
        println!("[DummyTranslation] {}", message);
    }
}

impl Plugin for DummyTranslationPlugin {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context.clone());
        self.services = Some(services);

        self.log("DummyTranslation plugin initialized");

        // Register our translation service
        if let Some(ctx) = &self.context {
            let service_info = serde_json::json!({
                "id": "dummy-translate",
                "name": "Dummy Translation Service",
                "plugin_id": ctx.plugin_id.clone(),
                "source_languages": ["en", "zh", "ja", "auto"],
                "target_languages": ["en", "zh", "ja", "ko", "fr", "de"],
                "supports_auto_detect": true
            });

            match ctx.call_service("bunny", "register_translation_service", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "service_info": service_info
            })) {
                Ok(_) => self.log("Translation service registered successfully"),
                Err(e) => self.log(&format!("Failed to register translation service: {}", e)),
            }
        }

        Ok(())
    }

    fn on_core_event(&mut self, _event: &CoreEvent) -> Result<(), String> {
        // Handle events if needed
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String> {
        // Handle translation requests forwarded from the core
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "translation_request" {
                self.log(&format!("Received translation request from {}", from));

                // Extract context
                let context = message.get("context").ok_or("Missing context")?;

                let marker_id = context.get("markerId")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                let image_id = context.get("imageId")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                let text = context.get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Extract all markers on the page for context
                let all_markers = context.get("allMarkers")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.len())
                    .unwrap_or(0);

                self.log(&format!("Translation request for marker {} on image {} (page has {} markers)",
                    marker_id, image_id, all_markers));

                // Extract options
                let options = message.get("options");
                let target_lang = options
                    .and_then(|o| o.get("target_language"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("zh-CN");
                let source_lang = options
                    .and_then(|o| o.get("source_language"))
                    .and_then(|v| v.as_str());

                // Perform dummy translation with context awareness
                let result = self.perform_translation_with_context(text, source_lang, target_lang, all_markers);
                self.log(&format!("Translation result for marker {}: {}", marker_id, result));

                // Send result back via bunny event
                if let Some(ctx) = &self.context {
                    // Emit translation completion event
                    let event = serde_json::json!({
                        "marker_id": marker_id,
                        "machine_translation": result,
                        "service": "dummy-translate",
                        "task_id": message.get("task_id").and_then(|v| v.as_str()).unwrap_or("")
                    });

                    // Call the event system to emit the translation completed event
                    match ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "bunny:translation_completed",
                        "data": event
                    })) {
                        Ok(_) => self.log("Translation completion event emitted successfully"),
                        Err(e) => self.log(&format!("Failed to emit translation completion event: {}", e)),
                    }
                }
            }
        }
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("DummyTranslation plugin activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("DummyTranslation plugin deactivated");
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("DummyTranslation plugin destroyed");

        // Unregister our service
        if let Some(ctx) = &self.context {
            let _ = ctx.call_service("bunny", "unregister_service", serde_json::json!({
                "service_id": "dummy-translate"
            }));
        }

        self.context = None;
        self.services = None;
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata!("*")
    }
}

impl DummyTranslationPlugin {
    fn perform_translation_with_context(
        &self,
        text: &str,
        source_lang: Option<&str>,
        target_lang: &str,
        page_marker_count: usize
    ) -> String {
        // This is a context-aware dummy implementation
        // Real implementation would use page context for better translation
        self.log(&format!(
            "Translating '{}' from {:?} to {} (page has {} markers)",
            text, source_lang, target_lang, page_marker_count
        ));

        // Context awareness: add page number info if multiple markers
        let context_prefix = if page_marker_count > 1 {
            format!("[Page context: {} markers] ", page_marker_count)
        } else {
            String::new()
        };

        // Return some dummy translation based on target language
        let translation = match target_lang {
            "zh" | "zh-CN" => format!("[翻译] {}", text),
            "ja" => format!("[翻訳] {}", text),
            "ko" => format!("[번역] {}", text),
            "fr" => format!("[Traduction] {}", text),
            "de" => format!("[Übersetzung] {}", text),
            "en" => {
                // Simple mock translation from Chinese to English
                if text.contains("你好") {
                    "Hello".to_string()
                } else if text.contains("谢谢") {
                    "Thank you".to_string()
                } else {
                    format!("[Translation] {}", text)
                }
            },
            _ => format!("[Translated to {}] {}", target_lang, text)
        };

        format!("{}{}", context_prefix, translation)
    }
}

// Export the plugin
export_plugin!(DummyTranslationPlugin);