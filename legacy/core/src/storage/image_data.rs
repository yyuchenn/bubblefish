use crate::common::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ImageFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
}

impl ImageFormat {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            "bmp" => Some(Self::Bmp),
            _ => None,
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
        }
    }

    pub fn to_image_format(&self) -> image::ImageFormat {
        match self {
            Self::Jpeg => image::ImageFormat::Jpeg,
            Self::Png => image::ImageFormat::Png,
            Self::Gif => image::ImageFormat::Gif,
            Self::Webp => image::ImageFormat::WebP,
            Self::Bmp => image::ImageFormat::Bmp,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImageData {
    FilePath(PathBuf),
    Binary { format: ImageFormat, data: Arc<Vec<u8>> },
    SharedBuffer { format: ImageFormat, buffer_id: u32 },
}

impl ImageData {
    pub fn get_format(&self) -> Option<ImageFormat> {
        match self {
            ImageData::Binary { format, .. } => Some(*format),
            ImageData::SharedBuffer { format, .. } => Some(*format),
            ImageData::FilePath(path) => {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .and_then(ImageFormat::from_extension)
            },
        }
    }

    pub fn read_data(&self) -> CoreResult<Vec<u8>> {
        match self {
            ImageData::Binary { data, .. } => Ok((**data).clone()),
            ImageData::FilePath(path) => std::fs::read(path)
                .map_err(|e| CoreError::IoError(format!("Failed to read file: {}", e))),
            ImageData::SharedBuffer { .. } => Err(CoreError::PlatformError(
                "Reading SharedArrayBuffer data not supported in sync context".to_string()
            )),
        }
    }

    pub fn get_data(&self) -> Option<&Vec<u8>> {
        match self {
            ImageData::Binary { data, .. } => Some(data.as_ref()),
            _ => None,
        }
    }

    pub fn get_size(&self) -> Option<u64> {
        match self {
            ImageData::Binary { data, .. } => Some(data.len() as u64),
            ImageData::FilePath(path) => {
                std::fs::metadata(path).ok().map(|m| m.len())
            },
            ImageData::SharedBuffer { .. } => None,
        }
    }

    pub fn get_dimensions(&self) -> Option<(u32, u32)> {
        match self {
            ImageData::Binary { data, format } => {
                crate::storage::dimension_extractor::extract_dimensions_from_bytes(data, format)
            },
            ImageData::FilePath(path) => {
                if let Ok(data) = std::fs::read(path) {
                    if let Some(format) = self.get_format() {
                        crate::storage::dimension_extractor::extract_dimensions_from_bytes(&data, &format)
                    } else {
                        None
                    }
                } else {
                    None
                }
            },
            ImageData::SharedBuffer { .. } => None,
        }
    }
}