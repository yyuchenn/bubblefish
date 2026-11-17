pub mod bindings;
pub mod auto_register;

pub use bindings::*;
pub use auto_register::*;

// 导出Tauri需要的事件系统组件
pub use crate::common::{TauriEventEmitter, EVENT_SYSTEM};