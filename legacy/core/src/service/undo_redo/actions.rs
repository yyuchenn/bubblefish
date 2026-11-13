// Action types and structures for undo/redo
use crate::common::{CoreResult, ImageId, MarkerId, ProjectId, Language};
use crate::storage::marker::{Marker, MarkerStyle};
use crate::storage::image::Image;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActionType {
    // Project actions
    UpdateProjectName { old_name: String, new_name: String },
    UpdateProjectLanguages { 
        old_source: Language, 
        new_source: Language, 
        old_target: Language, 
        new_target: Language 
    },
    
    // Image actions
    AddImage { 
        image: Image,
        position: usize,  // Position in project's image list
    },
    RemoveImage { 
        image: Image,
        position: usize,  // Original position in project's image list
        markers: Vec<Marker>,  // All markers that were on this image
    },
    ReorderImages { 
        old_order: Vec<ImageId>, 
        new_order: Vec<ImageId> 
    },
    UpdateImage { id: ImageId, old_name: Option<String>, new_name: Option<String> },
    
    // Marker actions
    AddMarker { marker: Marker },
    RemoveMarker { marker: Marker },
    UpdateMarker { 
        id: MarkerId, 
        old_position: (f64, f64),
        new_position: (f64, f64),
        old_translation: String,
        new_translation: String,
        old_style: MarkerStyle,
        new_style: MarkerStyle,
    },
    UpdatePointMarkerPosition { id: MarkerId, old_pos: (f64, f64), new_pos: (f64, f64) },
    UpdateRectangleGeometry { 
        id: MarkerId, 
        old_geometry: (f64, f64, f64, f64),  // (x, y, width, height)
        new_geometry: (f64, f64, f64, f64)   // (x, y, width, height)
    },
    UpdateMarkerTranslation { id: MarkerId, old_trans: String, new_trans: String },
    UpdateMarkerStyle { id: MarkerId, old_style: MarkerStyle, new_style: MarkerStyle },
    UpdateMarkerOrder { id: MarkerId, image_id: ImageId, old_index: u32, new_index: u32 },
    
    // Batch operations
    ClearImageMarkers { image_id: ImageId, markers: Vec<Marker> },
    
    // Marker type conversions
    ConvertRectangleToPoint { 
        marker_id: MarkerId,
        old_marker: Marker,
        new_marker: Marker,
    },
    ConvertPointToRectangle {
        marker_id: MarkerId,
        old_marker: Marker,
        new_marker: Marker,
    },
}

