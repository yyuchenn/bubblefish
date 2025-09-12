// Bunny (海兔) API - OCR and Translation functionality
use crate::common::{MarkerId, ProjectId};
use crate::service::get_service;
use crate::service::bunny::{BunnyTask, OCRModel, TranslationService};

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
    
    // Parse OCR model
    let model = match ocr_model.as_str() {
        "tesseract" => OCRModel::Tesseract,
        "paddleocr" => OCRModel::PaddleOCR,
        "easyocr" => OCRModel::EasyOCR,
        _ => OCRModel::Default,
    };
    
    service.bunny_service.request_ocr(MarkerId(marker_id), image_id, model)
}

/// Request translation for a marker
pub fn request_translation(
    marker_id: u32, 
    service_name: String, 
    source_lang: Option<String>, 
    target_lang: String
) -> Result<String, String> {
    let service = get_service();
    
    // Parse translation service
    let trans_service = match service_name.as_str() {
        "google" => TranslationService::Google,
        "deepl" => TranslationService::DeepL,
        "chatgpt" => TranslationService::ChatGPT,
        "baidu" => TranslationService::Baidu,
        _ => TranslationService::Default,
    };
    
    service.bunny_service.request_translation(
        MarkerId(marker_id), 
        trans_service, 
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