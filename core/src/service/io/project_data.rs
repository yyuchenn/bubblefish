use crate::common::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ProjectFormat {
    Labelplus,
    Bubblefish,
}

impl ProjectFormat {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "txt" | "lp" => Some(Self::Labelplus),
            "bf" => Some(Self::Bubblefish),
            _ => None,
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self {
            Self::Labelplus => "text/plain",
            Self::Bubblefish => "application/gzip",
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Labelplus => "txt",
            Self::Bubblefish => "bf",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProjectData {
    FilePath(PathBuf),
    Binary { format: ProjectFormat, data: Arc<Vec<u8>> },
    SharedBuffer { format: ProjectFormat, buffer_id: u32 },
}

impl ProjectData {
    pub fn get_format(&self) -> ProjectFormat {
        match self {
            ProjectData::Binary { format, .. } => *format,
            ProjectData::SharedBuffer { format, .. } => *format,
            ProjectData::FilePath(path) => {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .and_then(ProjectFormat::from_extension)
                    .unwrap_or(ProjectFormat::Labelplus)
            },
        }
    }

    pub fn read_data(&self) -> CoreResult<Vec<u8>> {
        match self {
            ProjectData::Binary { data, .. } => Ok((**data).clone()),
            ProjectData::FilePath(path) => std::fs::read(path)
                .map_err(|e| CoreError::IoError(format!("Failed to read file: {}", e))),
            ProjectData::SharedBuffer { .. } => Err(CoreError::PlatformError(
                "Reading SharedArrayBuffer data not supported in sync context".to_string()
            )),
        }
    }

    pub fn read_text(&self) -> CoreResult<String> {
        let data = self.read_data()?;
        String::from_utf8(data)
            .map_err(|e| CoreError::SerializationError(format!("Invalid UTF-8: {}", e)))
    }

    pub fn get_data(&self) -> Option<&Vec<u8>> {
        match self {
            ProjectData::Binary { data, .. } => Some(data.as_ref()),
            _ => None,
        }
    }

    pub fn get_size(&self) -> Option<u64> {
        match self {
            ProjectData::Binary { data, .. } => Some(data.len() as u64),
            ProjectData::FilePath(path) => {
                std::fs::metadata(path).ok().map(|m| m.len())
            },
            ProjectData::SharedBuffer { .. } => None,
        }
    }

    pub fn estimated_size(&self) -> usize {
        match self {
            ProjectData::Binary { data, .. } => data.len(),
            ProjectData::FilePath(path) => {
                std::fs::metadata(path)
                    .map(|m| m.len() as usize)
                    .unwrap_or(0)
            },
            ProjectData::SharedBuffer { .. } => 0,
        }
    }
}