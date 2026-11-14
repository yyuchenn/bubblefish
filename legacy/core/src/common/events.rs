use serde::{Deserialize, Serialize};

/// 跨平台的时间戳获取函数
pub fn get_timestamp_millis() -> u64 {
    #[cfg(feature = "wasm")]
    {
        // 在 WASM 环境中使用 JavaScript 的 Date.now()
        js_sys::Date::now() as u64
    }
    #[cfg(not(feature = "wasm"))]
    {
        // 在非 WASM 环境中使用标准库
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EventType {
    Log,
    Business,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub event_type: EventType,
    pub event_name: String,
    pub data: serde_json::Value,
    pub timestamp: u64,
}

pub trait EventEmitter: Send + Sync {
    fn emit(&self, event: Event) -> Result<(), String>;
}

pub struct EventSystem {
    emitters: Arc<Mutex<HashMap<String, Box<dyn EventEmitter>>>>,
}

impl EventSystem {
    pub fn new() -> Self {
        Self {
            emitters: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register_emitter(&self, name: String, emitter: Box<dyn EventEmitter>) {
        let mut emitters = self.emitters.lock().unwrap();
        emitters.insert(name, emitter);
    }

    pub fn emit_event(&self, event: Event) -> Result<(), String> {
        let emitters = self.emitters.lock().unwrap();
        for (name, emitter) in emitters.iter() {
            if let Err(e) = emitter.emit(event.clone()) {
                eprintln!("Failed to emit event via {}: {}", name, e);
            }
        }
        Ok(())
    }

    pub fn emit_log(&self, level: LogLevel, message: String, data: Option<serde_json::Value>) -> Result<(), String> {
        let event = Event {
            event_type: EventType::Log,
            event_name: "log".to_string(),
            data: serde_json::json!({
                "level": level,
                "message": message,
                "data": data,
            }),
            timestamp: get_timestamp_millis(),
        };
        self.emit_event(event)
    }

    pub fn emit_business_event(&self, event_name: String, data: serde_json::Value) -> Result<(), String> {
        let event = Event {
            event_type: EventType::Business,
            event_name,
            data,
            timestamp: get_timestamp_millis(),
        };
        self.emit_event(event)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[cfg(feature = "tauri")]
pub struct TauriEventEmitter {
    app_handle: tauri::AppHandle,
}

#[cfg(feature = "tauri")]
impl TauriEventEmitter {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "tauri")]
impl EventEmitter for TauriEventEmitter {
    fn emit(&self, event: Event) -> Result<(), String> {
        use tauri::Emitter;
        
        let event_name = match event.event_type {
            EventType::Log => "core-log",
            EventType::Business => "core-business",
        };
        
        self.app_handle.emit(event_name, event)
            .map_err(|e| format!("Failed to emit Tauri event: {}", e))
    }
}

#[cfg(feature = "wasm")]
pub struct WasmEventEmitter {
    // WASM事件发射器，通过JavaScript全局函数发送事件
}

#[cfg(feature = "wasm")]
impl WasmEventEmitter {
    pub fn new() -> Self {
        Self {}
    }
}

#[cfg(feature = "wasm")]
impl EventEmitter for WasmEventEmitter {
    fn emit(&self, event: Event) -> Result<(), String> {
        // 在WASM环境中，优先尝试Worker回调，然后回退到window事件
        #[cfg(feature = "wasm")]
        {
            // 检查是否在主线程中
            let in_main_thread = IS_MAIN_THREAD.with(|is_main| is_main.get());
            
            // 如果不在主线程中（即在Rayon线程中），使用事件通道
            if !in_main_thread {
                // 根据事件类型设置事件名称和数据
                let (channel_event_name, channel_event_data) = match event.event_type {
                    EventType::Log => {
                        // 对于日志事件，直接发送日志数据（不包装在Event中）
                        ("core-log".to_string(), event.data.clone())
                    },
                    EventType::Business => {
                        // 对于业务事件，只发送data字段
                        (event.event_name.clone(), event.data.clone())
                    },
                };
                
                crate::bindings::wasm::event_channel::WASM_EVENT_CHANNEL.send(
                    channel_event_name,
                    channel_event_data
                );
                return Ok(());
            }
            
            // 在主Worker线程中，直接调用回调
            let callback_result = WORKER_EVENT_CALLBACK.with(|cb| {
                if let Some(callback) = cb.borrow().as_ref() {
                    match event.event_type {
                        EventType::Log => {
                            // 对于日志事件，使用 "core-log" 作为事件名
                            callback("core-log".to_string(), event.data.clone());
                        },
                        EventType::Business => {
                            // 对于业务事件，使用原始事件名
                            let event_data = match serde_json::to_value(&event.data) {
                                Ok(value) => value,
                                Err(_) => return Some(Err("Failed to serialize event data".to_string())),
                            };
                            callback(event.event_name.clone(), event_data);
                        }
                    }
                    Some(Ok(()))
                } else {
                    None
                }
            });
            
            if let Some(result) = callback_result {
                return result;
            }
            
            // 回退到window事件（主线程WASM）
            use wasm_bindgen::JsValue;
            use web_sys::{window, CustomEvent, CustomEventInit};
            
            if let Some(window) = window() {
                let event_init = CustomEventInit::new();
                
                // 将事件数据序列化为JSON
                let event_data = match serde_json::to_string(&event) {
                    Ok(json) => JsValue::from_str(&json),
                    Err(_) => return Err("Failed to serialize event data".to_string()),
                };
                
                event_init.set_detail(&event_data);
                
                // 创建自定义事件
                let event_name = match event.event_type {
                    EventType::Log => "core-log",
                    EventType::Business => "core-business",
                };
                
                match CustomEvent::new_with_event_init_dict(event_name, &event_init) {
                    Ok(custom_event) => {
                        if let Err(_) = window.dispatch_event(&custom_event) {
                            return Err("Failed to dispatch event".to_string());
                        }
                    }
                    Err(_) => return Err("Failed to create custom event".to_string()),
                }
            } else {
                return Err("Window object not available".to_string());
            }
        }
        
        Ok(())
    }
}

// Worker事件回调全局变量（仅在WASM环境中使用）
// 在WASM环境中，我们不需要Send + Sync，因为Worker是单线程的
#[cfg(feature = "wasm")]
thread_local! {
    static WORKER_EVENT_CALLBACK: std::cell::RefCell<Option<Box<dyn Fn(String, serde_json::Value)>>> = std::cell::RefCell::new(None);
}

#[cfg(feature = "wasm")]
pub fn set_worker_event_callback<F>(callback: F) 
where
    F: Fn(String, serde_json::Value) + 'static,
{
    WORKER_EVENT_CALLBACK.with(|cb| {
        *cb.borrow_mut() = Some(Box::new(callback));
    });
}

use once_cell::sync::Lazy;
pub static EVENT_SYSTEM: Lazy<EventSystem> = Lazy::new(|| EventSystem::new());

// 线程局部变量，标记是否在主线程中
#[cfg(feature = "wasm")]
thread_local! {
    static IS_MAIN_THREAD: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

// 标记当前线程为主线程
#[cfg(feature = "wasm")]
pub fn mark_as_main_thread() {
    IS_MAIN_THREAD.with(|is_main| is_main.set(true));
}