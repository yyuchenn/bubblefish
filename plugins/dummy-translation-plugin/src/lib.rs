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

    fn on_core_event(&mut self, event: &CoreEvent) -> Result<(), String> {
        // Handle events if needed
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String> {
        // Handle translation requests forwarded from the core
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "translation_request" {
                self.log(&format!("Received translation request from {}", from));

                // Extract marker ID
                let marker_id = message.get("marker_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;

                // Extract text and options
                let text = message.get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let target_lang = message.get("target_lang")
                    .and_then(|v| v.as_str())
                    .unwrap_or("zh-CN");

                // Perform dummy translation
                let result = self.perform_translation(text, target_lang);
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
    fn perform_translation(&self, text: &str, target_lang: &str) -> String {
        // This is a dummy implementation
        // Real implementation would call actual translation API
        self.log(&format!("Translating '{}' to {}", text, target_lang));

        // Return some dummy translation based on target language
        match target_lang {
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
        }
    }
}

// Export the plugin
export_plugin!(DummyTranslationPlugin);