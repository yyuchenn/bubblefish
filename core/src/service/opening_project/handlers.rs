// Opening Project 业务逻辑处理
use crate::common::{CoreError, CoreResult, ProjectId, ImageId, Logger, log_function_call};
use crate::storage::state::APP_STATE;
use crate::storage::traits::Storage;
use crate::service::events::{DomainEvent, EventBus};
use super::core::{OpeningProject, OPENING_PROJECTS};
use crate::common::dto::opening_project::OpeningProjectDTO;
use std::sync::Arc;
use std::path::PathBuf;

/// 创建空的临时项目
pub fn create_empty_opening_project(
    project_name: String,
    event_bus: Arc<EventBus>
) -> CoreResult<ProjectId> {
    log_function_call("create_empty_opening_project", Some(serde_json::json!({
        "project_name": &project_name
    })));
    
    // 验证项目名称
    if project_name.trim().is_empty() {
        return Err(CoreError::ValidationFailed {
            field: "project_name".to_string(),
            reason: "项目名称不能为空".to_string(),
        });
    }
    
    // 创建空的OpeningProject
    let opening_project = OpeningProject::empty(project_name.clone());
    let project_id = opening_project.project.id;
    
    // 存储到全局存储中
    OPENING_PROJECTS.insert(project_id, opening_project)?;
    
    // 发布事件
    event_bus.publish(DomainEvent::OpeningProjectCreated(project_id, project_name));
    
    Logger::info_with_data(
        "成功创建空的临时项目",
        serde_json::json!({
            "project_id": project_id,
        })
    );
    
    Ok(project_id)
}

/// 通过Labelplus内容创建临时项目
pub fn create_opening_project_with_labelplus(
    labelplus_content: String,
    project_name: String,
    event_bus: Arc<EventBus>
) -> CoreResult<ProjectId> {
    log_function_call("create_opening_project_with_labelplus", Some(serde_json::json!({
        "project_name": &project_name,
        "content_size": labelplus_content.len()
    })));
    
    // 验证项目名称
    if project_name.trim().is_empty() {
        return Err(CoreError::ValidationFailed {
            field: "project_name".to_string(),
            reason: "项目名称不能为空".to_string(),
        });
    }
    
    // 创建空的OpeningProject（先不设置required_images）
    let opening_project = OpeningProject::new(project_name.clone(), Vec::new());
    let project_id = opening_project.project.id;
    
    // 存储到全局存储中
    OPENING_PROJECTS.insert(project_id, opening_project)?;
    
    // 发布解析请求事件
    event_bus.publish(DomainEvent::ParseLabelplusRequested(project_id, labelplus_content));
    
    // 发布项目创建事件
    event_bus.publish(DomainEvent::OpeningProjectCreated(project_id, project_name));
    
    Logger::info_with_data(
        "成功创建Labelplus临时项目",
        serde_json::json!({
            "project_id": project_id,
        })
    );
    
    Ok(project_id)
}

/// 通过BF文件创建临时项目（带文件路径）
#[cfg(feature = "tauri")]
pub fn create_opening_project_with_bf_and_path(
    bf_data: Vec<u8>,
    project_name: String,
    file_path: Option<String>,
    event_bus: Arc<EventBus>
) -> CoreResult<ProjectId> {
    log_function_call("create_opening_project_with_bf_and_path", Some(serde_json::json!({
        "project_name": &project_name,
        "data_size": bf_data.len(),
        "file_path": &file_path
    })));
    
    // 验证项目名称
    if project_name.trim().is_empty() {
        return Err(CoreError::ValidationFailed {
            field: "project_name".to_string(),
            reason: "项目名称不能为空".to_string(),
        });
    }
    
    // 创建空的OpeningProject（先不设置required_images）
    let mut opening_project = OpeningProject::new(project_name.clone(), Vec::new());
    let project_id = opening_project.project.id;
    
    // 设置文件路径
    if let Some(path) = file_path {
        opening_project.project.file_path = Some(path);
    }
    
    // 存储到全局存储中
    OPENING_PROJECTS.insert(project_id, opening_project)?;
    
    // 发布解析请求事件
    event_bus.publish(DomainEvent::ParseBfRequested(project_id, bf_data));
    
    // 发布项目创建事件
    event_bus.publish(DomainEvent::OpeningProjectCreated(project_id, project_name));
    
    Logger::info_with_data(
        "成功创建BF临时项目（带路径）",
        serde_json::json!({
            "project_id": project_id,
        })
    );
    
    Ok(project_id)
}

