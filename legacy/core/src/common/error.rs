use serde::{Deserialize, Serialize};
use std::fmt;
use std::panic;
use std::any::Any;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CoreError {
    NotFound(String),
    ValidationFailed { field: String, reason: String },
    StorageError(String),
    PlatformError(String),
    ImageProcessingError(String),
    SerializationError(String),
    Serialization(String),
    LockPoisoned(String),
    IoError(String),
    Io(String),
    InvalidFormat { expected: String, found: String },
    MemoryLimitExceeded { requested: usize, available: usize },
    Internal(String),
    NotInitialized(String),
    ServiceError(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::NotFound(msg) => write!(f, "Not found: {}", msg),
            CoreError::ValidationFailed { field, reason } => {
                write!(f, "Validation failed for field '{}': {}", field, reason)
            }
            CoreError::StorageError(msg) => write!(f, "Storage error: {}", msg),
            CoreError::PlatformError(msg) => write!(f, "Platform error: {}", msg),
            CoreError::ImageProcessingError(msg) => write!(f, "Image processing error: {}", msg),
            CoreError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            CoreError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            CoreError::LockPoisoned(msg) => write!(f, "Lock poisoned: {}", msg),
            CoreError::IoError(msg) => write!(f, "IO error: {}", msg),
            CoreError::Io(msg) => write!(f, "IO error: {}", msg),
            CoreError::InvalidFormat { expected, found } => {
                write!(f, "Invalid format: expected {}, found {}", expected, found)
            }
            CoreError::MemoryLimitExceeded { requested, available } => {
                write!(f, "Memory limit exceeded: requested {} bytes, available {} bytes", requested, available)
            }
            CoreError::Internal(msg) => write!(f, "Internal error: {}", msg),
            CoreError::NotInitialized(msg) => write!(f, "Not initialized: {}", msg),
            CoreError::ServiceError(msg) => write!(f, "Service error: {}", msg),
        }
    }
}

impl std::error::Error for CoreError {}

pub type CoreResult<T> = Result<T, CoreError>;

// Conversion helpers
impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        CoreError::IoError(err.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(err: serde_json::Error) -> Self {
        CoreError::SerializationError(err.to_string())
    }
}

impl<T> From<std::sync::PoisonError<T>> for CoreError {
    fn from(err: std::sync::PoisonError<T>) -> Self {
        CoreError::LockPoisoned(err.to_string())
    }
}

// Panic handling utilities

/// 包装函数调用以捕获panic并转换为Result
pub fn catch_unwind_result<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> Result<R, String> + panic::UnwindSafe,
{
    match panic::catch_unwind(f) {
        Ok(result) => result,
        Err(panic_info) => {
            let msg = extract_panic_message(&panic_info);
            
            // 记录panic信息到前端
            crate::log_error_trace!("Caught panic", serde_json::json!({
                "panic_message": &msg,
                "location": "catch_unwind_result",
                "type": "caught_panic"
            }));
            
            Err(format!("Panic occurred: {}", msg))
        }
    }
}

/// 从panic payload中提取错误消息
fn extract_panic_message(panic_info: &Box<dyn Any + Send>) -> String {
    if let Some(s) = panic_info.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = panic_info.downcast_ref::<String>() {
        s.clone()
    } else {
        "Unknown panic payload".to_string()
    }
}

/// 为异步函数提供的panic处理包装器
#[cfg(feature = "wasm")]
pub async fn catch_unwind_async<F, Fut, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> Fut + panic::UnwindSafe,
    Fut: std::future::Future<Output = Result<R, String>>,
{
    // 注意：Rust的catch_unwind不能直接用于async函数
    // 这里我们只是提供一个模板，实际使用时需要在具体的异步运行时中处理
    f().await
}

/// 宏：自动为函数添加错误处理
#[macro_export]
macro_rules! with_error_handling {
    ($body:expr) => {
        match panic::catch_unwind(panic::AssertUnwindSafe(|| $body)) {
            Ok(result) => result,
            Err(panic_info) => {
                let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_info.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Unknown panic".to_string()
                };
                
                // 记录panic信息到前端（所有环境）
                $crate::log_error_trace!("Function panicked", serde_json::json!({
                    "panic_message": msg,
                    "type": "caught_panic_in_macro"
                }));
                
                Err(format!("Function panicked: {}", msg))
            }
        }
    };
}

pub use with_error_handling;