use serde::{Deserialize, Serialize};
use crate::common::{ProjectId, ImageId, Language};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDTO {
    pub id: ProjectId,
    pub name: String,
    #[serde(rename = "imageIds")]
    pub image_ids: Vec<ImageId>,
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(rename = "sourceLanguage", default = "Language::default_source")]
    pub source_language: Language,
    #[serde(rename = "targetLanguage", default = "Language::default_target")]
    pub target_language: Language,
}