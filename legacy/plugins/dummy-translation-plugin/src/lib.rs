use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
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
        // Handle translation requests from bunny service (relayed from backend)
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "translation_request" {
                self.log(&format!("Received translation request from {}", from));

                let task_id = message.get("task_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Extract text to translate
                let text = message.get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Extract options
                let options = message.get("options");
                let target_lang = options
                    .and_then(|o| o.get("target_language"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("zh-CN");
                let source_lang = options
                    .and_then(|o| o.get("source_language"))
                    .and_then(|v| v.as_str());

                self.log(&format!("Translating text: {} chars, {:?} -> {}",
                    text.len(), source_lang, target_lang));

                // Perform dummy translation with metadata
                let result = self.perform_translation(text, source_lang, target_lang);
                self.log(&format!("Translation result: {}", result));

                // Send result back to frontend (which will relay to backend)
                if let Some(ctx) = &self.context {
                    let event = serde_json::json!({
                        "task_id": task_id,
                        "translated_text": result,
                        "service": "dummy-translate"
                    });

                    // The frontend will intercept this and call handle_translation_completed
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
    fn perform_translation(
        &self,
        text: &str,
        source_lang: Option<&str>,
        target_lang: &str
    ) -> String {
        // This is a dummy implementation with enhanced information
        self.log(&format!(
            "Processing '{}' from {:?} to {}",
            text, source_lang, target_lang
        ));

        // Perform basic translation
        let translated = match target_lang {
            "zh" | "zh-CN" | "chinese" => format!("[翻译] {}", text),
            "ja" | "japanese" => format!("[翻訳] {}", text),
            "ko" | "korean" => format!("[번역] {}", text),
            "fr" | "french" => format!("[Traduction] {}", text),
            "de" | "german" => format!("[Übersetzung] {}", text),
            "en" | "english" => {
                // Simple mock translation from Chinese to English
                if text.contains("你好") {
                    "Hello".to_string()
                } else if text.contains("谢谢") {
                    "Thank you".to_string()
                } else if text.contains("这是") {
                    "This is".to_string()
                } else if text.contains("大段文本") {
                    "Large text area".to_string()
                } else {
                    format!("[Translation] {}", text)
                }
            },
            _ => format!("[Translated to {}] {}", target_lang, text)
        };

        // Add metadata footer showing plugin capabilities
        format!(
            "{}\n\n---\n[Dummy Translation Plugin]\nDirection: {:?} → {}\nCharacter count: {}\nWord count: {}",
            translated,
            source_lang.unwrap_or("auto"),
            target_lang,
            text.chars().count(),
            text.split_whitespace().count()
        )
    }
}

// Export the plugin
export_plugin!(DummyTranslationPlugin);