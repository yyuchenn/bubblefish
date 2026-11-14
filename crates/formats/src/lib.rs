//! Filesystem-independent legacy format boundary. Import produces missing-image metadata;
//! runtime adapters resolve the corresponding assets before installing the document.
mod bf;
mod labelplus;
pub mod richtext;

use bubblefish_core::{CoreError, ProjectDocument};
use serde::{Deserialize, Serialize};

/// Both formats deliberately retain their legacy wire representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Bf,
    Labelplus,
}

impl Format {
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "bf" => Some(Self::Bf),
            "txt" | "lp" => Some(Self::Labelplus),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub document: ProjectDocument,
    pub warnings: Vec<String>,
    pub force_save_as: bool,
}

pub const MAX_IMPORT_BYTES: usize = 64 * 1024 * 1024;

pub fn import_project(
    bytes: &[u8],
    format: Format,
    project_id: String,
) -> Result<ImportResult, CoreError> {
    if project_id.trim().is_empty() {
        return Err(invalid("Project ID cannot be empty"));
    }
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(invalid("Project exceeds the 64 MiB import limit"));
    }
    let result = match format {
        Format::Bf => bf::import(bytes, project_id),
        Format::Labelplus => labelplus::import(bytes, project_id),
    }?;
    bubblefish_core::validate_document(&result.document)?;
    Ok(result)
}

pub fn export_project(document: &ProjectDocument, format: Format) -> Result<Vec<u8>, CoreError> {
    bubblefish_core::validate_document(document)?;
    match format {
        Format::Bf => bf::export(document),
        Format::Labelplus => labelplus::export(document),
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new("invalidFormat", message)
}

fn cannot_export(message: impl Into<String>) -> CoreError {
    CoreError::new("unrepresentableText", message)
}

fn page_id(project_id: &str, page: usize) -> String {
    format!("{project_id}:image:{page}")
}

fn marker_id(project_id: &str, page: usize, marker: usize) -> String {
    format!("{project_id}:image:{page}:marker:{marker}")
}
