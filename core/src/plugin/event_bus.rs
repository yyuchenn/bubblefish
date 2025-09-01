use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use serde::{Serialize, Deserialize};
use serde_json::Value;
use crate::service::events::DomainEvent;
use crate::storage::{Marker, Project, Image};
use crate::common::types::{MarkerId, ImageId};

/// 核心事件 - 插件可以订阅的所有事件类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CoreEvent {
    // 项目事件
    ProjectCreated { project: Project },
    ProjectOpened { project: Project },
    ProjectSaved { project: Project },
    ProjectClosed,
    
    // 标记事件
    MarkerCreated { marker: Marker },
    MarkerUpdated { old: Marker, new: Marker },
    MarkerDeleted { marker_id: MarkerId },
    MarkerSelected { marker_id: MarkerId, marker: Option<Marker> },
    MarkerDeselected { marker_id: MarkerId },
    MarkersReordered { marker_ids: Vec<MarkerId> },
    
    // 图片事件
    ImageAdded { image: Image },
    ImageRemoved { image_id: ImageId },
    ImageSelected { image_id: ImageId, image: Option<Image> },
    ImageDeselected,
    ImagesReordered { image_ids: Vec<ImageId> },
    
    // 撤销/重做事件
    UndoPerformed { action: String },
    RedoPerformed { action: String },
    
    // 统计事件
    StatsUpdated { stats: Value },
    
    // 系统事件
    SystemReady,
    SystemShutdown,
    
    // 自定义事件
    Custom { event_type: String, data: Value },
}

/// 事件过滤器
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventFilter {
    pub event_types: Vec<String>,
    pub conditions: HashMap<String, Value>,
}

impl EventFilter {
    pub fn new() -> Self {
        Self {
            event_types: Vec::new(),
            conditions: HashMap::new(),
        }
    }

    pub fn with_types(event_types: Vec<String>) -> Self {
        Self {
            event_types,
            conditions: HashMap::new(),
        }
    }

    pub fn all() -> Self {
        Self {
            event_types: vec!["*".to_string()],
            conditions: HashMap::new(),
        }
    }

    pub fn matches(&self, event: &CoreEvent) -> bool {
        // 如果包含通配符，匹配所有事件
        if self.event_types.contains(&"*".to_string()) {
            return true;
        }

        // 获取事件类型名称
        let event_type = match event {
            CoreEvent::ProjectCreated { .. } => "ProjectCreated",
            CoreEvent::ProjectOpened { .. } => "ProjectOpened",
            CoreEvent::ProjectSaved { .. } => "ProjectSaved",
            CoreEvent::ProjectClosed => "ProjectClosed",
            CoreEvent::MarkerCreated { .. } => "MarkerCreated",
            CoreEvent::MarkerUpdated { .. } => "MarkerUpdated",
            CoreEvent::MarkerDeleted { .. } => "MarkerDeleted",
            CoreEvent::MarkerSelected { .. } => "MarkerSelected",
            CoreEvent::MarkerDeselected { .. } => "MarkerDeselected",
            CoreEvent::MarkersReordered { .. } => "MarkersReordered",
            CoreEvent::ImageAdded { .. } => "ImageAdded",
            CoreEvent::ImageRemoved { .. } => "ImageRemoved",
            CoreEvent::ImageSelected { .. } => "ImageSelected",
            CoreEvent::ImageDeselected => "ImageDeselected",
            CoreEvent::ImagesReordered { .. } => "ImagesReordered",
            CoreEvent::UndoPerformed { .. } => "UndoPerformed",
            CoreEvent::RedoPerformed { .. } => "RedoPerformed",
            CoreEvent::StatsUpdated { .. } => "StatsUpdated",
            CoreEvent::SystemReady => "SystemReady",
            CoreEvent::SystemShutdown => "SystemShutdown",
            CoreEvent::Custom { event_type, .. } => event_type,
        };

        self.event_types.contains(&event_type.to_string())
    }
}

/// 事件处理器
pub type EventHandler = Box<dyn Fn(&CoreEvent) -> Result<(), String> + Send + Sync>;

/// 统一事件总线
pub struct UnifiedEventBus {
    subscribers: Arc<RwLock<HashMap<String, (EventFilter, EventHandler)>>>,
}

