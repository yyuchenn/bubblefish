use crate::common::{log_function_call, ProjectId, Language};
use crate::common::dto::project::ProjectDTO;
use crate::common::dto::image::ImageDTO;
use crate::service::{get_service, events::DomainEvent};

/// 获取项目信息
pub fn get_project_info(project_id: u32) -> Option<ProjectDTO> {
    log_function_call("get_project_info", Some(serde_json::json!({"project_id": project_id})));
    let service = get_service();
    service.project_service.get_project(project_id)
}

/// 获取所有项目
pub fn get_all_projects_info() -> Vec<ProjectDTO> {
    log_function_call("get_all_projects_info", None);
    let service = get_service();
    service.project_service.get_all_projects()
}

/// 更新项目名称（带撤销功能）
pub fn update_project_name(project_id: u32, name: String) -> bool {
    log_function_call("update_project_name", Some(serde_json::json!({"project_id": project_id, "name": &name})));
    let service = get_service();
    
    // 获取当前项目名称
    if let Some(project) = service.project_service.get_project(project_id) {
        let old_name = project.name.clone();
        
        // 执行更新
        if service.project_service.update_project_name_internal(project_id, name.clone()) {
            // 创建撤销动作
            let action = crate::service::undo_redo::UndoRedoAction::new(
                crate::service::undo_redo::ActionType::UpdateProjectName {
                    old_name,
                    new_name: name.clone(),
                },
                crate::common::ProjectId::from(project_id),
            );
            
            // 添加到撤销栈
            let _ = service.undo_redo_service.record_action(action);
            
            // 发布事件通知前端更新撤销/重做状态
            service.event_bus.publish(crate::service::events::DomainEvent::ProjectNameUpdated(
                crate::common::ProjectId::from(project_id),
                name
            ));
            
            true
        } else {
            false
        }
    } else {
        false
    }
}

/// 更新项目语言（带撤销功能）
pub fn update_project_languages(project_id: u32, source_language: Language, target_language: Language) -> bool {
    log_function_call("update_project_languages", Some(serde_json::json!({
        "project_id": project_id, 
        "source_language": source_language,
        "target_language": target_language
    })));
    let service = get_service();
    
    // 获取当前项目语言设置
    if let Some(project) = service.project_service.get_project(project_id) {
        let old_source = project.source_language;
        let old_target = project.target_language;
        
        // 执行更新
        if service.project_service.update_project_languages_internal(project_id, source_language, target_language) {
            // 创建撤销动作
            let action = crate::service::undo_redo::UndoRedoAction::new(
                crate::service::undo_redo::ActionType::UpdateProjectLanguages {
                    old_source,
                    new_source: source_language,
                    old_target,
                    new_target: target_language,
                },
                crate::common::ProjectId::from(project_id),
            );
            
            // 添加到撤销栈
            let _ = service.undo_redo_service.record_action(action);
            
            // 发布事件通知前端更新撤销/重做状态
            service.event_bus.publish(crate::service::events::DomainEvent::ProjectLanguagesUpdated(
                crate::common::ProjectId::from(project_id),
                source_language,
                target_language
            ));
            
            true
        } else {
            false
        }
    } else {
        false
    }
}

/// 删除项目
pub fn delete_project(project_id: u32) -> bool {
    log_function_call("delete_project", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    
    // API层直接处理业务逻辑
    let result = if service.project_service.project_exists(project_id) {
        // 发布项目即将删除事件（ImageService会自动清理图片）
        service.event_bus.publish(DomainEvent::ProjectDeleting(ProjectId::from(project_id)));
        
        let deleted = service.project_service.delete_project(project_id);
        
        if deleted {
            service.event_bus.publish(DomainEvent::ProjectDeleted(ProjectId::from(project_id)));
        }
        
        deleted
    } else {
        false
    };
    
    result
}

/// 获取项目的所有图片
pub fn get_project_images(project_id: u32) -> Vec<ImageDTO> {
    log_function_call("get_project_images", Some(serde_json::json!({"project_id": project_id})));
    let service = get_service();
    service.project_service.get_project_images(project_id)
}

/// 获取项目的图片元数据（不包含二进制数据）
pub fn get_project_images_metadata(project_id: u32) -> Vec<crate::common::dto::image::ImageMetadataDTO> {
    log_function_call("get_project_images_metadata", Some(serde_json::json!({"project_id": project_id})));
    let service = get_service();
    service.project_service.get_project_images_metadata(project_id)
}