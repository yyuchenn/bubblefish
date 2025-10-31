use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    plugin_metadata_with_config, export_plugin,
    ConfigSchema, ConfigField, SelectOption, ConfigValidation,
    NotificationLevel, NotificationPayload, NotificationAction
};
use serde_json::Value;
use serde::{Deserialize, Serialize};

const API_ENDPOINT: &str = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const DEFAULT_MODEL: &str = "doubao-seed-1-6-250615";

const DEFAULT_SYSTEM_PROMPT: &str = "你是一个专业的{source_lang}到{target_lang}的漫画翻译。请只输出翻译后的文本，不要任何解释或额外信息。";

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

    fn push_notification(
        &self,
        id: Option<&str>,
        level: NotificationLevel,
        title: &str,
        message: &str,
        sticky: bool,
        actions: Option<Vec<NotificationAction>>,
    ) {
        if let Some(services) = &self.services {
            let payload = NotificationPayload {
                id: id.map(|value| value.to_string()),
                title: Some(title.to_string()),
                message: message.to_string(),
                level,
                toast: Some(true),
                sticky: Some(sticky),
                auto_close: if sticky { None } else { Some(8000) },
                source: Some("doubao-translation-plugin".to_string()),
                actions,
                extra: None,
            };

            if let Err(err) = services.notifications().push(payload) {
                self.log(&format!("Failed to push notification: {}", err));
            }
        }
    }

    fn get_api_key(&self) -> Result<String, String> {
        if let Some(ctx) = &self.context {
            // Get API key from config service
            match ctx.call_service("config", "get", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "key": "api_key"
            })) {
                Ok(value) => {
                    if let Some(api_key) = value.as_str() {
                        if !api_key.is_empty() {
                            return Ok(api_key.to_string());
                        }
                    }
                    self.push_notification(
                        Some("plugin:doubao:missing-api-key"),
                        NotificationLevel::Error,
                        "Doubao 插件未配置 API Key",
                        "请在插件设置中填写有效的 API Key。",
                        true,
                        None,
                    );
                    Err("API Key not configured. Please configure it in Settings > Plugins.".to_string())
                }
                Err(e) => {
                    self.log(&format!("Failed to get API key from config: {}", e));
                    self.push_notification(
                        Some("plugin:doubao:config-error"),
                        NotificationLevel::Error,
                        "无法读取 Doubao 插件配置",
                        "请检查插件配置文件是否可用。",
                        false,
                        None,
                    );
                    Err("Failed to retrieve API key from configuration".to_string())
                }
            }
        } else {
            Err("Plugin context not initialized".to_string())
        }
    }

    fn get_model(&self) -> String {
        if let Some(ctx) = &self.context {
            // Get model from config service, fallback to default
            match ctx.call_service("config", "get", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "key": "model"
            })) {
                Ok(value) => {
                    if let Some(model) = value.as_str() {
                        if !model.is_empty() {
                            return model.to_string();
                        }
                    }
                    DEFAULT_MODEL.to_string()
                }
                Err(_) => DEFAULT_MODEL.to_string()
            }
        } else {
            DEFAULT_MODEL.to_string()
        }
    }

    fn get_system_prompt_template(&self) -> String {
        if let Some(ctx) = &self.context {
            // Get custom prompt from config service, fallback to default
            match ctx.call_service("config", "get", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "key": "system_prompt"
            })) {
                Ok(value) => {
                    if let Some(prompt) = value.as_str() {
                        if !prompt.is_empty() {
                            return prompt.to_string();
                        }
                    }
                    DEFAULT_SYSTEM_PROMPT.to_string()
                }
                Err(_) => DEFAULT_SYSTEM_PROMPT.to_string()
            }
        } else {
            DEFAULT_SYSTEM_PROMPT.to_string()
        }
    }

    fn build_system_prompt(&self, source_lang: Option<&str>, target_lang: &str) -> String {
        let source = normalize_language_name(source_lang.unwrap_or("auto"));
        let target = normalize_language_name(target_lang);
        let template = self.get_system_prompt_template();
        template
            .replace("{source_lang}", source)
            .replace("{target_lang}", target)
    }

    #[cfg(target_arch = "wasm32")]
    async fn call_doubao_api(&self, system_prompt: &str, user_text: &str) -> Result<String, String> {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{Request, RequestInit, RequestMode, Response, Headers};

        // Get API key first
        let api_key = self.get_api_key()?;
        let model = self.get_model();

        let request_body = ChatRequest {
            model,
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
        headers.set("Authorization", &format!("Bearer {}", api_key))
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
        // Get API key first
        let api_key = self.get_api_key()?;
        let model = self.get_model();

        let client = reqwest::blocking::Client::new();

        let request_body = ChatRequest {
            model,
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
            .header("Authorization", format!("Bearer {}", api_key))
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

                        let _ = ctx_clone.call_service("notifications", "push", serde_json::json!({
                            "level": "error",
                            "title": "Doubao 翻译失败",
                            "message": format!("翻译请求失败: {}", e),
                            "toast": true,
                            "sticky": false,
                            "source": "doubao-translation-plugin",
                        }));

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

                    self.push_notification(
                        None,
                        NotificationLevel::Error,
                        "Doubao 翻译失败",
                        &format!("翻译请求失败: {}", e),
                        false,
                        None,
                    );

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
        let config_schema = ConfigSchema::simple(vec![
            ConfigField::password("api_key", "API Key")
                .required()
                .with_placeholder("请输入 Doubao API Key")
                .with_help("从 Volcano Engine 控制台获取的 API Key")
                .with_validation(vec![ConfigValidation::MinLength(10)]),

            ConfigField::select(
                "model",
                "模型选择",
                vec![
                    SelectOption {
                        value: "doubao-seed-1-6-250615".to_string(),
                        label: "Doubao Seed 1.6".to_string()
                    },
                    SelectOption {
                        value: "doubao-seed-1-6-flash-250828".to_string(),
                        label: "Doubao Seed 1.6 Flash".to_string()
                    },
                    SelectOption {
                        value: "doubao-1-5-pro-32k-250115".to_string(),
                        label: "Doubao 1.5 Pro 32K".to_string()
                    }
                ]
            )
            .with_default("doubao-seed-1-6-250615")
            .with_help("选择要使用的 Doubao 模型"),

            ConfigField::textarea("system_prompt", "系统提示词")
                .with_placeholder("自定义翻译提示词，使用 {source_lang} 和 {target_lang} 作为占位符")
                .with_help("留空使用默认提示词。可以使用 {source_lang} 和 {target_lang} 占位符")
                .with_default(DEFAULT_SYSTEM_PROMPT),
        ]);

        plugin_metadata_with_config!(config_schema, "*")
    }
}

export_plugin!(DoubaoTranslationPlugin);