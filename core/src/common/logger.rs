use crate::common::events::{EVENT_SYSTEM, LogLevel};
use serde_json::Value;
use std::fmt;

// WASM特定的导入
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = console)]
    fn error(s: &str);
    
    // 获取当前JavaScript调用堆栈
    #[wasm_bindgen(inline_js = "
        export function get_js_stack_trace() {
            const err = new Error();
            return err.stack || 'No stack trace available';
        }
    ")]
    fn get_js_stack_trace() -> String;
}

pub struct Logger;

impl Logger {
    pub fn debug(message: &str) {
        if cfg!(debug_assertions) {
            // 仅在调试模式下记录调试信息
            Self::log_with_data(LogLevel::Debug, message, None);
        }
    }

    pub fn debug_with_data(message: &str, data: Value) {
        if cfg!(debug_assertions) {
            // 仅在调试模式下记录调试信息
            Self::log_with_data(LogLevel::Debug, message, Some(data));
        }
    }

    pub fn info(message: &str) {
        if cfg!(debug_assertions) {
            // 在调试模式下记录信息
            Self::log_with_data(LogLevel::Info, message, None);
        }
    }

    pub fn info_with_data(message: &str, data: Value) {
        if cfg!(debug_assertions) {
            // 在调试模式下记录信息
            Self::log_with_data(LogLevel::Info, message, Some(data));
        }
    }

    pub fn warn(message: &str) {
        if cfg!(debug_assertions) {
            // 在调试模式下记录警告
            Self::log_with_data(LogLevel::Warn, message, None);
        }
    }

    pub fn warn_with_data(message: &str, data: Value) {
        if cfg!(debug_assertions) {
            // 在调试模式下记录警告
            Self::log_with_data(LogLevel::Warn, message, Some(data));
        }
    }

    pub fn error(message: &str) {
        Self::log_with_data(LogLevel::Error, message, None);
    }

    pub fn error_with_data(message: &str, data: Value) {
        Self::log_with_data(LogLevel::Error, message, Some(data));
    }
    
    /// 记录错误并自动捕获堆栈跟踪（仅在WASM环境中）
    pub fn error_with_trace(message: &str) {
        #[cfg(feature = "wasm")]
        {
            let stack_trace = get_js_stack_trace();
            let data = serde_json::json!({
                "stack_trace": stack_trace,
                "has_stack_trace": true
            });
            
            Self::log_with_data(LogLevel::Error, message, Some(data));
        }
        
        #[cfg(not(feature = "wasm"))]
        {
            Self::error(message);
        }
    }
    
    /// 记录错误、数据和堆栈跟踪
    pub fn error_with_data_and_trace(message: &str, data: Value) {
        #[cfg(feature = "wasm")]
        {
            let mut data = data;
            let stack_trace = get_js_stack_trace();
            
            // 将堆栈跟踪添加到数据中
            if let Value::Object(ref mut map) = data {
                map.insert("stack_trace".to_string(), Value::String(stack_trace));
                map.insert("has_stack_trace".to_string(), Value::Bool(true));
            }
            Self::log_with_data(LogLevel::Error, message, Some(data));
        }
        
        #[cfg(not(feature = "wasm"))]
        Self::log_with_data(LogLevel::Error, message, Some(data));
    }

    fn log_with_data(level: LogLevel, message: &str, data: Option<Value>) {
        #[cfg(feature = "wasm")]
        {
            // WASM环境：使用浏览器控制台
            let console_message = match level {
                LogLevel::Debug => format!("[DEBUG] {}", message),
                LogLevel::Info => format!("[INFO] {}", message),
                LogLevel::Warn => format!("[WARN] {}", message),
                LogLevel::Error => format!("[ERROR] {}", message),
            };
            log(&console_message);
        }

        #[cfg(not(feature = "wasm"))]
        {
            // 非WASM环境：使用标准输出
            match level {
                LogLevel::Debug => println!("[DEBUG] {}", message),
                LogLevel::Info => println!("[INFO] {}", message),
                LogLevel::Warn => println!("[WARN] {}", message),
                LogLevel::Error => eprintln!("[ERROR] {}", message),
            }
        }

        // 使用统一的事件系统发送日志（适用于所有环境）
        if let Err(e) = EVENT_SYSTEM.emit_log(level, message.to_string(), data) {
            #[cfg(not(feature = "wasm"))]
            eprintln!("Failed to emit log event: {}", e);
            #[cfg(feature = "wasm")]
            {
                // 在WASM环境中，只在控制台输出错误
                let error_msg = format!("Failed to emit log event: {}", e);
                log(&error_msg);
            }
        }
    }
}

pub fn log_function_call(function_name: &str, args: Option<Value>) {
    Logger::debug_with_data(
        &format!("Function called: {}", function_name),
        serde_json::json!({
            "function": function_name,
            "args": args
        })
    );
}

pub fn log_function_result<T: fmt::Debug>(function_name: &str, result: &Result<T, String>) {
    match result {
        Ok(value) => {
            Logger::debug_with_data(
                &format!("Function {} completed successfully", function_name),
                serde_json::json!({
                    "function": function_name,
                    "result": format!("{:?}", value)
                })
            );
        }
        Err(error) => {
            Logger::error_with_data(
                &format!("Function {} failed", function_name),
                serde_json::json!({
                    "function": function_name,
                    "error": error
                })
            );
        }
    }
}

#[macro_export]
macro_rules! log_debug {
    ($msg:expr) => {
        $crate::common::Logger::debug($msg)
    };
    ($msg:expr, $data:expr) => {
        $crate::common::Logger::debug_with_data($msg, $data)
    };
}

#[macro_export]
macro_rules! log_info {
    ($msg:expr) => {
        $crate::common::Logger::info($msg)
    };
    ($msg:expr, $data:expr) => {
        $crate::common::Logger::info_with_data($msg, $data)
    };
}

#[macro_export]
macro_rules! log_warn {
    ($msg:expr) => {
        $crate::common::Logger::warn($msg)
    };
    ($msg:expr, $data:expr) => {
        $crate::common::Logger::warn_with_data($msg, $data)
    };
}

#[macro_export]
macro_rules! log_error {
    ($msg:expr) => {
        $crate::common::Logger::error($msg)
    };
    ($msg:expr, $data:expr) => {
        $crate::common::Logger::error_with_data($msg, $data)
    };
}

#[macro_export]
macro_rules! log_error_trace {
    ($msg:expr) => {
        $crate::common::Logger::error_with_trace($msg)
    };
    ($msg:expr, $data:expr) => {
        $crate::common::Logger::error_with_data_and_trace($msg, $data)
    };
}

pub use {log_debug, log_info, log_warn, log_error, log_error_trace};