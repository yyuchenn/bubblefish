use serde::{Deserialize, Serialize};
use crate::common::ProjectId;

/// 临时项目信息DTO
#[derive(Debug, Serialize, Deserialize)]
pub struct OpeningProjectDTO {
    #[serde(rename = "projectId")]
    pub project_id: ProjectId,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(rename = "requiredImages")]
    pub required_images: Vec<String>,
    #[serde(rename = "pendingImages")]
    pub pending_images: Vec<String>,
    #[serde(rename = "uploadedImages")]
    pub uploaded_images: Vec<String>,
    #[serde(rename = "isComplete")]
    pub is_complete: bool,
}