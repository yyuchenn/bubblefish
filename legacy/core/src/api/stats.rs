use serde::{Deserialize, Serialize};
use crate::common::log_function_call;
use crate::service::get_service;

/// 获取项目统计信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectStats {
    #[serde(rename = "projectCount")]
    pub project_count: usize,
    #[serde(rename = "imageCount")]
    pub image_count: usize,
    #[serde(rename = "markerCount")]
    pub marker_count: usize,
}

pub fn get_stats() -> ProjectStats {
    log_function_call("get_stats", None);
    
    let service = get_service();
    service.stats_service.get_overall_stats()
}

/// 获取特定项目的统计信息
#[derive(Debug, Serialize, Deserialize)]
pub struct SingleProjectStats {
    #[serde(rename = "imageCount")]
    pub image_count: usize,
    #[serde(rename = "markerCount")]
    pub marker_count: usize,
}

pub fn get_project_stats(project_id: u32) -> Option<SingleProjectStats> {
    log_function_call("get_project_stats", Some(serde_json::json!({"project_id": project_id})));
    
    let service = get_service();
    service.stats_service.get_project_stats(project_id)
}