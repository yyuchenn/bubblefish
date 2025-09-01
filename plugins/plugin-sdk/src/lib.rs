use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod services;
pub mod events;

#[cfg(feature = "wasm")]
pub mod shared_buffer;

#[cfg(feature = "native")]
pub mod native;

pub use services::*;
pub use events::*;

#[cfg(feature = "wasm")]
pub use shared_buffer::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
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

/// 导出插件的宏 - WASM版本
#[cfg(feature = "wasm")]
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
            
            pub fn init(&mut self, plugin_id: String) -> Result<(), JsValue> {
                use $crate::{Plugin, PluginContext, ServiceProxyManager};
                
                let context = PluginContext::new(plugin_id);
                let services = ServiceProxyManager::new(context.clone());
                
                self.context = Some(context.clone());
                self.services = Some(services.clone());
                
                self.plugin.init(context, services).map_err(|e| JsValue::from_str(&e))
            }
            
            pub fn init_shared_buffer(&self, buffer: JsValue) -> Result<(), JsValue> {
                use js_sys::SharedArrayBuffer;
                
                let shared_buffer = buffer.dyn_into::<SharedArrayBuffer>()
                    .map_err(|_| JsValue::from_str("SharedArrayBuffer is required but not provided"))?;
                    
                $crate::shared_buffer::init_shared_channel(shared_buffer);
                Ok(())
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

/// 导出插件的宏 - Native版本
#[cfg(feature = "native")]
#[macro_export]
macro_rules! export_plugin {
    ($plugin_type:ty) => {
        use std::sync::Mutex;
        use once_cell::sync::Lazy;
        
        static PLUGIN_INSTANCE: Lazy<Mutex<Option<$plugin_type>>> = Lazy::new(|| {
            Mutex::new(None)
        });
        
        static CONTEXT: Lazy<Mutex<Option<$crate::PluginContext>>> = Lazy::new(|| {
            Mutex::new(None)
        });
        
        static SERVICES: Lazy<Mutex<Option<$crate::ServiceProxyManager>>> = Lazy::new(|| {
            Mutex::new(None)
        });
        
        /// Initialize plugin - called by host
        #[no_mangle]
        pub extern "C" fn plugin_init(plugin_id: *const std::os::raw::c_char) -> i32 {
            use $crate::{Plugin, PluginContext, ServiceProxyManager};
            
            let plugin_id = unsafe {
                std::ffi::CStr::from_ptr(plugin_id)
                    .to_string_lossy()
                    .into_owned()
            };
            
            let context = PluginContext::new(plugin_id);
            let services = ServiceProxyManager::new(context.clone());
            
            let mut plugin = <$plugin_type>::new();
            
            match plugin.init(context.clone(), services.clone()) {
                Ok(_) => {
                    *PLUGIN_INSTANCE.lock().unwrap() = Some(plugin);
                    *CONTEXT.lock().unwrap() = Some(context);
                    *SERVICES.lock().unwrap() = Some(services);
                    0
                }
                Err(e) => {
                    eprintln!("Plugin init failed: {}", e);
                    -1
                }
            }
        }
        
        /// Handle core event
        #[no_mangle]
        pub extern "C" fn plugin_on_event(event_json: *const std::os::raw::c_char) -> i32 {
            use $crate::{Plugin, CoreEvent};
            
            let event_str = unsafe {
                std::ffi::CStr::from_ptr(event_json)
                    .to_string_lossy()
            };
            
            let event: CoreEvent = match serde_json::from_str(&event_str) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("Failed to parse event: {}", e);
                    return -1;
                }
            };
            
            if let Some(ref mut plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                match plugin.on_core_event(&event) {
                    Ok(_) => 0,
                    Err(e) => {
                        eprintln!("Event handling failed: {}", e);
                        -1
                    }
                }
            } else {
                -1
            }
        }
        
        /// Handle plugin message
        #[no_mangle]
        pub extern "C" fn plugin_on_message(
            from: *const std::os::raw::c_char,
            message_json: *const std::os::raw::c_char
        ) -> i32 {
            use $crate::Plugin;
            use serde_json::Value;
            
            let from_str = unsafe {
                std::ffi::CStr::from_ptr(from)
                    .to_string_lossy()
            };
            
            let message_str = unsafe {
                std::ffi::CStr::from_ptr(message_json)
                    .to_string_lossy()
            };
            
            let message: Value = match serde_json::from_str(&message_str) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("Failed to parse message: {}", e);
                    return -1;
                }
            };
            
            if let Some(ref mut plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                match plugin.on_plugin_message(&from_str, message) {
                    Ok(_) => 0,
                    Err(e) => {
                        eprintln!("Message handling failed: {}", e);
                        -1
                    }
                }
            } else {
                -1
            }
        }
        
        /// Activate plugin
        #[no_mangle]
        pub extern "C" fn plugin_activate() -> i32 {
            use $crate::Plugin;
            
            if let Some(ref mut plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                match plugin.on_activate() {
                    Ok(_) => 0,
                    Err(e) => {
                        eprintln!("Activation failed: {}", e);
                        -1
                    }
                }
            } else {
                -1
            }
        }
        
        /// Deactivate plugin
        #[no_mangle]
        pub extern "C" fn plugin_deactivate() -> i32 {
            use $crate::Plugin;
            
            if let Some(ref mut plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                match plugin.on_deactivate() {
                    Ok(_) => 0,
                    Err(e) => {
                        eprintln!("Deactivation failed: {}", e);
                        -1
                    }
                }
            } else {
                -1
            }
        }
        
        /// Destroy plugin
        #[no_mangle]
        pub extern "C" fn plugin_destroy() {
            use $crate::Plugin;
            
            if let Some(ref mut plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                plugin.destroy();
            }
            
            *PLUGIN_INSTANCE.lock().unwrap() = None;
            *CONTEXT.lock().unwrap() = None;
            *SERVICES.lock().unwrap() = None;
        }
        
        /// Get plugin metadata
        #[no_mangle]
        pub extern "C" fn plugin_get_metadata() -> *mut std::os::raw::c_char {
            use $crate::Plugin;
            
            if let Some(ref plugin) = *PLUGIN_INSTANCE.lock().unwrap() {
                let metadata = plugin.get_metadata();
                match serde_json::to_string(&metadata) {
                    Ok(json) => {
                        let c_str = std::ffi::CString::new(json).unwrap();
                        c_str.into_raw()
                    }
                    Err(_) => std::ptr::null_mut()
                }
            } else {
                std::ptr::null_mut()
            }
        }
        
        /// Free string allocated by plugin
        #[no_mangle]
        pub extern "C" fn plugin_free_string(s: *mut std::os::raw::c_char) {
            if !s.is_null() {
                unsafe {
                    let _ = std::ffi::CString::from_raw(s);
                }
            }
        }
    };
}