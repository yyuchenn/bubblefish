// WASM环境下的事件通道，用于跨线程通信
#[cfg(feature = "wasm")]
use std::sync::{Arc, Mutex};
#[cfg(feature = "wasm")]
use std::collections::VecDeque;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use serde_json::Value;
#[cfg(feature = "wasm")]
use js_sys;

#[cfg(feature = "wasm")]
pub struct EventMessage {
    pub event_name: String,
    pub event_data: Value,
}

#[cfg(feature = "wasm")]
pub struct EventChannel {
    queue: Arc<Mutex<VecDeque<EventMessage>>>,
}

#[cfg(feature = "wasm")]
impl EventChannel {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    /// 发送事件到队列（线程安全）
    pub fn send(&self, event_name: String, event_data: Value) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.push_back(EventMessage { event_name, event_data });
        }
    }

    /// 获取所有待处理的事件
    pub fn drain_events(&self) -> Vec<EventMessage> {
        if let Ok(mut queue) = self.queue.lock() {
            queue.drain(..).collect()
        } else {
            Vec::new()
        }
    }
}

#[cfg(feature = "wasm")]
impl Clone for EventChannel {
    fn clone(&self) -> Self {
        Self {
            queue: self.queue.clone(),
        }
    }
}

// 全局事件通道
#[cfg(feature = "wasm")]
lazy_static::lazy_static! {
    pub static ref WASM_EVENT_CHANNEL: EventChannel = EventChannel::new();
}

// 轮询函数，由主Worker线程定期调用
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_poll_events() -> JsValue {
    let events = WASM_EVENT_CHANNEL.drain_events();
    
    if events.is_empty() {
        return JsValue::NULL;
    }
    
    // 直接创建 JS 数组
    let js_array = js_sys::Array::new();
    
    for event in events {
        if let Ok(js_event) = serde_wasm_bindgen::to_value(&serde_json::json!({
            "event_name": event.event_name,
            "event_data": event.event_data,
        })) {
            js_array.push(&js_event);
        }
    }
    
    JsValue::from(js_array)
}