impl UnifiedEventBus {
    pub fn new() -> Self {
        Self {
            subscribers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 订阅事件
    pub fn subscribe<F>(&self, subscriber_id: String, filter: EventFilter, handler: F)
    where
        F: Fn(&CoreEvent) -> Result<(), String> + Send + Sync + 'static,
    {
        let mut subscribers = self.subscribers.write().unwrap();
        subscribers.insert(subscriber_id, (filter, Box::new(handler)));
    }

    /// 取消订阅
    pub fn unsubscribe(&self, subscriber_id: &str) {
        let mut subscribers = self.subscribers.write().unwrap();
        subscribers.remove(subscriber_id);
    }

    /// 分发事件
    pub fn dispatch(&self, event: CoreEvent) {
        let subscribers = self.subscribers.read().unwrap();
        
        for (id, (filter, handler)) in subscribers.iter() {
            if filter.matches(&event) {
                if let Err(e) = handler(&event) {
                    eprintln!("Event handler error for subscriber {}: {}", id, e);
                }
            }
        }
    }

    /// 从DomainEvent转换并分发
    pub fn dispatch_domain_event(&self, domain_event: &DomainEvent) {
        if let Some(core_event) = self.convert_domain_event(domain_event) {
            self.dispatch(core_event);
        }
    }

    /// 转换DomainEvent到CoreEvent
    fn convert_domain_event(&self, domain_event: &DomainEvent) -> Option<CoreEvent> {
        match domain_event {
            DomainEvent::ProjectCreated(project_id, name) => {
                // Note: We need to get the full project data from storage
                // For now, create a minimal project representation
                use crate::storage::Project;
                use crate::common::Language;
                let project = Project {
                    id: project_id.clone(),
                    name: name.clone(),
                    image_ids: Vec::new(),
                    file_path: None,
                    source_language: Language::default_source(),
                    target_language: Language::default_target(),
                };
                Some(CoreEvent::ProjectCreated { 
                    project 
                })
            }
            DomainEvent::MarkerDeleted(marker_id) => {
                Some(CoreEvent::MarkerDeleted { 
                    marker_id: marker_id.clone() 
                })
            }
            DomainEvent::MarkerUpdated(_marker_id) => {
                // 注意：这里只有marker_id，需要从存储中获取完整的marker数据
                // 暂时返回None，实际应该从存储中获取marker
                None
            }
            _ => None
        }
    }
}

/// 插件事件订阅管理器
pub struct PluginEventManager {
    event_bus: Arc<UnifiedEventBus>,
    plugin_filters: Arc<RwLock<HashMap<String, EventFilter>>>,
}

impl PluginEventManager {
    pub fn new(event_bus: Arc<UnifiedEventBus>) -> Self {
        Self {
            event_bus,
            plugin_filters: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 为插件注册事件过滤器
    pub fn register_plugin(&self, plugin_id: String, filter: EventFilter, handler: EventHandler) {
        let mut filters = self.plugin_filters.write().unwrap();
        filters.insert(plugin_id.clone(), filter.clone());
        
        self.event_bus.subscribe(plugin_id, filter, move |event| {
            handler(event)
        });
    }

    /// 移除插件的事件订阅
    pub fn unregister_plugin(&self, plugin_id: &str) {
        let mut filters = self.plugin_filters.write().unwrap();
        filters.remove(plugin_id);
        
        self.event_bus.unsubscribe(plugin_id);
    }

    /// 获取插件的事件过滤器
    pub fn get_plugin_filter(&self, plugin_id: &str) -> Option<EventFilter> {
        let filters = self.plugin_filters.read().unwrap();
        filters.get(plugin_id).cloned()
    }

    /// 分发事件给特定插件
    pub fn dispatch_to_plugin(&self, plugin_id: &str, event: CoreEvent) -> Result<(), String> {
        let filters = self.plugin_filters.read().unwrap();
        if let Some(filter) = filters.get(plugin_id) {
            if filter.matches(&event) {
                // 这里需要调用插件的事件处理器
                Ok(())
            } else {
                Err(format!("Event does not match plugin {} filter", plugin_id))
            }
        } else {
            Err(format!("Plugin {} not registered", plugin_id))
        }
    }
}