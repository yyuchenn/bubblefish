use serde::{Serialize, Deserialize};
use serde_json::Value;

/// 核心事件类型 - 与Core模块的事件系统对应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CoreEvent {
    // 项目事件
    ProjectCreated { project: Value },
    ProjectOpened { project: Value },
    ProjectSaved { project: Value },
    ProjectClosed,
    
    // 标记事件
    MarkerCreated { marker: Value },
    MarkerUpdated { old: Value, new: Value },
    MarkerDeleted { marker_id: String },
    MarkerSelected { marker_id: String, marker: Option<Value> },
    MarkerDeselected { marker_id: String },
    MarkersReordered { marker_ids: Vec<String> },
    
    // 图片事件
    ImageAdded { image: Value },
    ImageRemoved { image_id: String },
    ImageSelected { image_id: String, image: Option<Value> },
    ImageDeselected,
    ImagesReordered { image_ids: Vec<String> },
    
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

impl CoreEvent {
    /// 获取事件类型名称
    pub fn event_type(&self) -> &str {
        match self {
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
        }
    }
    
    /// 检查是否匹配事件类型
    pub fn matches(&self, event_type: &str) -> bool {
        self.event_type() == event_type
    }
}