impl ActionType {
    /// Get the string name of the action type for display purposes
    pub fn get_action_name(&self) -> &'static str {
        match self {
            ActionType::UpdateProjectName { .. } => "UpdateProjectName",
            ActionType::UpdateProjectLanguages { .. } => "UpdateProjectLanguages",
            ActionType::AddImage { .. } => "AddImage",
            ActionType::RemoveImage { .. } => "RemoveImage",
            ActionType::ReorderImages { .. } => "ReorderImages",
            ActionType::UpdateImage { .. } => "UpdateImage",
            ActionType::AddMarker { .. } => "AddMarker",
            ActionType::RemoveMarker { .. } => "RemoveMarker",
            ActionType::UpdateMarker { .. } => "UpdateMarker",
            ActionType::UpdatePointMarkerPosition { .. } => "UpdatePointMarkerPosition",
            ActionType::UpdateRectangleGeometry { .. } => "UpdateRectangleGeometry",
            ActionType::UpdateMarkerTranslation { .. } => "UpdateMarkerTranslation",
            ActionType::UpdateMarkerStyle { .. } => "UpdateMarkerStyle",
            ActionType::UpdateMarkerOrder { .. } => "UpdateMarkerOrder",
            ActionType::ClearImageMarkers { .. } => "ClearImageMarkers",
            ActionType::ConvertRectangleToPoint { .. } => "ConvertRectangleToPoint",
            ActionType::ConvertPointToRectangle { .. } => "ConvertPointToRectangle",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoRedoAction {
    pub id: Uuid,
    pub action_type: ActionType,
    pub project_id: ProjectId,
    #[cfg(not(target_arch = "wasm32"))]
    pub timestamp: u64,
}

impl UndoRedoAction {
    pub fn new(action_type: ActionType, project_id: ProjectId) -> Self {
        Self {
            id: Uuid::new_v4(),
            action_type,
            project_id,
            #[cfg(not(target_arch = "wasm32"))]
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
    
    pub fn with_id(id: Uuid, action_type: ActionType, project_id: ProjectId) -> Self {
        Self {
            id,
            action_type,
            project_id,
            #[cfg(not(target_arch = "wasm32"))]
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }

    /// Get the location (image_id, marker_id) affected by this action
    pub fn get_affected_location(&self) -> (Option<ImageId>, Option<MarkerId>) {
        match &self.action_type {
            ActionType::UpdateProjectName { .. } | ActionType::UpdateProjectLanguages { .. } => {
                // Project metadata changes don't affect specific images or markers
                (None, None)
            }
            ActionType::AddImage { image, .. } => {
                (Some(image.metadata.id), None)
            }
            ActionType::RemoveImage { image, .. } => {
                (Some(image.metadata.id), None)
            }
            ActionType::ReorderImages { .. } => {
                // Reordering affects multiple images, not a specific one
                (None, None)
            }
            ActionType::UpdateImage { id, .. } => {
                (Some(*id), None)
            }
            ActionType::AddMarker { marker } | ActionType::RemoveMarker { marker } => {
                (Some(marker.image_id), Some(marker.id))
            }
            ActionType::UpdateMarker { id, .. } | ActionType::UpdatePointMarkerPosition { id, .. }
            | ActionType::UpdateRectangleGeometry { id, .. }
            | ActionType::UpdateMarkerTranslation { id, .. } | ActionType::UpdateMarkerStyle { id, .. }
            | ActionType::UpdateMarkerOrder { id, .. } => {
                // We need to get the image_id from the marker
                let services = crate::service::get_service();
                if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                    (Some(marker.image_id), Some(*id))
                } else {
                    (None, Some(*id))
                }
            }
            ActionType::ClearImageMarkers { image_id, .. } => {
                (Some(*image_id), None)
            }
            ActionType::ConvertRectangleToPoint { old_marker, .. } | 
            ActionType::ConvertPointToRectangle { old_marker, .. } => {
                (Some(old_marker.image_id), Some(old_marker.id))
            }
        }
    }
    
    /// Get the project_id from the action by looking up which project contains the affected image
    pub fn get_project_id_from_action(action_type: &ActionType) -> CoreResult<Option<ProjectId>> {
        let image_id = match action_type {
            ActionType::UpdateProjectName { .. } | ActionType::UpdateProjectLanguages { .. } => {
                // Project metadata changes don't have an associated image_id
                // The project_id should be provided when creating the action
                return Ok(None);
            }
            ActionType::AddImage { image, .. } => {
                Some(image.metadata.id)
            }
            ActionType::RemoveImage { image, .. } => {
                Some(image.metadata.id)
            }
            ActionType::ReorderImages { .. } => {
                // Reordering doesn't affect a specific image, project_id should be provided
                return Ok(None);
            }
            ActionType::UpdateImage { id, .. } => {
                Some(*id)
            }
            ActionType::AddMarker { marker } | ActionType::RemoveMarker { marker } => {
                Some(marker.image_id)
            }
            ActionType::UpdateMarker { id, .. } | ActionType::UpdatePointMarkerPosition { id, .. }
            | ActionType::UpdateRectangleGeometry { id, .. }
            | ActionType::UpdateMarkerTranslation { id, .. } | ActionType::UpdateMarkerStyle { id, .. }
            | ActionType::UpdateMarkerOrder { id, .. } => {
                // We need to get the image_id from the marker
                let services = crate::service::get_service();
                if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                    Some(marker.image_id)
                } else {
                    None
                }
            }
            ActionType::ClearImageMarkers { image_id, .. } => {
                Some(*image_id)
            }
            ActionType::ConvertRectangleToPoint { old_marker, .. } | 
            ActionType::ConvertPointToRectangle { old_marker, .. } => {
                Some(old_marker.image_id)
            }
        };
        
        if let Some(image_id) = image_id {
            let services = crate::service::get_service();
            services.project_service.find_project_by_image(image_id)
        } else {
            Ok(None)
        }
    }
}