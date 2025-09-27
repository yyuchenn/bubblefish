use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    plugin_metadata, export_plugin
};
use serde_json::Value;
use serde::{Deserialize, Serialize};

const API_KEY: &str = include_str!("../api_key");
const API_ENDPOINT: &str = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const MODEL: &str = "doubao-seed-1-6-250615";

const SYSTEM_PROMPT_TEMPLATE: &str = "你是一个专业的{source_lang}到{target_lang}的漫画翻译。请只输出翻译后的文本，不要任何解释或额外信息。";

fn normalize_language_name(lang: &str) -> &str {
    match lang {
        "english" => "英语",
        "simplifiedChinese" => "简体中文",
        "traditionalChinese" => "繁体中文",
        "japanese" => "日本語",
        "auto" => "自动检测",
        _ => lang
    }
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    thinking: ThinkingConfig,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

pub struct DoubaoTranslationPlugin {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
}

impl DoubaoTranslationPlugin {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
        }
    }

    fn log(&self, message: &str) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[DoubaoTranslation] {}", message).into());

        #[cfg(not(target_arch = "wasm32"))]
        println!("[DoubaoTranslation] {}", message);
    }

    fn build_system_prompt(&self, source_lang: Option<&str>, target_lang: &str) -> String {
        let source = normalize_language_name(source_lang.unwrap_or("auto"));
        let target = normalize_language_name(target_lang);
        SYSTEM_PROMPT_TEMPLATE
            .replace("{source_lang}", source)
            .replace("{target_lang}", target)
    }

    #[cfg(target_arch = "wasm32")]
    async fn call_doubao_api(&self, system_prompt: &str, user_text: &str) -> Result<String, String> {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{Request, RequestInit, RequestMode, Response, Headers};

        let request_body = ChatRequest {
            model: MODEL.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_text.to_string(),
                }
            ],
            thinking: ThinkingConfig {
                thinking_type: "disabled".to_string(),
            },
        };

        let body_json = serde_json::to_string(&request_body)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let mut opts = RequestInit::new();
        opts.method("POST");
        opts.mode(RequestMode::Cors);
        opts.body(Some(&JsValue::from_str(&body_json)));

        let request = Request::new_with_str_and_init(API_ENDPOINT, &opts)
            .map_err(|e| format!("Failed to create request: {:?}", e))?;

        let headers = Headers::new()
            .map_err(|e| format!("Failed to create headers: {:?}", e))?;
        headers.set("Content-Type", "application/json")
            .map_err(|e| format!("Failed to set Content-Type: {:?}", e))?;
        headers.set("Authorization", &format!("Bearer {}", API_KEY))
            .map_err(|e| format!("Failed to set Authorization: {:?}", e))?;

        let window = web_sys::window().ok_or("No window object")?;
        let resp_value = JsFuture::from(window.fetch_with_request(&request))
            .await
            .map_err(|e| format!("Fetch failed: {:?}", e))?;

        let resp: Response = resp_value.dyn_into()
            .map_err(|e| format!("Response conversion failed: {:?}", e))?;

        let json = JsFuture::from(resp.json()
            .map_err(|e| format!("Failed to get JSON: {:?}", e))?)
            .await
            .map_err(|e| format!("JSON parsing failed: {:?}", e))?;

        let response: ChatResponse = serde_wasm_bindgen::from_value(json)
            .map_err(|e| format!("Failed to deserialize response: {:?}", e))?;

        response.choices
            .first()
            .map(|choice| choice.message.content.clone())
            .ok_or_else(|| "No response from API".to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn call_doubao_api_sync(&self, system_prompt: &str, user_text: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::new();

        let request_body = ChatRequest {
            model: MODEL.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_text.to_string(),
                }
            ],
            thinking: ThinkingConfig {
                thinking_type: "disabled".to_string(),
            },
        };

        let response = client
            .post(API_ENDPOINT)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", API_KEY))
            .json(&request_body)
            .send()
            .map_err(|e| format!("Request failed: {}", e))?;

        let response_body: ChatResponse = response
            .json()
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        response_body.choices
            .first()
            .map(|choice| choice.message.content.clone())
            .ok_or_else(|| "No response from API".to_string())
    }

    fn handle_translation_request(&self, message: Value) {
        let ctx = match &self.context {
            Some(c) => c.clone(),
            None => return,
        };

        let task_id = message.get("task_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let text = message.get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

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

        let system_prompt = self.build_system_prompt(source_lang, target_lang);
        let user_text = text.to_string();

        #[cfg(target_arch = "wasm32")]
        {
            let self_clone = Self::new();
            let ctx_clone = ctx.clone();
            let task_id_clone = task_id.clone();

            wasm_bindgen_futures::spawn_local(async move {
                match self_clone.call_doubao_api(&system_prompt, &user_text).await {
                    Ok(translated_text) => {
                        self_clone.log(&format!("Translation successful: {}", translated_text));

                        let event = serde_json::json!({
                            "task_id": task_id_clone,
                            "translated_text": translated_text,
                            "service": "doubao-translate"
                        });

                        let _ = ctx_clone.call_service("events", "emit_business_event", serde_json::json!({
                            "event_name": "plugin:translation_result",
                            "data": event
                        }));
                    }
                    Err(e) => {
                        self_clone.log(&format!("Translation failed: {}", e));

                        let event = serde_json::json!({
                            "task_id": task_id_clone,
                            "error": e,
                            "service": "doubao-translate"
                        });

                        let _ = ctx_clone.call_service("events", "emit_business_event", serde_json::json!({
                            "event_name": "plugin:translation_error",
                            "data": event
                        }));
                    }
                }
            });
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            match self.call_doubao_api_sync(&system_prompt, &user_text) {
                Ok(translated_text) => {
                    self.log(&format!("Translation successful: {}", translated_text));

                    let event = serde_json::json!({
                        "task_id": task_id,
                        "translated_text": translated_text,
                        "service": "doubao-translate"
                    });

                    let _ = ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "plugin:translation_result",
                        "data": event
                    }));
                }
                Err(e) => {
                    self.log(&format!("Translation failed: {}", e));

                    let event = serde_json::json!({
                        "task_id": task_id,
                        "error": e,
                        "service": "doubao-translate"
                    });

                    let _ = ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "plugin:translation_error",
                        "data": event
                    }));
                }
            }
        }
    }
}

impl Plugin for DoubaoTranslationPlugin {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context.clone());
        self.services = Some(services);

        self.log("DoubaoTranslation plugin initialized");

        if let Some(ctx) = &self.context {
            let service_info = serde_json::json!({
                "id": "doubao-translate",
                "name": "Doubao AI Translation",
                "version": "1.0.0",
                "source_languages": ["english", "simplifiedChinese", "traditionalChinese", "japanese", "auto"],
                "target_languages": ["english", "simplifiedChinese", "traditionalChinese", "japanese"],
                "supports_auto_detect": true,
                "max_text_length": null
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
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String> {
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "translation_request" {
                self.log(&format!("Received translation request from {}", from));
                self.handle_translation_request(message);
            }
        }
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("DoubaoTranslation plugin activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("DoubaoTranslation plugin deactivated");
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("DoubaoTranslation plugin destroyed");

        if let Some(ctx) = &self.context {
            let _ = ctx.call_service("bunny", "unregister_service", serde_json::json!({
                "service_id": "doubao-translate"
            }));
        }

        self.context = None;
        self.services = None;
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata!("*")
    }
}

export_plugin!(DoubaoTranslationPlugin);