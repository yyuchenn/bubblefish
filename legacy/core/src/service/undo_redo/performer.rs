// Performer module for executing undo/redo operations
use crate::common::{CoreResult, EVENT_SYSTEM};
use crate::storage::state::APP_STATE;
use crate::storage::marker::{self, MarkerGeometry};
use crate::storage::traits::Storage;
use super::actions::{ActionType, UndoRedoAction};

pub fn perform_undo(action: &UndoRedoAction) -> CoreResult<UndoRedoAction> {
    match &action.action_type {
        ActionType::UpdateProjectName { old_name, new_name } => {
            // Undo project name change by restoring old name
            let services = crate::service::get_service();
            services.project_service.update_project_name_core(action.project_id, old_name.clone())?;
            
            // 发送项目名称更新事件到前端，通知更新UI
            let _ = EVENT_SYSTEM.emit_business_event(
                "ProjectNameUpdated".to_string(),
                serde_json::json!({
                    "project_id": action.project_id.0,
                    "name": old_name.clone()
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateProjectName {
                old_name: new_name.clone(),
                new_name: old_name.clone(),
            }, action.project_id))
        }
        ActionType::UpdateProjectLanguages { old_source, new_source, old_target, new_target } => {
            // Undo language change by restoring old languages
            let services = crate::service::get_service();
            services.project_service.update_project_languages_core(action.project_id, *old_source, *old_target)?;
            
            // 发送语言更新事件到前端，通知更新UI
            let _ = EVENT_SYSTEM.emit_business_event(
                "ProjectLanguagesUpdated".to_string(),
                serde_json::json!({
                    "project_id": action.project_id.0,
                    "source_language": old_source,
                    "target_language": old_target
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateProjectLanguages {
                old_source: *new_source,
                new_source: *old_source,
                old_target: *new_target,
                new_target: *old_target,
            }, action.project_id))
        }
        ActionType::AddMarker { marker } => {
            // Undo add by removing
            let services = crate::service::get_service();
            services.marker_service.remove_marker_with_undo(marker.id)?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::RemoveMarker { marker: marker.clone() }, action.project_id))
        }
        ActionType::RemoveMarker { marker } => {
            // Undo remove by adding back with correct index
            let mut storage = APP_STATE.markers.write()?;
            marker::insert_marker_at_index(&mut storage, marker.clone())?;
            drop(storage);
            
            crate::storage::image::add_marker_to_image_storage(marker.image_id, marker.id)?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::AddMarker { marker: marker.clone() }, action.project_id))
        }
        ActionType::UpdateMarker { id, old_position, old_translation, old_style, .. } => {
            let services = crate::service::get_service();
            let current_marker = crate::storage::marker::get_marker_storage(*id)?.unwrap();
            
            // Get current position from geometry
            let current_pos = match &current_marker.geometry {
                MarkerGeometry::Point { x, y } => (*x, *y),
                MarkerGeometry::Rectangle { x, y, .. } => (*x, *y),
            };
            
            // Update based on marker type
            match current_marker.geometry {
                MarkerGeometry::Point { .. } => {
                    services.marker_service.update_point_marker_with_undo(*id, old_position.0, old_position.1, old_translation.clone(), old_style.clone())?;
                }
                MarkerGeometry::Rectangle { width, height, .. } => {
                    services.marker_service.update_rectangle_marker_with_undo(*id, old_position.0, old_position.1, width, height, old_translation.clone(), old_style.clone())?;
                }
            }
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateMarker {
                id: *id,
                old_position: current_pos,
                new_position: *old_position,
                old_translation: current_marker.translation,
                new_translation: old_translation.clone(),
                old_style: current_marker.style,
                new_style: old_style.clone(),
            }, action.project_id))
        }
        ActionType::UpdatePointMarkerPosition { id, old_pos, new_pos } => {
            let services = crate::service::get_service();
            
            // Check marker type to call appropriate update method
            let current_marker = crate::storage::marker::get_marker_storage(*id)?.unwrap();
            match current_marker.geometry {
                MarkerGeometry::Point { .. } => {
                    services.marker_service.update_point_marker_position_with_undo(*id, old_pos.0, old_pos.1)?;
                }
                MarkerGeometry::Rectangle { width, height, .. } => {
                    services.marker_service.update_rectangle_marker_geometry_with_undo(*id, old_pos.0, old_pos.1, width, height)?;
                }
            }
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdatePointMarkerPosition {
                id: *id,
                old_pos: *new_pos,
                new_pos: *old_pos,
            }, action.project_id))
        }
        ActionType::UpdateRectangleGeometry { id, old_geometry, new_geometry } => {
            let services = crate::service::get_service();
            services.marker_service.update_rectangle_marker_geometry_with_undo(
                *id, old_geometry.0, old_geometry.1, old_geometry.2, old_geometry.3
            )?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateRectangleGeometry {
                id: *id,
                old_geometry: *new_geometry,
                new_geometry: *old_geometry,
            }, action.project_id))
        }
        ActionType::UpdateMarkerTranslation { id, old_trans, new_trans } => {
            let services = crate::service::get_service();
            services.marker_service.update_marker_translation_with_undo(*id, old_trans.clone())?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateMarkerTranslation {
                id: *id,
                old_trans: new_trans.clone(),
                new_trans: old_trans.clone(),
            }, action.project_id))
        }
        ActionType::UpdateMarkerStyle { id, old_style, new_style } => {
            let services = crate::service::get_service();
            services.marker_service.update_marker_style_with_undo(*id, old_style.clone())?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateMarkerStyle {
                id: *id,
                old_style: new_style.clone(),
                new_style: old_style.clone(),
            }, action.project_id))
        }
        ActionType::UpdateMarkerOrder { id, image_id, old_index, new_index } => {
            // Undo marker order change by moving it back to old position
            let services = crate::service::get_service();
            services.marker_service.move_marker_order_with_undo(*id, *old_index)?;
            Ok(UndoRedoAction::with_id(action.id, ActionType::UpdateMarkerOrder {
                id: *id,
                image_id: *image_id,
                old_index: *new_index,
                new_index: *old_index,
            }, action.project_id))
        }
        ActionType::ClearImageMarkers { image_id, markers } => {
            // Restore all markers with their original image_index
            let mut storage = APP_STATE.markers.write()?;
            
            // Sort markers by image_index to restore them in order
            let mut sorted_markers = markers.clone();
            sorted_markers.sort_by_key(|m| m.image_index);
            
            // Insert each marker with its original index
            for marker in sorted_markers {
                storage.insert_with_image(marker.clone())?;
            }
            drop(storage);
            
            // Update image marker lists
            for marker in markers {
                crate::storage::image::add_marker_to_image_storage(*image_id, marker.id)?;
            }
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::ClearImageMarkers {
                image_id: *image_id,
                markers: markers.clone(),
            }, action.project_id))
        }
        ActionType::AddImage { image, position } => {
            // Undo add by removing the image
            let image_id = image.metadata.id;
            
            // Take ownership of markers - they will be moved into the reversed action
            let services = crate::service::get_service();
            let markers = services.marker_service.take_image_markers(image_id)?;
            
            // Remove image from project
            let mut project_storage = APP_STATE.projects.write()?;
            if let Some(project) = project_storage.get_mut(&action.project_id) {
                project.image_ids.retain(|&id| id != image_id);
            }
            drop(project_storage);
            
            // Remove image from storage
            let mut image_storage = APP_STATE.images.write()?;
            image_storage.remove(&image_id);
            drop(image_storage);
            
            // 发送图片删除事件到前端
            let _ = EVENT_SYSTEM.emit_business_event(
                "ImageRemovedFromProject".to_string(),
                serde_json::json!({
                    "project_id": action.project_id.0,
                    "image_id": image_id.0
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::RemoveImage {
                image: image.clone(),
                position: *position,
                markers,
            }, action.project_id))
        }
        ActionType::RemoveImage { image, position, markers } => {
            // Undo remove by adding back the image with markers
            let image_id = image.metadata.id;
            
            // Add image back to storage
            let mut image_storage = APP_STATE.images.write()?;
            image_storage.insert(image_id, std::sync::Arc::new(image.clone()))?;
            drop(image_storage);
            
            // Add image back to project at the original position
            let mut project_storage = APP_STATE.projects.write()?;
            if let Some(project) = project_storage.get_mut(&action.project_id) {
                if *position <= project.image_ids.len() {
                    project.image_ids.insert(*position, image_id);
                } else {
                    project.image_ids.push(image_id);
                }
            }
            drop(project_storage);
            
            // Restore markers back to storage - transfer ownership back
            // If this action is later overwritten, the markers in the new action will be freed
            let services = crate::service::get_service();
            services.marker_service.restore_image_markers(markers.clone())?;
            
            // 发送图片添加事件到前端
            let _ = EVENT_SYSTEM.emit_business_event(
                "ImageAddedToProject".to_string(),
                serde_json::json!({
                    "project_id": action.project_id.0,
                    "image_id": image_id.0,
                    "position": *position
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::AddImage {
                image: image.clone(),
                position: *position,
            }, action.project_id))
        }
        ActionType::ReorderImages { old_order, new_order } => {
            // Undo reorder by restoring old order
            let mut project_storage = APP_STATE.projects.write()?;
            if let Some(project) = project_storage.get_mut(&action.project_id) {
                project.image_ids = old_order.clone();
            }
            drop(project_storage);
            
            // 发送图片顺序更新事件到前端，通知更新UI
            let _ = EVENT_SYSTEM.emit_business_event(
                "ProjectImagesReordered".to_string(),
                serde_json::json!({
                    "project_id": action.project_id.0,
                    "image_ids": old_order.iter().map(|id| id.0).collect::<Vec<u32>>()
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::ReorderImages {
                old_order: new_order.clone(),
                new_order: old_order.clone(),
            }, action.project_id))
        }
        ActionType::ConvertRectangleToPoint { marker_id, old_marker, new_marker } => {
            // Undo by restoring the old rectangle marker
            let mut marker_storage = APP_STATE.markers.write()?;
            if let Some(marker) = marker_storage.get_mut(marker_id) {
                *marker = old_marker.clone();
            }
            drop(marker_storage);
            
            // Send marker update event
            let _ = EVENT_SYSTEM.emit_business_event(
                "MarkerConverted".to_string(),
                serde_json::json!({
                    "marker_id": marker_id.0,
                    "image_id": old_marker.image_id.0,
                    "conversion_type": "PointToRectangle"
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::ConvertPointToRectangle {
                marker_id: *marker_id,
                old_marker: new_marker.clone(),
                new_marker: old_marker.clone(),
            }, action.project_id))
        }
        ActionType::ConvertPointToRectangle { marker_id, old_marker, new_marker } => {
            // Undo by restoring the old point marker
            let mut marker_storage = APP_STATE.markers.write()?;
            if let Some(marker) = marker_storage.get_mut(marker_id) {
                *marker = old_marker.clone();
            }
            drop(marker_storage);
            
            // Send marker update event
            let _ = EVENT_SYSTEM.emit_business_event(
                "MarkerConverted".to_string(),
                serde_json::json!({
                    "marker_id": marker_id.0,
                    "image_id": old_marker.image_id.0,
                    "conversion_type": "RectangleToPoint"
                })
            );
            
            Ok(UndoRedoAction::with_id(action.id, ActionType::ConvertRectangleToPoint {
                marker_id: *marker_id,
                old_marker: new_marker.clone(),
                new_marker: old_marker.clone(),
            }, action.project_id))
        }
        _ => Ok(action.clone()), // For now, just return the same action for unimplemented types
    }
}

pub fn perform_redo(action: &UndoRedoAction) -> CoreResult<UndoRedoAction> {
    // Redo is essentially performing the original action again
    perform_undo(action)
}