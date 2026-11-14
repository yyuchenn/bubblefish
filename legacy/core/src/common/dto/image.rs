use serde::{Deserialize, Serialize};
use crate::common::{ImageId, MarkerId};
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageMetadataDTO {
    pub id: ImageId,
    pub name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<ImageFormat>,
    pub size: Option<u64>,
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImageDataDTO {
    FilePath(PathBuf),
    Binary { format: ImageFormat, data: Arc<Vec<u8>> },
    SharedBuffer { format: ImageFormat, buffer_id: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDTO {
    pub metadata: ImageMetadataDTO,
    pub data: ImageDataDTO,
    pub marker_ids: Vec<MarkerId>,
}