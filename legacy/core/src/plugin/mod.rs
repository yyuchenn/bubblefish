// Enhanced plugin system - provides full access to core services
use std::sync::Arc;

// Enhanced plugin modules
pub mod service_registry;
pub mod event_bus;
pub mod events;

// Re-export key types
pub use service_registry::{ServiceRegistry, ServiceInterface, ServiceInfo, MethodInfo};
pub use event_bus::{UnifiedEventBus, CoreEvent, EventFilter, PluginEventManager};
pub use events::{PluginEvent, PluginEventType};

/// Initialize the enhanced plugin system
pub fn init_plugin_system() -> (Arc<ServiceRegistry>, Arc<UnifiedEventBus>) {
    let mut registry = ServiceRegistry::new();
    let event_bus = Arc::new(UnifiedEventBus::new());
    
    // Register core services with the registry
    use crate::service::get_service;
    use service_registry::adapters::{MarkerServiceAdapter, ProjectServiceAdapter, BunnyServiceAdapter, NotificationServiceAdapter};

    let service = get_service();
    registry.register(Arc::new(MarkerServiceAdapter::new(service.marker_service.clone())));
    registry.register(Arc::new(ProjectServiceAdapter::new(service.project_service.clone())));
    registry.register(Arc::new(BunnyServiceAdapter::new(service.bunny_service.clone())));
    registry.register(Arc::new(NotificationServiceAdapter::new()));
    
    (Arc::new(registry), event_bus)
}