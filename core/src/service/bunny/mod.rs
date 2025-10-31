// Bunny (海兔) module - OCR and translation service types
// Plugin-based architecture: actual processing happens in plugins

mod types;
mod task_manager;

pub use types::{OCRServiceInfo, TranslationServiceInfo, BUNNY_SERVICE_REGISTRY};
pub use task_manager::{BunnyTask, TaskManager, TaskStatus, TaskType};

use crate::common::{MarkerId, ImageId, ProjectId, EVENT_SYSTEM};
use lazy_static::lazy_static;

lazy_static! {
    pub static ref TASK_MANAGER: TaskManager = TaskManager::new();
}

pub struct BunnyService;

impl BunnyService {
    pub fn new() -> Self {
        Self
    }

    /// Request OCR processing for a marker
    pub fn request_ocr(&self, marker_id: MarkerId, image_id: ImageId, project_id: ProjectId, service_id: String) -> Result<String, String> {
        // Get project info to retrieve source language
        let project = crate::storage::project::get_project_storage(project_id)
            .map_err(|e| format!("Failed to get project: {:?}", e))?
            .ok_or("Project not found")?;

        // Get marker info for geometry
        let marker = crate::storage::marker::get_marker_storage(marker_id)
            .map_err(|e| format!("Failed to get marker: {:?}", e))?
            .ok_or("Marker not found")?;

        // Get full image binary data
        let image_service = &crate::service::get_service().image_service;
        let full_image_data = image_service.get_image_binary_data(image_id.into())?;

        // Crop the image based on marker geometry
        let (x, y, width, height) = match marker.geometry {
            crate::storage::marker::MarkerGeometry::Point { x, y } => {
                (x, y, None, None)
            },
            crate::storage::marker::MarkerGeometry::Rectangle { x, y, width, height } => {
                (x, y, Some(width), Some(height))
            }
        };

        let cropped_image_data = image_service.crop_image_region(&full_image_data, x, y, width, height)?;

        // Create task
        let task_id = TASK_MANAGER.create_task(marker_id, image_id, TaskType::OCR, service_id.clone())?;

        // Emit task created event
        let task = TASK_MANAGER.get_task(&task_id)?.ok_or("Task not found")?;
        let _ = EVENT_SYSTEM.emit_business_event("bunny:task_created".to_string(), serde_json::json!(task));

        // Emit request to frontend to relay to plugin (with cropped image)
        let _ = EVENT_SYSTEM.emit_business_event("bunny:request_plugin_ocr".to_string(), serde_json::json!({
            "task_id": task_id,
            "marker_id": marker_id,
            "cropped_image_data": cropped_image_data,
            "image_format": "png",  // Cropped images are always PNG
            "service_id": service_id,
            "source_language": project.source_language,
        }));

        Ok(task_id)
    }

    /// Request translation processing for a marker
    pub fn request_translation(&self, marker_id: MarkerId, image_id: ImageId, project_id: ProjectId, service_id: String, text: String) -> Result<String, String> {
        // Get project info to retrieve languages
        let project = crate::storage::project::get_project_storage(project_id)
            .map_err(|e| format!("Failed to get project: {:?}", e))?
            .ok_or("Project not found")?;

        // Create task
        let task_id = TASK_MANAGER.create_task(marker_id, image_id, TaskType::Translation, service_id.clone())?;

        // Emit task created event
        let task = TASK_MANAGER.get_task(&task_id)?.ok_or("Task not found")?;
        let _ = EVENT_SYSTEM.emit_business_event("bunny:task_created".to_string(), serde_json::json!(task));

        // Emit request to frontend to relay to plugin
        let _ = EVENT_SYSTEM.emit_business_event("bunny:request_plugin_translation".to_string(), serde_json::json!({
            "task_id": task_id,
            "marker_id": marker_id,
            "image_id": image_id,
            "service_id": service_id,
            "text": text,
            "source_language": project.source_language,
            "target_language": project.target_language,
        }));

        Ok(task_id)
    }

    /// Handle OCR completion from plugin (via frontend relay)
    pub fn handle_ocr_completed(&self, task_id: String, marker_id: MarkerId, text: String, model: String) -> Result<(), String> {
        // Update task status
        TASK_MANAGER.complete_task(&task_id)?;

        // Update cache
        crate::storage::bunny_cache::update_original_text_storage(marker_id, text.clone(), model.clone())
            .map_err(|e| format!("Failed to update cache: {:?}", e))?;

        // Emit completion event
        let _ = EVENT_SYSTEM.emit_business_event("bunny:ocr_completed".to_string(), serde_json::json!({
            "task_id": task_id,
            "marker_id": marker_id,
            "original_text": text,
            "model": model,
        }));

        Ok(())
    }

    /// Handle translation completion from plugin (via frontend relay)
    pub fn handle_translation_completed(&self, task_id: String, marker_id: MarkerId, translated_text: String, service: String) -> Result<(), String> {
        // Update task status
        TASK_MANAGER.complete_task(&task_id)?;

        // Update cache
        crate::storage::bunny_cache::update_machine_translation_storage(marker_id, translated_text.clone(), service.clone())
            .map_err(|e| format!("Failed to update cache: {:?}", e))?;

        // Emit completion event
        let _ = EVENT_SYSTEM.emit_business_event("bunny:translation_completed".to_string(), serde_json::json!({
            "task_id": task_id,
            "marker_id": marker_id,
            "machine_translation": translated_text,
            "service": service,
        }));

        Ok(())
    }

    /// Handle task failure from plugin (via frontend relay)
    pub fn handle_task_failed(&self, task_id: String, error: String) -> Result<(), String> {
        // Update task status
        TASK_MANAGER.fail_task(&task_id, error.clone())?;

        // Emit failure event
        let _ = EVENT_SYSTEM.emit_business_event("bunny:task_failed".to_string(), serde_json::json!({
            "task_id": task_id,
            "error": error,
        }));

        Ok(())
    }
}