// 事件驱动系统
use crate::common::{ProjectId, ImageId, MarkerId, Language};
use std::sync::{Arc, RwLock};

// 领域事件定义
#[derive(Debug, Clone)]
pub enum DomainEvent {
    // 项目相关事件
    ProjectCreated(ProjectId, String),
    ProjectDeleting(ProjectId),  // 即将删除项目（预处理）
    ProjectDeleted(ProjectId),
    ProjectNameUpdated(ProjectId, String),
    ProjectLanguagesUpdated(ProjectId, Language, Language),
    
    // 临时项目相关事件
    OpeningProjectCreated(ProjectId, String),
    OpeningProjectFinalized(ProjectId),
    OpeningProjectDeleted(ProjectId),
    
    // 图片相关事件
    ImageAddedToProject(ProjectId, ImageId),
    ImageRemovedFromProject(ProjectId, ImageId),
    ImageDeleting(ImageId),  // 即将删除图片（预处理）
    ImageDeleted(ImageId),
    ImageUpdated(ImageId),
    
    // 标记相关事件
    MarkerAddedToImage(ImageId, MarkerId),
    MarkerRemovedFromImage(ImageId, MarkerId, crate::storage::marker::Marker),  // Include marker data for undo
    MarkerDeleting(MarkerId),  // 即将删除标记（预处理）
    MarkerDeleted(MarkerId),
    MarkerUpdated(MarkerId),
    PointMarkerPositionUpdated { id: MarkerId, old_pos: (f64, f64), new_pos: (f64, f64) },
    RectangleGeometryUpdated { 
        id: MarkerId, 
        old_geometry: (f64, f64, f64, f64),  // (x, y, width, height)
        new_geometry: (f64, f64, f64, f64)   // (x, y, width, height)
    },
    MarkerTranslationUpdated { id: MarkerId, old_trans: String, new_trans: String },
    MarkerStyleUpdated { id: MarkerId, old_style: crate::storage::marker::MarkerStyle, new_style: crate::storage::marker::MarkerStyle },
    MarkerFullUpdated { 
        id: MarkerId, 
        old_position: (f64, f64), 
        new_position: (f64, f64),
        old_translation: String,
        new_translation: String,
        old_style: crate::storage::marker::MarkerStyle,
        new_style: crate::storage::marker::MarkerStyle,
    },
    MarkerOrderMoved {
        id: MarkerId,
        image_id: ImageId,
        old_index: u32,
        new_index: u32,
    },
    
    // 文件解析事件
    ParseLabelplusRequested(ProjectId, String),  // 请求解析Labelplus文件
    ParseBfRequested(ProjectId, Vec<u8>),  // 请求解析BF文件
    
    // 批量操作事件
    AllDataClearing,  // 即将清空所有数据
    AllDataCleared,
    ProjectDataClearing(ProjectId),  // 即将清空项目数据
    ProjectDataCleared(ProjectId),
    ImageMarkersClearing(ImageId),  // 即将清空图片标记
    ImageMarkersCleared(ImageId, Vec<crate::storage::marker::Marker>),  // Include markers data for undo
    
    // 级联操作事件
    ProjectImagesDeleting(ProjectId, Vec<ImageId>),  // 项目的所有图片即将删除
    ImageMarkersDeleting(ImageId, Vec<MarkerId>),    // 图片的所有标记即将删除
}

// 事件处理器trait
pub trait EventHandler: Send + Sync {
    fn handle(&self, event: &DomainEvent);
}

// 事件总线
pub struct EventBus {
    handlers: RwLock<Vec<Arc<dyn EventHandler>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            handlers: RwLock::new(Vec::new()),
        }
    }
    
    pub fn subscribe(&self, handler: Arc<dyn EventHandler>) {
        let mut handlers = self.handlers.write().unwrap();
        handlers.push(handler);
    }
    
    pub fn publish(&self, event: DomainEvent) {
        let handlers = self.handlers.read().unwrap();
        for handler in handlers.iter() {
            handler.handle(&event);
        }
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}