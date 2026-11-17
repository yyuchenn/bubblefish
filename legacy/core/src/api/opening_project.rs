// This file contains the opening project API functions
use crate::common::{Logger, log_function_call};
use crate::common::dto::opening_project::OpeningProjectDTO;
use crate::service::get_service;
#[cfg(feature = "tauri")]
use std::path::PathBuf;

/// 创建空的临时项目（用于新建项目）
pub fn create_empty_opening_project(project_name: String) -> Result<u32, String> {
    log_function_call("create_empty_opening_project", Some(serde_json::json!({
        "project_name": &project_name
    })));
    
    let service = get_service();
    let result = service.opening_project_service.create_empty_opening_project(project_name);
    
    if let Err(ref e) = result {
        Logger::error_with_data(
            "创建空临时项目失败",
            serde_json::json!({"error": e})
        );
    }
    
    result
}

/// 通过文件路径创建临时项目（自动检测文件类型）
#[cfg(feature = "tauri")]
pub fn create_opening_project_from_path(path: PathBuf, project_name: String) -> Result<u32, String> {
    log_function_call("create_opening_project_from_path", Some(serde_json::json!({
        "project_name": &project_name,
        "path": path.to_string_lossy()
    })));
    
    let service = get_service();
    let result = service.opening_project_service.create_opening_project_from_path(path, project_name);
    
    if let Err(ref e) = result {
        Logger::error_with_data(
            "创建临时项目失败",
            serde_json::json!({"error": e})
        );
    }
    
    result
}

/// 通过二进制数据创建临时项目（需要提供文件扩展名）
pub fn create_opening_project_from_binary(data: Vec<u8>, file_extension: String, project_name: String) -> Result<u32, String> {
    log_function_call("create_opening_project_from_binary", Some(serde_json::json!({
        "project_name": &project_name,
        "file_extension": &file_extension,
        "data_size": data.len()
    })));
    
    let service = get_service();
    let result = service.opening_project_service.create_opening_project_from_binary(data, file_extension, project_name);
    
    if let Err(ref e) = result {
        Logger::error_with_data(
            "创建临时项目失败",
            serde_json::json!({"error": e})
        );
    }
    
    result
}

/// 获取临时项目信息
pub fn get_opening_project_info(project_id: u32) -> Option<OpeningProjectDTO> {
    log_function_call("get_opening_project_info", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    service.opening_project_service.get_opening_project_info(project_id)
}

/// 刷新临时项目的图片
pub fn flush_opening_project_images(project_id: u32) -> bool {
    log_function_call("flush_opening_project_images", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    service.opening_project_service.flush_opening_project_images(project_id)
}

/// 将临时项目转为正式项目
pub fn finalize_opening_project(project_id: u32) -> bool {
    log_function_call("finalize_opening_project", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    service.opening_project_service.finalize_opening_project(project_id)
}

/// 删除临时项目
pub fn delete_opening_project(project_id: u32) -> bool {
    log_function_call("delete_opening_project", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    service.opening_project_service.delete_opening_project(project_id)
}