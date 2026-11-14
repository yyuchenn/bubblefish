pub mod bindings;
pub mod event_channel;
pub mod shared_buffer;

pub use bindings::*;
pub use event_channel::*;
pub use shared_buffer::*;

// WASM初始化和panic处理
use wasm_bindgen::prelude::*;
use crate::common::Logger;

#[wasm_bindgen(start)]
pub fn wasm_main() {
    // 设置panic hook以便在浏览器控制台中显示panic信息
    console_error_panic_hook::set_once();
    
    // 设置自定义panic处理器以通过logger记录更详细的信息
    std::panic::set_hook(Box::new(|panic_info| {
        let msg = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };
        
        let location = if let Some(location) = panic_info.location() {
            format!(" at {}:{}:{}", location.file(), location.line(), location.column())
        } else {
            String::new()
        };
        
        let panic_msg = format!("PANIC: {}{}", msg, location);
        
        // 通过我们的logger系统记录，使用log_error_trace!来包含堆栈信息
        crate::common::log_error_trace!("Rust panic occurred", serde_json::json!({
            "panic_message": msg,
            "location": location,
            "full_message": panic_msg,
            "type": "rust_panic"
        }));
        
        // 同时输出到控制台以便立即可见
        Logger::error(&panic_msg);
    }));
    
    // 初始化日志
    Logger::info("🦀 BubbleFish Core (WASM) - Ready for action!");
}

// Re-export wasm-bindgen-rayon's init_thread_pool function for JavaScript to call
pub use wasm_bindgen_rayon::init_thread_pool;