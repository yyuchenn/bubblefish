// Service协调器 - 纯粹的依赖注入容器，负责初始化和连接各个Service
use std::sync::Arc;
use super::events::EventBus;
use super::{
    project::ProjectService,
    opening_project::OpeningProjectService,
    image::ImageService,
    marker::MarkerService,
    stats::StatsService,
    undo_redo::UndoRedoService,
    io::{IOService, IoEventHandler},
};

pub struct ServiceCoordinator {
    pub event_bus: Arc<EventBus>,
    pub project_service: Arc<ProjectService>,
    pub opening_project_service: Arc<OpeningProjectService>,
    pub image_service: Arc<ImageService>,
    pub marker_service: Arc<MarkerService>,
    pub stats_service: Arc<StatsService>,
    pub undo_redo_service: Arc<UndoRedoService>,
    pub io_service: Arc<IOService>,
}

impl ServiceCoordinator {
    /// 创建并初始化所有Service
    pub fn new() -> Self {
        let event_bus = Arc::new(EventBus::new());
        
        // 创建各个Service实例
        let project_service = Arc::new(ProjectService::new(event_bus.clone()));
        let opening_project_service = Arc::new(OpeningProjectService::new(event_bus.clone()));
        let image_service = Arc::new(ImageService::new(event_bus.clone()));
        let marker_service = Arc::new(MarkerService::new(event_bus.clone()));
        let stats_service = Arc::new(StatsService::new());
        let undo_redo_service = Arc::new(UndoRedoService::new(event_bus.clone()));
        let io_service = Arc::new(IOService::new(event_bus.clone()));
        
        // 创建IO事件处理器
        let io_event_handler = Arc::new(IoEventHandler::new(event_bus.clone()));
        
        // 设置事件订阅关系 - 各Service会自动处理级联操作
        event_bus.subscribe(project_service.clone());
        event_bus.subscribe(image_service.clone());
        event_bus.subscribe(marker_service.clone());
        event_bus.subscribe(undo_redo_service.clone());
        event_bus.subscribe(io_event_handler);
        
        Self {
            event_bus,
            project_service,
            opening_project_service,
            image_service,
            marker_service,
            stats_service,
            undo_redo_service,
            io_service,
        }
    }
}
