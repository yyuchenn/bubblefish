// Service层模块导出
pub mod events;
pub mod coordinator;
pub mod project;
pub mod opening_project;
pub mod image;
pub mod marker;
pub mod stats;
pub mod undo_redo;
pub mod io;

// 导出主要接口
pub use coordinator::ServiceCoordinator;
pub use events::{DomainEvent, EventBus};

// 创建全局service实例
use std::sync::Arc;
use once_cell::sync::Lazy;

pub static SERVICE: Lazy<Arc<ServiceCoordinator>> = Lazy::new(|| {
    Arc::new(ServiceCoordinator::new())
});

// 获取service实例的便捷函数
pub fn get_service() -> Arc<ServiceCoordinator> {
    SERVICE.clone()
}

// 尝试获取service实例（避免初始化时的循环依赖）
pub fn try_get_service() -> Result<Arc<ServiceCoordinator>, &'static str> {
    if Lazy::get(&SERVICE).is_some() {
        Ok(SERVICE.clone())
    } else {
        Err("Service not yet initialized")
    }
}