// Enhanced plugin system - provides full access to core services
use std::sync::Arc;

// Enhanced plugin modules
pub mod service_registry;
pub mod event_bus;
pub mod permissions;
pub mod events;

// Re-export key types
pub use service_registry::{ServiceRegistry, ServiceInterface, ServiceInfo, MethodInfo};
pub use event_bus::{UnifiedEventBus, CoreEvent, EventFilter, PluginEventManager};
pub use permissions::{PermissionChecker, Permission, DataScope};
pub use events::{PluginEvent, PluginEventType};

/// Initialize the enhanced plugin system
pub fn init_plugin_system() -> (Arc<ServiceRegistry>, Arc<UnifiedEventBus>, Arc<PermissionChecker>) {
    let mut registry = ServiceRegistry::new();
    let event_bus = Arc::new(UnifiedEventBus::new());
    // Initialize with full permissions for all plugins
    use permissions::DefaultPermissions;
    let permission_checker = Arc::new(PermissionChecker::new(DefaultPermissions::full()));
    
    // Register core services with the registry
    use crate::service::get_service;
    use service_registry::adapters::{MarkerServiceAdapter, ProjectServiceAdapter};
    
    let service = get_service();
    registry.register(Arc::new(MarkerServiceAdapter::new(service.marker_service.clone())));
    registry.register(Arc::new(ProjectServiceAdapter::new(service.project_service.clone())));
    
    (Arc::new(registry), event_bus, permission_checker)
}