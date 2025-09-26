// Bunny (海兔) API - OCR and Translation functionality
use crate::common::{MarkerId, ProjectId};
use crate::service::get_service;
use crate::service::bunny::{BunnyTask, OCRModel, TranslationService, BUNNY_PLUGIN_MANAGER};

/// Request OCR for a marker
pub fn request_ocr(marker_id: u32, ocr_model: String) -> Result<String, String> {
    let service = get_service();
    let marker_service = &service.marker_service;

    // Get marker to find image ID
    let marker = marker_service.get_marker(marker_id);
    if marker.is_none() {
        return Err("Marker not found".to_string());
    }

    let image_id = marker.unwrap().image_id;

    // Pass the model string directly to support dynamic plugin services
    service.bunny_service.request_ocr(MarkerId(marker_id), image_id, ocr_model)
}

/// Request translation for a marker
pub fn request_translation(
    marker_id: u32,
    service_name: String,
    source_lang: Option<String>,
    target_lang: String
) -> Result<String, String> {
    let service = get_service();

    // Pass the service string directly to support dynamic plugin services
    service.bunny_service.request_translation(
        MarkerId(marker_id),
        service_name,
        source_lang,
        target_lang
    )
}

/// Cancel a bunny task
pub fn cancel_bunny_task(task_id: String) -> bool {
    let service = get_service();
    service.bunny_service.cancel_task(&task_id).is_ok()
}

/// Get bunny task status
pub fn get_bunny_task_status(task_id: String) -> Option<BunnyTask> {
    let service = get_service();
    service.bunny_service.get_task_status(&task_id)
}

/// Get queued bunny tasks
pub fn get_bunny_queued_tasks(project_id: Option<u32>) -> Vec<BunnyTask> {
    let service = get_service();
    service.bunny_service.get_queued_tasks(project_id.map(ProjectId))
}

/// Get OCR result for a marker
pub fn get_ocr_result(marker_id: u32) -> Option<String> {
    let service = get_service();
    service.bunny_service.get_ocr_result(MarkerId(marker_id))
}

/// Get translation result for a marker
pub fn get_translation_result(marker_id: u32) -> Option<String> {
    let service = get_service();
    service.bunny_service.get_translation_result(MarkerId(marker_id))
}

/// Clear all bunny tasks
pub fn clear_all_bunny_tasks() -> bool {
    let service = get_service();
    service.bunny_service.clear_all_tasks().is_ok()
}

/// Get available OCR services from plugins
pub fn get_available_ocr_services() -> Vec<crate::service::bunny::OCRServiceInfo> {
    BUNNY_PLUGIN_MANAGER.get_ocr_services()
}

/// Get available translation services from plugins
pub fn get_available_translation_services() -> Vec<crate::service::bunny::TranslationServiceInfo> {
    BUNNY_PLUGIN_MANAGER.get_translation_services()
}

/// Register an OCR service from a plugin
pub fn register_ocr_service(service_info: crate::service::bunny::OCRServiceInfo) -> Result<(), String> {
    BUNNY_PLUGIN_MANAGER.register_ocr_service(service_info)
}

/// Register a translation service from a plugin
pub fn register_translation_service(service_info: crate::service::bunny::TranslationServiceInfo) -> Result<(), String> {
    BUNNY_PLUGIN_MANAGER.register_translation_service(service_info)
}

/// Unregister a bunny service
pub fn unregister_bunny_service(service_id: String) -> Result<(), String> {
    BUNNY_PLUGIN_MANAGER.unregister_service(&service_id)
}