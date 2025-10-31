// Bunny (海兔) API - OCR and Translation functionality
use crate::service::bunny::{BUNNY_SERVICE_REGISTRY, BunnyService};
use crate::common::{MarkerId, ImageId, ProjectId};

/// Get available OCR services from plugins (with plugin_id included)
pub fn get_available_ocr_services() -> Vec<serde_json::Value> {
    BUNNY_SERVICE_REGISTRY
        .read()
        .map(|registry| registry.get_ocr_services())
        .unwrap_or_default()
}

/// Get available translation services from plugins (with plugin_id included)
pub fn get_available_translation_services() -> Vec<serde_json::Value> {
    BUNNY_SERVICE_REGISTRY
        .read()
        .map(|registry| registry.get_translation_services())
        .unwrap_or_default()
}

/// Request OCR processing for a marker
pub fn request_ocr(marker_id: MarkerId, image_id: ImageId, project_id: ProjectId, service_id: String) -> Result<String, String> {
    let service = BunnyService::new();
    service.request_ocr(marker_id, image_id, project_id, service_id)
}

/// Request translation processing for a marker
pub fn request_translation(marker_id: MarkerId, image_id: ImageId, project_id: ProjectId, service_id: String, text: String) -> Result<String, String> {
    let service = BunnyService::new();
    service.request_translation(marker_id, image_id, project_id, service_id, text)
}

/// Handle OCR completion from plugin (called by frontend relay)
pub fn handle_ocr_completed(task_id: String, marker_id: MarkerId, text: String, model: String) -> Result<(), String> {
    let service = BunnyService::new();
    service.handle_ocr_completed(task_id, marker_id, text, model)
}

/// Handle translation completion from plugin (called by frontend relay)
pub fn handle_translation_completed(task_id: String, marker_id: MarkerId, translated_text: String, service_id: String) -> Result<(), String> {
    let service = BunnyService::new();
    service.handle_translation_completed(task_id, marker_id, translated_text, service_id)
}

/// Handle task failure from plugin (called by frontend relay)
pub fn handle_task_failed(task_id: String, error: String) -> Result<(), String> {
    let service = BunnyService::new();
    service.handle_task_failed(task_id, error)
}

/// Get bunny cache data for a marker
pub fn get_bunny_cache(marker_id: MarkerId) -> Result<Option<crate::storage::bunny_cache::BunnyCacheData>, String> {
    crate::storage::bunny_cache::get_bunny_cache_storage(marker_id)
        .map_err(|e| format!("Failed to get bunny cache: {:?}", e))
}

/// Update original text in bunny cache
pub fn update_original_text(marker_id: MarkerId, text: String, model: String) -> Result<(), String> {
    crate::storage::bunny_cache::update_original_text_storage(marker_id, text, model)
        .map_err(|e| format!("Failed to update original text: {:?}", e))
}

/// Update machine translation in bunny cache
pub fn update_machine_translation(marker_id: MarkerId, text: String, service: String) -> Result<(), String> {
    crate::storage::bunny_cache::update_machine_translation_storage(marker_id, text, service)
        .map_err(|e| format!("Failed to update machine translation: {:?}", e))
}

/// Clear bunny cache for a marker
pub fn clear_bunny_cache(marker_id: MarkerId) -> Result<(), String> {
    crate::storage::bunny_cache::clear_bunny_cache_storage(marker_id)
        .map_err(|e| format!("Failed to clear bunny cache: {:?}", e))
}