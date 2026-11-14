use serde::{Deserialize, Serialize};
use crate::common::{MarkerId, ImageId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MarkerGeometryDTO {
    Point { x: f64, y: f64 },
    Rectangle { x: f64, y: f64, width: f64, height: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MarkerStyleDTO {
    #[serde(rename = "overlayText")]
    pub overlay_text: bool,
    #[serde(rename = "horizontal")]
    pub horizontal: bool,
}

impl Default for MarkerStyleDTO {
    fn default() -> Self {
        Self {
            overlay_text: false,
            horizontal: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerDTO {
    pub id: MarkerId,
    pub image_id: ImageId,
    pub geometry: MarkerGeometryDTO,
    pub translation: String,
    pub style: MarkerStyleDTO,
    #[serde(rename = "imageIndex")]
    pub image_index: u32,
}