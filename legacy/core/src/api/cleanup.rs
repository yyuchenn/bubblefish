use crate::common::{log_function_call, ProjectId};
use crate::service::{get_service, events::DomainEvent};

/// 清空所有数据
pub fn clear_all_data() {
    log_function_call("clear_all_data", None);
    
    let service = get_service();
    
    // 发布清空所有数据事件，各Service会自动处理清理
    service.event_bus.publish(DomainEvent::AllDataClearing);
}

/// 清空特定项目的所有数据
pub fn clear_project_data(project_id: u32) -> bool {
    log_function_call("clear_project_data", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    
    // API层直接处理：删除项目即可，级联删除会自动处理
    if service.project_service.project_exists(project_id) {
        // 发布项目即将删除事件（ImageService会自动清理图片，MarkerService会自动清理标记）
        service.event_bus.publish(DomainEvent::ProjectDeleting(ProjectId::from(project_id)));
        
        let deleted = service.project_service.delete_project(project_id);
        
        if deleted {
            service.event_bus.publish(DomainEvent::ProjectDeleted(ProjectId::from(project_id)));
        }
        
        deleted
    } else {
        false
    }
}