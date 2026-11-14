// Opening Project Service - 处理临时项目相关的业务逻辑
use std::sync::Arc;
use std::path::PathBuf;
use crate::service::events::{EventBus};
use crate::common::dto::opening_project::OpeningProjectDTO;
use super::handlers;

pub struct OpeningProjectService {
    event_bus: Arc<EventBus>,
}

impl OpeningProjectService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }
    
    // === 创建临时项目 ===
    
    pub fn create_empty_opening_project(&self, project_name: String) -> Result<u32, String> {
        match handlers::create_empty_opening_project(project_name, self.event_bus.clone()) {
            Ok(project_id) => Ok(project_id.0),
            Err(e) => Err(e.to_string()),
        }
    }
    
    #[cfg(feature = "tauri")]
    pub fn create_opening_project_from_path(&self, path: PathBuf, project_name: String) -> Result<u32, String> {
        // 根据文件扩展名判断文件类型
        let extension = path.extension()
            .and_then(|ext| ext.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        
        match extension.as_str() {
            "bf" => {
                let bf_data = std::fs::read(&path)
                    .map_err(|e| format!("Failed to read BF file: {}", e))?;
                let path_str = path.to_string_lossy().to_string();
                self.create_opening_project_from_bf_with_path(bf_data, project_name, Some(path_str))
            },
            "txt" | "lp" => {
                let labelplus_content = std::fs::read_to_string(&path)
                    .map_err(|e| format!("Failed to read LabelPlus file: {}", e))?;
                self.create_opening_project_from_labelplus(labelplus_content, project_name)
            },
            _ => Err(format!("Unsupported file type: .{}", extension))
        }
    }
    
    pub fn create_opening_project_from_binary(&self, data: Vec<u8>, file_extension: String, project_name: String) -> Result<u32, String> {
        let extension = file_extension.to_lowercase();
        
        match extension.as_str() {
            "bf" => self.create_opening_project_from_bf(data, project_name),
            "txt" | "lp" => {
                let labelplus_content = String::from_utf8(data)
                    .map_err(|e| format!("Invalid UTF-8: {}", e))?;
                self.create_opening_project_from_labelplus(labelplus_content, project_name)
            },
            _ => Err(format!("Unsupported file type: .{}", extension))
        }
    }
    
    fn create_opening_project_from_bf(&self, data: Vec<u8>, project_name: String) -> Result<u32, String> {
        match handlers::create_opening_project_with_bf(data, project_name, self.event_bus.clone()) {
            Ok(project_id) => Ok(project_id.0),
            Err(e) => Err(e.to_string()),
        }
    }
    
    #[cfg(feature = "tauri")]
    fn create_opening_project_from_bf_with_path(&self, data: Vec<u8>, project_name: String, file_path: Option<String>) -> Result<u32, String> {
        match handlers::create_opening_project_with_bf_and_path(data, project_name, file_path, self.event_bus.clone()) {
            Ok(project_id) => Ok(project_id.0),
            Err(e) => Err(e.to_string()),
        }
    }
    
    fn create_opening_project_from_labelplus(&self, content: String, project_name: String) -> Result<u32, String> {
        match handlers::create_opening_project_with_labelplus(content, project_name, self.event_bus.clone()) {
            Ok(project_id) => Ok(project_id.0),
            Err(e) => Err(e.to_string()),
        }
    }
    
    // === 临时项目操作 ===
    
    pub fn get_opening_project_info(&self, project_id: u32) -> Option<OpeningProjectDTO> {
        match handlers::get_opening_project_info(project_id.into()) {
            Ok(info) => info,
            Err(_) => None,
        }
    }
    
    pub fn is_opening_project(&self, project_id: u32) -> bool {
        super::core::OPENING_PROJECTS.exists(project_id.into())
    }
    
    pub fn add_image_to_opening_project(&self, project_id: u32, image_id: u32, name: Option<String>, path: Option<PathBuf>) {
        let _ = handlers::add_image_to_opening_project(
            project_id.into(),
            image_id.into(),
            name,
            path
        );
    }
    
    pub fn flush_opening_project_images(&self, project_id: u32) -> bool {
        match handlers::flush_opening_project_images(project_id.into()) {
            Ok(result) => result,
            Err(_) => false,
        }
    }
    
    pub fn finalize_opening_project(&self, project_id: u32) -> bool {
        match handlers::finalize_opening_project(project_id.into(), self.event_bus.clone()) {
            Ok(result) => result,
            Err(_) => false,
        }
    }
    
    pub fn delete_opening_project(&self, project_id: u32) -> bool {
        match handlers::delete_opening_project(project_id.into(), self.event_bus.clone()) {
            Ok(result) => result,
            Err(_) => false,
        }
    }
}