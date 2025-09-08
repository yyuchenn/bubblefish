// IO 模块的事件处理器
use crate::service::events::{DomainEvent, EventHandler};
use crate::service::opening_project::OPENING_PROJECTS;
use crate::common::{ProjectId, Logger};
use super::labelplus::parse_labelplus_file;
use super::bf::parse_bf_file;

pub struct IoEventHandler;

impl IoEventHandler {
    pub fn new(_event_bus: std::sync::Arc<crate::service::events::EventBus>) -> Self {
        Self
    }
}

impl EventHandler for IoEventHandler {
    fn handle(&self, event: &DomainEvent) {
        match event {
            DomainEvent::ParseLabelplusRequested(project_id, content) => {
                handle_parse_labelplus(*project_id, content.clone());
            },
            DomainEvent::ParseBfRequested(project_id, data) => {
                handle_parse_bf(*project_id, data.clone());
            },
            _ => {} // 忽略其他事件
        }
    }
}

fn handle_parse_labelplus(project_id: ProjectId, content: String) {
    Logger::info_with_data(
        "开始解析Labelplus文件",
        serde_json::json!({
            "project_id": project_id,
            "content_size": content.len()
        })
    );
    
    match parse_labelplus_file(&content) {
        Ok(mut labelplus_data) => {
            // 去除重复的图片
            let mut seen_images = std::collections::HashSet::new();
            let mut unique_images: Vec<String> = Vec::new();
            let mut duplicate_count = 0;
            
            for img_name in labelplus_data.image_order {
                if seen_images.insert(img_name.clone()) {
                    unique_images.push(img_name);
                } else {
                    duplicate_count += 1;
                    Logger::warn_with_data(
                        "忽略重复的图片文件",
                        serde_json::json!({
                            "project_id": project_id,
                            "filename": img_name
                        })
                    );
                }
            }
            
            if duplicate_count > 0 {
                Logger::info_with_data(
                    "发现并忽略了重复的图片文件",
                    serde_json::json!({
                        "project_id": project_id,
                        "duplicate_count": duplicate_count,
                        "unique_images": unique_images.len()
                    })
                );
            }
            
            // 更新labelplus_data的image_order为去重后的列表
            labelplus_data.image_order = unique_images.clone();
            
            // 将解析结果存储到临时项目中
            let _ = OPENING_PROJECTS.get_mut(project_id, |opening_project| {
                opening_project.labelplus_data = Some(labelplus_data.clone());
                
                // 更新 required_images
                opening_project.required_images = unique_images.clone();
                opening_project.pending_images = unique_images;
            });
            
            Logger::info_with_data(
                "Labelplus文件解析成功",
                serde_json::json!({
                    "project_id": project_id,
                    "image_count": labelplus_data.image_order.len()
                })
            );
        },
        Err(e) => {
            Logger::error_with_data(
                "Labelplus文件解析失败",
                serde_json::json!({
                    "project_id": project_id,
                    "error": e.to_string()
                })
            );
        }
    }
}

fn handle_parse_bf(project_id: ProjectId, data: Vec<u8>) {
    Logger::info_with_data(
        "开始解析BF文件",
        serde_json::json!({
            "project_id": project_id,
            "data_size": data.len()
        })
    );
    
    match parse_bf_file(&data) {
        Ok(bf_data) => {
            // 将解析结果存储到临时项目中
            let _ = OPENING_PROJECTS.get_mut(project_id, |opening_project| {
                // 从BF文件的images列表构建需要的图片列表，去除重复项
                let mut seen_images = std::collections::HashSet::new();
                let mut required_images: Vec<String> = Vec::new();
                let mut duplicate_count = 0;
                
                for img in &bf_data.images {
                    let filename = img.filename.clone();
                    if seen_images.insert(filename.clone()) {
                        // 只有当成功插入到集合中（即不重复）时才添加到列表
                        required_images.push(filename);
                    } else {
                        duplicate_count += 1;
                        Logger::warn_with_data(
                            "忽略重复的图片文件",
                            serde_json::json!({
                                "project_id": project_id,
                                "filename": filename
                            })
                        );
                    }
                }
                
                if duplicate_count > 0 {
                    Logger::info_with_data(
                        "发现并忽略了重复的图片文件",
                        serde_json::json!({
                            "project_id": project_id,
                            "duplicate_count": duplicate_count,
                            "unique_images": required_images.len()
                        })
                    );
                }
                
                // 使用BF文件中的项目名称更新项目
                opening_project.project.name = bf_data.metadata.project_name.clone();
                
                // 如果BF文件包含语言信息，更新项目语言设置
                if let Some(source_lang) = bf_data.metadata.source_language {
                    opening_project.project.source_language = source_lang;
                }
                if let Some(target_lang) = bf_data.metadata.target_language {
                    opening_project.project.target_language = target_lang;
                }
                
                opening_project.bf_data = Some(bf_data);
                opening_project.required_images = required_images.clone();
                opening_project.pending_images = required_images;
            });
            
            Logger::info_with_data(
                "BF文件解析成功",
                serde_json::json!({
                    "project_id": project_id
                })
            );
        },
        Err(e) => {
            Logger::error_with_data(
                "BF文件解析失败",
                serde_json::json!({
                    "project_id": project_id,
                    "error": e.to_string()
                })
            );
        }
    }
}