/// 通过BF文件创建临时项目
pub fn create_opening_project_with_bf(
    bf_data: Vec<u8>,
    project_name: String,
    event_bus: Arc<EventBus>
) -> CoreResult<ProjectId> {
    log_function_call("create_opening_project_with_bf", Some(serde_json::json!({
        "project_name": &project_name,
        "data_size": bf_data.len()
    })));
    
    // 验证项目名称
    if project_name.trim().is_empty() {
        return Err(CoreError::ValidationFailed {
            field: "project_name".to_string(),
            reason: "项目名称不能为空".to_string(),
        });
    }
    
    // 创建空的OpeningProject（先不设置required_images）
    let opening_project = OpeningProject::new(project_name.clone(), Vec::new());
    let project_id = opening_project.project.id;
    
    // 存储到全局存储中
    OPENING_PROJECTS.insert(project_id, opening_project)?;
    
    // 发布解析请求事件
    event_bus.publish(DomainEvent::ParseBfRequested(project_id, bf_data));
    
    // 发布项目创建事件
    event_bus.publish(DomainEvent::OpeningProjectCreated(project_id, project_name));
    
    Logger::info_with_data(
        "成功创建BF临时项目",
        serde_json::json!({
            "project_id": project_id,
        })
    );
    
    Ok(project_id)
}

