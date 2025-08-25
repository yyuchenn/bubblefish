use crate::common::CoreResult;
use crate::common::{MarkerId, ImageId};
use crate::common::dto::marker::{MarkerDTO, MarkerStyleDTO, MarkerGeometryDTO};
use crate::storage::traits::Storage;
use crate::storage::state::{APP_STATE, MarkerStorage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MarkerGeometry {
    Point { x: f64, y: f64 },
    Rectangle { x: f64, y: f64, width: f64, height: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MarkerStyle {
    #[serde(rename = "overlayText")]
    pub overlay_text: bool,
    #[serde(rename = "horizontal")]
    pub horizontal: bool,
}

impl Default for MarkerStyle {
    fn default() -> Self {
        Self {
            overlay_text: false,
            horizontal: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: MarkerId,
    pub image_id: ImageId,
    pub geometry: MarkerGeometry,
    pub translation: String,
    pub style: MarkerStyle,
    #[serde(rename = "imageIndex")]
    pub image_index: u32,
}

impl Marker {
    pub fn new_point(id: MarkerId, image_id: ImageId, x: f64, y: f64, image_index: u32) -> Self {
        Self {
            id,
            image_id,
            geometry: MarkerGeometry::Point { x, y },
            translation: String::new(),
            style: MarkerStyle::default(),
            image_index,
        }
    }

    pub fn new_rectangle(id: MarkerId, image_id: ImageId, x: f64, y: f64, width: f64, height: f64, image_index: u32) -> Self {
        Self {
            id,
            image_id,
            geometry: MarkerGeometry::Rectangle { x, y, width, height },
            translation: String::new(),
            style: MarkerStyle::default(),
            image_index,
        }
    }

    pub fn point_with_translation(id: MarkerId, image_id: ImageId, x: f64, y: f64, translation: String, image_index: u32) -> Self {
        Self {
            id,
            image_id,
            geometry: MarkerGeometry::Point { x, y },
            translation,
            style: MarkerStyle::default(),
            image_index,
        }
    }

    pub fn rectangle_with_translation(id: MarkerId, image_id: ImageId, x: f64, y: f64, width: f64, height: f64, translation: String, image_index: u32) -> Self {
        Self {
            id,
            image_id,
            geometry: MarkerGeometry::Rectangle { x, y, width, height },
            translation,
            style: MarkerStyle::default(),
            image_index,
        }
    }

    pub fn to_dto(&self) -> MarkerDTO {
        MarkerDTO {
            id: self.id,
            image_id: self.image_id,
            geometry: match &self.geometry {
                MarkerGeometry::Point { x, y } => MarkerGeometryDTO::Point { x: *x, y: *y },
                MarkerGeometry::Rectangle { x, y, width, height } => {
                    MarkerGeometryDTO::Rectangle { x: *x, y: *y, width: *width, height: *height }
                }
            },
            translation: self.translation.clone(),
            style: MarkerStyleDTO {
                overlay_text: self.style.overlay_text,
                horizontal: self.style.horizontal,
            },
            image_index: self.image_index,
        }
    }

    pub fn from_dto(dto: MarkerDTO) -> Self {
        Self {
            id: dto.id,
            image_id: dto.image_id,
            geometry: match dto.geometry {
                MarkerGeometryDTO::Point { x, y } => MarkerGeometry::Point { x, y },
                MarkerGeometryDTO::Rectangle { x, y, width, height } => {
                    MarkerGeometry::Rectangle { x, y, width, height }
                }
            },
            translation: dto.translation,
            style: MarkerStyle {
                overlay_text: dto.style.overlay_text,
                horizontal: dto.style.horizontal,
            },
            image_index: dto.image_index,
        }
    }
}

// Basic storage operations for markers (no business logic)
pub fn get_marker_storage(id: MarkerId) -> CoreResult<Option<Marker>> {
    let storage = APP_STATE.markers.read()?;
    Ok(storage.get(&id).cloned())
}

pub fn get_image_markers_storage(image_id: ImageId) -> CoreResult<Vec<Marker>> {
    let storage = APP_STATE.markers.read()?;
    Ok(storage.get_by_image(&image_id).into_iter().cloned().collect())
}

pub fn update_marker_geometry_storage(id: MarkerId, geometry: MarkerGeometry) -> CoreResult<(bool, Option<ImageId>)> {
    let mut storage = APP_STATE.markers.write()?;
    if let Some(marker) = storage.get_mut(&id) {
        let image_id = marker.image_id;
        marker.geometry = geometry;
        Ok((true, Some(image_id)))
    } else {
        Ok((false, None))
    }
}

pub fn update_marker_translation_storage(id: MarkerId, translation: String) -> CoreResult<(bool, Option<ImageId>)> {
    let mut storage = APP_STATE.markers.write()?;
    if let Some(marker) = storage.get_mut(&id) {
        let image_id = marker.image_id;
        marker.translation = translation;
        Ok((true, Some(image_id)))
    } else {
        Ok((false, None))
    }
}

pub fn update_marker_style_storage(id: MarkerId, style: MarkerStyle) -> CoreResult<(bool, Option<ImageId>)> {
    let mut storage = APP_STATE.markers.write()?;
    if let Some(marker) = storage.get_mut(&id) {
        let image_id = marker.image_id;
        marker.style = style;
        Ok((true, Some(image_id)))
    } else {
        Ok((false, None))
    }
}

pub fn update_marker_storage(id: MarkerId, geometry: MarkerGeometry, translation: String, style: MarkerStyle) -> CoreResult<(bool, Option<ImageId>)> {
    let mut storage = APP_STATE.markers.write()?;
    if let Some(marker) = storage.get_mut(&id) {
        let image_id = marker.image_id;
        marker.geometry = geometry;
        marker.translation = translation;
        marker.style = style;
        Ok((true, Some(image_id)))
    } else {
        Ok((false, None))
    }
}

pub fn clear_all_markers_storage() -> CoreResult<()> {
    let mut storage = APP_STATE.markers.write()?;
    storage.clear();
    Ok(())
}

pub fn marker_count_storage() -> CoreResult<usize> {
    let storage = APP_STATE.markers.read()?;
    Ok(storage.iter().count())
}

pub fn marker_exists_storage(id: MarkerId) -> CoreResult<bool> {
    let storage = APP_STATE.markers.read()?;
    Ok(storage.contains(&id))
}

// Helper function to insert marker at specific index and adjust others
pub fn insert_marker_at_index(storage: &mut MarkerStorage, marker: Marker) -> CoreResult<()> {
    let image_id = marker.image_id;
    let target_index = marker.image_index;
    
    // First, adjust image_index for markers that should come after the inserted marker
    if let Some(marker_ids) = storage.by_image.get(&image_id).cloned() {
        for marker_id in marker_ids {
            if let Some(existing_marker) = storage.markers.get_mut(&marker_id) {
                if existing_marker.image_index >= target_index {
                    existing_marker.image_index += 1;
                }
            }
        }
    }
    
    // Then insert the marker with its original index
    storage.insert_with_image(marker)?;
    
    Ok(())
}

// Helper function to renumber markers after deletion
pub fn renumber_image_markers(storage: &mut MarkerStorage, image_id: ImageId) -> CoreResult<()> {
    // Get all marker IDs for this image
    if let Some(marker_ids) = storage.by_image.get(&image_id).cloned() {
        // Sort markers by their current image_index
        let mut markers_with_index: Vec<(MarkerId, u32)> = marker_ids
            .iter()
            .filter_map(|&id| {
                storage.markers.get(&id).map(|m| (id, m.image_index))
            })
            .collect();
        
        // Sort by current image_index
        markers_with_index.sort_by_key(|&(_, index)| index);
        
        // Renumber them sequentially starting from 1
        for (new_index, (marker_id, _)) in markers_with_index.into_iter().enumerate() {
            if let Some(marker) = storage.markers.get_mut(&marker_id) {
                marker.image_index = (new_index + 1) as u32;
            }
        }
    }
    
    Ok(())
}