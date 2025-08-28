// BubbleFish Core Library
// 
// 这是核心库的入口点，只导出bindings模块
// 所有的API接口都通过bindings模块提供

pub mod bindings;

// 内部模块
pub mod api;
pub mod service;
pub mod storage;
pub mod common;
pub mod plugin;

// 重新导出bindings模块的所有内容
pub use bindings::*;