/// 获取临时项目信息
pub fn get_opening_project_info(project_id: ProjectId) -> CoreResult<Option<OpeningProjectDTO>> {
    log_function_call("get_opening_project_info", Some(serde_json::json!({
        "project_id": project_id
    })));
    
    if let Some(opening_project) = OPENING_PROJECTS.get(project_id)? {
        // 根据 required_images 的顺序来整理 uploaded_images
        let uploaded_images: Vec<String> = opening_project.required_images
            .iter()
            .filter(|img| opening_project.uploaded_images.contains_key(*img))
            .cloned()
            .collect();
        
        let info = OpeningProjectDTO {
            project_id,
            project_name: opening_project.project.name.clone(),
            required_images: opening_project.required_images.clone(),
            pending_images: opening_project.pending_images.clone(),
            uploaded_images,
            is_complete: opening_project.is_complete(),
        };
        
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

/// 添加图片到临时项目
pub fn add_image_to_opening_project(
    project_id: ProjectId,
    image_id: ImageId,
    name: Option<String>,
    path: Option<PathBuf>
) -> CoreResult<()> {
    OPENING_PROJECTS.get_mut(project_id, |opening_project| {
        let img_name = name.as_ref().map(|n| n.clone())
            .or_else(|| path.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("image_{}", image_id.0));
        
        if opening_project.is_image_required(&img_name) {
            opening_project.mark_image_uploaded(img_name, image_id);
        }
    })?;
    
    Ok(())
}

/// 清理临时项目的图片
pub fn flush_opening_project_images(project_id: ProjectId) -> CoreResult<bool> {
    log_function_call("flush_opening_project_images", Some(serde_json::json!({
        "project_id": project_id
    })));
    
    Ok(OPENING_PROJECTS.get_mut(project_id, |opening_project| {
        // 获取项目的所有图片ID
        let project_image_ids = &opening_project.project.image_ids;
        
        let mut images_to_remove = Vec::new();
        
        // 检查每个项目图片是否在需要的列表中
        for image_id in project_image_ids.clone() {
            // 获取图片信息
            let images_guard = APP_STATE.images.read().unwrap();
            if let Some(image) = images_guard.get(&image_id) {
                let image_name = image.metadata.name.as_ref()
                    .map(|s| s.as_str())
                    .unwrap_or("");
                    
                if opening_project.is_image_required(image_name) {
                    // 如果图片在需要列表中但还没有被标记为已上传，现在标记
                    if !opening_project.uploaded_images.contains_key(image_name) {
                        opening_project.mark_image_uploaded(image_name.to_string(), image_id);
                        
                        Logger::info_with_data(
                            "标记图片已上传",
                            serde_json::json!({
                                "project_id": project_id,
                                "image_id": image_id,
                                "image_name": image_name
                            })
                        );
                    }
                } else {
                    // 图片不在需要列表中，标记为待删除
                    images_to_remove.push((image_id, image_name.to_string()));
                }
            }
        }
        
        // 删除不需要的图片
        for (image_id, image_name) in &images_to_remove {
            // 从 uploaded_images 中移除
            opening_project.remove_unneeded_image(&image_name);
            
            // 从存储中删除图片
            let _ = crate::storage::image::delete_image_storage(*image_id);
            
            Logger::info_with_data(
                "删除不需要的图片",
                serde_json::json!({
                    "project_id": project_id,
                    "image_id": image_id,
                    "image_name": image_name
                })
            );
        }
        
        true
    })?.unwrap_or(false))
}

/// 将临时项目转为正式项目
pub fn finalize_opening_project(
    project_id: ProjectId,
    event_bus: Arc<EventBus>
) -> CoreResult<bool> {
    log_function_call("finalize_opening_project", Some(serde_json::json!({
        "project_id": project_id
    })));
    
    // 从临时存储中取出项目
    if let Some(mut opening_project) = OPENING_PROJECTS.remove(project_id)? {
        // 检查是否所有需要的图片都已上传
        if !opening_project.is_complete() {
            // 如果没有完成，放回临时存储
            OPENING_PROJECTS.insert(project_id, opening_project)?;
            
            return Err(CoreError::ValidationFailed {
                field: "images".to_string(),
                reason: "还有图片未上传完成".to_string(),
            });
        }
        
        // 准备项目数据
        let project = opening_project.prepare_finalize();
        let image_count = project.image_ids.len();
        let project_name = project.name.clone();
        
        // 将项目添加到正式项目列表
        let mut projects = APP_STATE.projects.write()?;
        projects.insert(project_id, project)?;
        drop(projects);
        
        // 直接导入数据（因为项目已经从OPENING_PROJECTS移除，事件处理器无法访问）
        // 如果有labelplus数据，导入标记
        if let Some(labelplus_data) = opening_project.labelplus_data {
            if let Err(e) = crate::service::io::labelplus::import_labelplus_data_direct(project_id, labelplus_data) {
                Logger::error_with_data(
                    "导入标记数据失败",
                    serde_json::json!({
                        "project_id": project_id,
                        "error": e.to_string()
                    })
                );
            } else {
                Logger::info_with_data(
                    "成功导入标记数据",
                    serde_json::json!({
                        "project_id": project_id
                    })
                );
            }
        }
        
        // 如果有BF数据，导入标记
        if let Some(bf_data) = opening_project.bf_data {
            if let Err(e) = crate::service::io::bf::import_bf_data_direct(project_id, bf_data) {
                Logger::error_with_data(
                    "导入BF标记数据失败",
                    serde_json::json!({
                        "project_id": project_id,
                        "error": e.to_string()
                    })
                );
            } else {
                Logger::info_with_data(
                    "成功导入BF标记数据",
                    serde_json::json!({
                        "project_id": project_id
                    })
                );
            }
        }
        
        // 发布事件
        event_bus.publish(DomainEvent::OpeningProjectFinalized(project_id));
        
        Logger::info_with_data(
            "成功将临时项目转为正式项目",
            serde_json::json!({
                "project_id": project_id,
                "project_name": project_name,
                "image_count": image_count
            })
        );
        
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 删除临时项目
pub fn delete_opening_project(
    project_id: ProjectId,
    event_bus: Arc<EventBus>
) -> CoreResult<bool> {
    log_function_call("delete_opening_project", Some(serde_json::json!({
        "project_id": project_id
    })));
    
    if let Some(opening_project) = OPENING_PROJECTS.remove(project_id)? {
        // 删除所有已上传的图片
        for image_id in opening_project.project.image_ids {
            let _ = crate::storage::image::delete_image_storage(image_id);
        }
        
        // 发布事件
        event_bus.publish(DomainEvent::OpeningProjectDeleted(project_id));
        
        Logger::info_with_data(
            "成功删除临时项目",
            serde_json::json!({
                "project_id": project_id,
                "project_name": opening_project.project.name
            })
        );
        
        Ok(true)
    } else {
        Ok(false)
    }
}