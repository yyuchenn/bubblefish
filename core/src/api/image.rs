use std::path::PathBuf;
use crate::common::{log_function_call, ProjectId, ImageId};
use crate::common::dto::image::{ImageDTO, ImageDataDTO, ImageFormat};
use crate::common::dto::marker::MarkerDTO;
use crate::service::{get_service, events::DomainEvent};
use crate::service::undo_redo::{ActionType, UndoRedoAction};
use crate::storage::image::get_image_storage;
use crate::storage::project::get_project_storage;

/// 为项目添加图片（从文件路径）- 支持正式项目和临时项目
/// 文件名会自动从路径中提取
pub fn add_image_from_path_to_project(project_id: u32, path: PathBuf) -> Option<u32> {
    #[cfg(not(feature = "wasm"))]
    {
        log_function_call("add_image_from_path_to_project", Some(serde_json::json!({
            "project_id": project_id,
            "path": path.to_string_lossy()
        })));
    }
    
    let service = get_service();
    
    // 从路径中提取文件名
    let file_name = path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let name = Some(file_name.clone());
    
    // API层直接处理业务逻辑，而不是调用Coordinator
    let result = if service.opening_project_service.is_opening_project(project_id) {
        // 临时项目路径
        if let Some(image_id) = service.image_service.add_image_from_path(path.clone(), name.clone()) {
            service.opening_project_service.add_image_to_opening_project(project_id, image_id, name.clone(), Some(path.clone()));
            service.event_bus.publish(DomainEvent::ImageAddedToProject(ProjectId::from(project_id), ImageId::from(image_id)));
            
            // Record undo/redo action
            if let Ok(Some(image)) = get_image_storage(ImageId::from(image_id)) {
                if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
                    let position = project.image_ids.iter().position(|&id| id == ImageId::from(image_id)).unwrap_or(0);
                    let action = UndoRedoAction::new(
                        ActionType::AddImage {
                            image: (*image).clone(),
                            position,
                        },
                        ProjectId::from(project_id),
                    );
                    let _ = service.undo_redo_service.record_action(action);
                }
            }
            
            Some(image_id)
        } else {
            None
        }
    } else if service.project_service.project_exists(project_id) {
        // 正式项目路径
        if let Some(image_id) = service.image_service.add_image_from_path(path.clone(), name.clone()) {
            if service.project_service.add_image_to_project(project_id, image_id) {
                service.event_bus.publish(DomainEvent::ImageAddedToProject(ProjectId::from(project_id), ImageId::from(image_id)));
                
                // Record undo/redo action
                if let Ok(Some(image)) = get_image_storage(ImageId::from(image_id)) {
                    if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
                        let position = project.image_ids.iter().position(|&id| id == ImageId::from(image_id)).unwrap_or(0);
                        let action = UndoRedoAction::new(
                            ActionType::AddImage {
                                image: (*image).clone(),
                                position,
                            },
                            ProjectId::from(project_id),
                        );
                        let _ = service.undo_redo_service.record_action(action);
                    }
                }
                
                Some(image_id)
            } else {
                // 回滚操作
                service.image_service.remove_image(image_id);
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    
    result
}

/// 为项目添加图片（从二进制数据）- 支持正式项目和临时项目
pub fn add_image_from_binary_to_project(project_id: u32, format: ImageFormat, data: Vec<u8>, name: Option<String>) -> Option<u32> {
    log_function_call("add_image_from_binary_to_project", Some(serde_json::json!({
        "project_id": project_id,
        "format": format,
        "data_size": data.len(),
        "name": name
    })));
    
    let service = get_service();
    
    // API层直接处理业务逻辑
    if service.opening_project_service.is_opening_project(project_id) {
        // 临时项目路径
        if let Some(image_id) = service.image_service.add_image_from_binary(format, data, name.clone()) {
            service.opening_project_service.add_image_to_opening_project(project_id, image_id, name, None);
            service.event_bus.publish(DomainEvent::ImageAddedToProject(ProjectId::from(project_id), ImageId::from(image_id)));
            
            // Record undo/redo action
            if let Ok(Some(image)) = get_image_storage(ImageId::from(image_id)) {
                if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
                    let position = project.image_ids.iter().position(|&id| id == ImageId::from(image_id)).unwrap_or(0);
                    let action = UndoRedoAction::new(
                        ActionType::AddImage {
                            image: (*image).clone(),
                            position,
                        },
                        ProjectId::from(project_id),
                    );
                    let _ = service.undo_redo_service.record_action(action);
                }
            }
            
            Some(image_id)
        } else {
            None
        }
    } else if service.project_service.project_exists(project_id) {
        // 正式项目路径
        if let Some(image_id) = service.image_service.add_image_from_binary(format, data, name) {
            if service.project_service.add_image_to_project(project_id, image_id) {
                service.event_bus.publish(DomainEvent::ImageAddedToProject(ProjectId::from(project_id), ImageId::from(image_id)));
                
                // Record undo/redo action
                if let Ok(Some(image)) = get_image_storage(ImageId::from(image_id)) {
                    if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
                        let position = project.image_ids.iter().position(|&id| id == ImageId::from(image_id)).unwrap_or(0);
                        let action = UndoRedoAction::new(
                            ActionType::AddImage {
                                image: (*image).clone(),
                                position,
                            },
                            ProjectId::from(project_id),
                        );
                        let _ = service.undo_redo_service.record_action(action);
                    }
                }
                
                Some(image_id)
            } else {
                // 回滚操作
                service.image_service.remove_image(image_id);
                None
            }
        } else {
            None
        }
    } else {
        None
    }
}

