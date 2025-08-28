use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod services;
pub mod events;

pub use services::*;
pub use events::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub required_permissions: Vec<String>,
    pub subscribed_events: Vec<String>,
}

/// 增强的Plugin trait - 支持完整的服务访问和事件系统
pub trait Plugin {
    /// 初始化插件，接收上下文和服务代理
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String>;
    
    /// 处理Core事件
    fn on_core_event(&mut self, event: &CoreEvent) -> Result<(), String>;
    
    /// 接收其他插件的消息
    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String>;
    
    /// 插件激活时调用
    fn on_activate(&mut self) -> Result<(), String>;
    
    /// 插件停用时调用  
    fn on_deactivate(&mut self) -> Result<(), String>;
    
    /// 销毁插件
    fn destroy(&mut self);
    
    /// 获取插件元数据
    fn get_metadata(&self) -> PluginMetadata;
}

/// 导出插件的宏 - 新版本
#[macro_export]
macro_rules! export_plugin {
    ($plugin_type:ty) => {
        use wasm_bindgen::prelude::*;
        
        #[wasm_bindgen]
        pub struct PluginWrapper {
            plugin: $plugin_type,
            context: Option<$crate::PluginContext>,
            services: Option<$crate::ServiceProxyManager>,
        }
        
        #[wasm_bindgen]
        impl PluginWrapper {
            #[wasm_bindgen(constructor)]
            pub fn new() -> Self {
                Self {
                    plugin: <$plugin_type>::new(),
                    context: None,
                    services: None,
                }
            }
            
            pub fn init(&mut self, plugin_id: String, permissions: Vec<JsValue>) -> Result<(), JsValue> {
                use $crate::{Plugin, PluginContext, ServiceProxyManager};
                
                let permissions: Vec<String> = permissions
                    .into_iter()
                    .filter_map(|v| v.as_string())
                    .collect();
                
                let context = PluginContext::with_permissions(plugin_id, permissions);
                let services = ServiceProxyManager::new(context.clone());
                
                self.context = Some(context.clone());
                self.services = Some(services.clone());
                
                self.plugin.init(context, services).map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn on_event(&mut self, event_js: JsValue) -> Result<(), JsValue> {
                use $crate::{Plugin, CoreEvent};
                
                let event: CoreEvent = serde_wasm_bindgen::from_value(event_js)?;
                self.plugin.on_core_event(&event).map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn on_message(&mut self, from: String, message: JsValue) -> Result<(), JsValue> {
                use $crate::Plugin;
                use serde_json::Value;
                
                let message: Value = serde_wasm_bindgen::from_value(message)?;
                self.plugin.on_plugin_message(&from, message).map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn activate(&mut self) -> Result<(), JsValue> {
                use $crate::Plugin;
                self.plugin.on_activate().map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn deactivate(&mut self) -> Result<(), JsValue> {
                use $crate::Plugin;
                self.plugin.on_deactivate().map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn destroy(&mut self) {
                use $crate::Plugin;
                self.plugin.destroy();
                self.context = None;
                self.services = None;
            }
            
            pub fn get_metadata(&self) -> Result<JsValue, JsValue> {
                use $crate::Plugin;
                Ok(serde_wasm_bindgen::to_value(&self.plugin.get_metadata())?)
            }
            
            /// 调用Core服务 - 供JS桥接使用
            pub fn call_service(&self, service: String, method: String, params: JsValue) -> Result<JsValue, JsValue> {
                use serde_json::Value;
                
                if let Some(ctx) = &self.context {
                    let params: Value = serde_wasm_bindgen::from_value(params)?;
                    let result = ctx.call_service(&service, &method, params)
                        .map_err(|e| JsValue::from_str(&e))?;
                    Ok(serde_wasm_bindgen::to_value(&result)?)
                } else {
                    Err(JsValue::from_str("Plugin not initialized"))
                }
            }
            
            /// 发送消息给其他插件
            pub fn send_message(&self, to: String, message: JsValue) -> Result<(), JsValue> {
                use serde_json::Value;
                
                let message: Value = serde_wasm_bindgen::from_value(message)?;
                
                web_sys::console::log_1(&format!(
                    "[Plugin] Sending message to {}: {:?}",
                    to, message
                ).into());
                
                Ok(())
            }
        }
    };
}