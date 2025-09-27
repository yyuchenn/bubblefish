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

        // Get image info for format
        let image = crate::storage::image::get_image_storage(image_id)
            .map_err(|e| format!("Failed to get image: {:?}", e))?
            .ok_or("Image not found")?;

        // Extract image format as string
        let image_format = image.metadata.format.as_ref().map(|fmt| {
            match fmt {
                crate::storage::image_data::ImageFormat::Jpeg => "jpg",
                crate::storage::image_data::ImageFormat::Png => "png",
                crate::storage::image_data::ImageFormat::Gif => "gif",
                crate::storage::image_data::ImageFormat::Webp => "webp",
                crate::storage::image_data::ImageFormat::Bmp => "bmp",
            }.to_string()
        });

        // Convert geometry enum to plugin-friendly format with markerType field
        let marker_geometry = match marker.geometry {
            crate::storage::marker::MarkerGeometry::Point { x, y } => {
                serde_json::json!({
                    "markerType": "point",
                    "x": x,
                    "y": y,
                    "width": null,
                    "height": null
                })
            },
            crate::storage::marker::MarkerGeometry::Rectangle { x, y, width, height } => {
                serde_json::json!({
                    "markerType": "rectangle",
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height
                })
            }
        };

        // Create task
        let task_id = TASK_MANAGER.create_task(marker_id, image_id, TaskType::OCR, service_id.clone())?;

        // Emit task created event
        let task = TASK_MANAGER.get_task(&task_id)?.ok_or("Task not found")?;
        let _ = EVENT_SYSTEM.emit_business_event("bunny:task_created".to_string(), serde_json::json!(task));

        // Emit request to frontend to relay to plugin
        let _ = EVENT_SYSTEM.emit_business_event("bunny:request_plugin_ocr".to_string(), serde_json::json!({
            "task_id": task_id,
            "marker_id": marker_id,
            "image_id": image_id,
            "service_id": service_id,
            "source_language": project.source_language,
            "marker_geometry": marker_geometry,
            "image_format": image_format,
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