/// 获取图片信息
pub fn get_image_info(image_id: u32) -> Option<ImageDTO> {
    log_function_call("get_image_info", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.get_image(image_id)
}

/// 获取图片二进制数据
pub fn get_image_binary_data(image_id: u32) -> Result<Vec<u8>, String> {
    log_function_call("get_image_binary_data", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.get_image_binary_data(image_id)
}

/// 获取图片文件路径（用于高效访问）
pub fn get_image_file_path(image_id: u32) -> Option<String> {
    log_function_call("get_image_file_path", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.get_image_file_path(image_id)
}

/// 获取图片MIME类型
pub fn get_image_mime_type(image_id: u32) -> Option<String> {
    log_function_call("get_image_mime_type", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.get_image_mime_type(image_id)
}

/// 更新图片信息
pub fn update_image_info(image_id: u32, data: Option<ImageDataDTO>, name: Option<String>) -> bool {
    log_function_call("update_image_info", Some(serde_json::json!({"image_id": image_id, "name": name})));
    let service = get_service();
    service.image_service.update_image(image_id, data, name)
}

/// 更新图片数据
pub fn update_image_data(image_id: u32, data: ImageDataDTO) -> bool {
    log_function_call("update_image_data", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.update_image_data(image_id, data)
}

/// 更新图片名称
pub fn update_image_name(image_id: u32, name: Option<String>) -> bool {
    log_function_call("update_image_name", Some(serde_json::json!({"image_id": image_id, "name": name})));
    let service = get_service();
    service.image_service.update_image_name(image_id, name)
}

/// 从项目中移除图片
pub fn remove_image_from_project(project_id: u32, image_id: u32) -> bool {
    log_function_call("remove_image_from_project", Some(serde_json::json!({
        "project_id": project_id,
        "image_id": image_id
    })));
    
    let service = get_service();
    
    // Get image and its position before deletion for undo/redo
    let image = get_image_storage(ImageId::from(image_id)).ok().flatten();
    let position = if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
        project.image_ids.iter().position(|&id| id == ImageId::from(image_id)).unwrap_or(0)
    } else {
        0
    };
    
    // Take ownership of markers from storage - they will be moved into the action
    // If the action is later overwritten, markers will be automatically freed
    let markers = service.marker_service.take_image_markers(ImageId::from(image_id))
        .unwrap_or_default();
    
    // 从项目中移除并删除图片
    let removed_from_project = service.project_service.remove_image_from_project(project_id, image_id);
    let removed_image = service.image_service.remove_image(image_id);
    
    if removed_from_project && removed_image {
        service.event_bus.publish(DomainEvent::ImageRemovedFromProject(
            ProjectId::from(project_id),
            ImageId::from(image_id)
        ));
        
        // Record undo/redo action with the image and markers
        if let Some(img) = image {
            let action = UndoRedoAction::new(
                ActionType::RemoveImage {
                    image: (*img).clone(),
                    position,
                    markers, // Must save markers since we cleared them from storage
                },
                ProjectId::from(project_id),
            );
            let _ = service.undo_redo_service.record_action(action);
        }
    }
    
    removed_from_project && removed_image
}

/// 重新排序项目中的图片
pub fn reorder_project_images(project_id: u32, image_ids: Vec<u32>) -> bool {
    log_function_call("reorder_project_images", Some(serde_json::json!({
        "project_id": project_id,
        "image_count": image_ids.len()
    })));
    let service = get_service();
    
    // Get current order before reordering
    let old_order = if let Ok(Some(project)) = get_project_storage(ProjectId::from(project_id)) {
        project.image_ids.clone()
    } else {
        vec![]
    };
    
    let new_order: Vec<ImageId> = image_ids.iter().map(|&id| ImageId::from(id)).collect();
    let result = service.project_service.reorder_project_images(project_id, image_ids);
    
    if result && !old_order.is_empty() {
        // Record undo/redo action
        let action = UndoRedoAction::new(
            ActionType::ReorderImages {
                old_order,
                new_order,
            },
            ProjectId::from(project_id),
        );
        let _ = service.undo_redo_service.record_action(action);
    }
    
    result
}

/// 获取图片的所有标记
pub fn get_image_markers(image_id: u32) -> Vec<MarkerDTO> {
    log_function_call("get_image_markers", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.image_service.get_image_markers(image_id)
}

/// 获取图片总数
pub fn image_count() -> Result<usize, String> {
    let service = get_service();
    service.image_service.image_count()
        .map_err(|e| e.to_string())
}

/// 获取图片的标记ID列表
pub fn get_image_marker_ids(image_id: u32) -> Result<Vec<u32>, String> {
    let service = get_service();
    service.image_service.get_image_marker_ids(image_id)
        .map_err(|e| e.to_string())
}