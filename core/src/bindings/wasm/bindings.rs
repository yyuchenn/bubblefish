#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use serde_wasm_bindgen::to_value;
#[cfg(feature = "wasm")]
use std::sync::Arc;

#[cfg(feature = "wasm")]
use crate::api::*;
#[cfg(feature = "wasm")]
use crate::api::{create_opening_project_from_binary, get_opening_project_info, flush_opening_project_images, finalize_opening_project, delete_opening_project};
#[cfg(feature = "wasm")]
use crate::common::Logger;
#[cfg(feature = "wasm")]
use crate::api::marker::{
    add_point_marker_to_image, add_rectangle_marker_to_image,
    update_point_marker_position, update_rectangle_marker_geometry,
    update_point_marker_full, update_rectangle_marker_full,
    convert_rectangle_to_point_marker, convert_point_to_rectangle_marker
};
#[cfg(feature = "wasm")]
use crate::api::bunny::{
    request_ocr, request_translation, cancel_bunny_task, clear_all_bunny_tasks,
    get_bunny_task_status, get_bunny_queued_tasks,
    get_ocr_result, get_translation_result,
    get_available_ocr_services, get_available_translation_services,
    register_ocr_service, register_translation_service,
    unregister_bunny_service,
    get_bunny_cache, update_original_text, update_machine_translation, clear_bunny_cache
};
#[cfg(feature = "wasm")]
use crate::common::dto::image::{ImageDataDTO, ImageFormat};

// 临时项目相关
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_create_empty_opening_project(project_name: String) -> JsValue {
    match create_empty_opening_project(project_name) {
        Ok(project_id) => to_value(&project_id).unwrap_or(JsValue::NULL),
        Err(e) => {
            Logger::error(&format!("Failed to create empty opening project: {}", e));
            JsValue::NULL
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub async fn wasm_create_opening_project_from_shared_buffer(file_extension: String, project_name: String) -> Result<u32, JsValue> {
    super::shared_buffer::create_opening_project_from_shared_buffer_with_type_impl(file_extension, project_name).await
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_create_opening_project_from_binary(data: Vec<u8>, file_extension: String, project_name: String) -> JsValue {
    match create_opening_project_from_binary(data, file_extension, project_name) {
        Ok(project_id) => to_value(&project_id).unwrap_or(JsValue::NULL),
        Err(e) => {
            Logger::error(&format!("Failed to create opening project: {}", e));
            JsValue::NULL
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_opening_project_info(project_id: u32) -> JsValue {
    match get_opening_project_info(project_id) {
        Some(info) => to_value(&info).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_flush_opening_project_images(project_id: u32) -> bool {
    flush_opening_project_images(project_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_finalize_opening_project(project_id: u32) -> bool {
    finalize_opening_project(project_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_delete_opening_project(project_id: u32) -> bool {
    delete_opening_project(project_id)
}

// 项目相关
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_project_info(project_id: u32) -> JsValue {
    match get_project_info(project_id) {
        Some(project) => to_value(&project).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_all_projects_info() -> JsValue {
    to_value(&get_all_projects_info()).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_project_name(project_id: u32, name: String) -> bool {
    update_project_name(project_id, name)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_project_languages(project_id: u32, source_language: String, target_language: String) -> bool {
    use crate::common::Language;
    
    // Parse language strings to Language enum
    let source = match source_language.as_str() {
        "japanese" => Language::Japanese,
        "english" => Language::English,
        "simplifiedChinese" => Language::SimplifiedChinese,
        "traditionalChinese" => Language::TraditionalChinese,
        _ => Language::Japanese, // Default
    };
    
    let target = match target_language.as_str() {
        "japanese" => Language::Japanese,
        "english" => Language::English,
        "simplifiedChinese" => Language::SimplifiedChinese,
        "traditionalChinese" => Language::TraditionalChinese,
        _ => Language::SimplifiedChinese, // Default
    };
    
    update_project_languages(project_id, source, target)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_delete_project(project_id: u32) -> bool {
    delete_project(project_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_project_images(project_id: u32) -> JsValue {
    to_value(&get_project_images(project_id)).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_project_images_metadata(project_id: u32) -> JsValue {
    to_value(&get_project_images_metadata(project_id)).unwrap_or(JsValue::NULL)
}

// 图片相关
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_add_image_from_binary_to_project(project_id: u32, format_str: String, data: Vec<u8>, name: Option<String>) -> Option<u32> {
    if let Some(format) = match format_str.as_str() {
        "jpeg" | "jpg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::Webp),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    } {
        add_image_from_binary_to_project(project_id, format, data, name)
    } else {
        None
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_image_info(image_id: u32) -> JsValue {
    match get_image_info(image_id) {
        Some(image) => to_value(&image).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_image_info(image_id: u32, name: Option<String>) -> bool {
    update_image_info(image_id, None, name)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_image_data_from_binary(image_id: u32, format_str: String, data: Vec<u8>) -> bool {
    if let Some(format) = match format_str.as_str() {
        "jpeg" | "jpg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::Webp),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    } {
        let image_data = ImageDataDTO::Binary { format, data: Arc::new(data) };
        update_image_info(image_id, Some(image_data), None)
    } else {
        false
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_remove_image_from_project(project_id: u32, image_id: u32) -> bool {
    remove_image_from_project(project_id, image_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_reorder_project_images(project_id: u32, image_ids: Vec<u32>) -> bool {
    reorder_project_images(project_id, image_ids)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_image_binary_data(image_id: u32) -> Result<Vec<u8>, JsValue> {
    match get_image_binary_data(image_id) {
        Ok(data) => Ok(data),
        Err(e) => Err(JsValue::from_str(&e)),
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_image_mime_type(image_id: u32) -> Option<String> {
    get_image_mime_type(image_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_image_markers(image_id: u32) -> JsValue {
    to_value(&get_image_markers(image_id)).unwrap_or(JsValue::NULL)
}

// 标记相关 - 点型marker
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_add_point_marker_to_image(image_id: u32, x: f64, y: f64, translation: Option<String>) -> Option<u32> {
    add_point_marker_to_image(image_id, x, y, translation)
}

// 标记相关 - 矩形型marker
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_add_rectangle_marker_to_image(image_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> Option<u32> {
    add_rectangle_marker_to_image(image_id, x, y, width, height, translation)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_marker_info(marker_id: u32) -> JsValue {
    match get_marker_info(marker_id) {
        Some(marker) => to_value(&marker).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_point_marker_position(marker_id: u32, x: f64, y: f64) -> bool {
    update_point_marker_position(marker_id, x, y)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_rectangle_marker_geometry(marker_id: u32, x: f64, y: f64, width: f64, height: f64) -> bool {
    update_rectangle_marker_geometry(marker_id, x, y, width, height)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_marker_translation(marker_id: u32, translation: String) -> bool {
    update_marker_translation(marker_id, translation)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_marker_style(marker_id: u32, overlay_text: bool, horizontal: bool) -> bool {
    update_marker_style(marker_id, overlay_text, horizontal)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_move_marker_order(marker_id: u32, new_index: u32) -> bool {
    marker::move_marker_order(marker_id, new_index)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_point_marker_full(marker_id: u32, x: f64, y: f64, translation: Option<String>) -> bool {
    update_point_marker_full(marker_id, x, y, translation)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_rectangle_marker_full(marker_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> bool {
    update_rectangle_marker_full(marker_id, x, y, width, height, translation)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_remove_marker_from_image(image_id: u32, marker_id: u32) -> bool {
    remove_marker_from_image(image_id, marker_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_image_markers(image_id: u32) -> bool {
    clear_image_markers(image_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_convert_rectangle_to_point_marker(marker_id: u32) -> bool {
    convert_rectangle_to_point_marker(marker_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_convert_point_to_rectangle_marker(marker_id: u32) -> bool {
    convert_point_to_rectangle_marker(marker_id)
}

// 统计相关
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_stats() -> JsValue {
    to_value(&get_stats()).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_project_stats(project_id: u32) -> JsValue {
    match get_project_stats(project_id) {
        Some(stats) => to_value(&stats).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

// 数据清理
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_all_data() {
    clear_all_data()
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_project_data(project_id: u32) -> bool {
    clear_project_data(project_id)
}

// 撤销重做相关函数
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_undo(project_id: u32) -> JsValue {
    let result = undo(project_id);
    to_value(&result).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_redo(project_id: u32) -> JsValue {
    let result = redo(project_id);
    to_value(&result).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_undo_redo_history(project_id: u32) {
    clear_undo_redo_history(project_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_all_undo_redo_history() {
    clear_all_undo_redo_history()
}

// 缩略图相关函数
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_request_thumbnail(image_id: u32) -> JsValue {
    match request_thumbnail(image_id) {
        Ok(_) => JsValue::from_str("ok"),
        Err(e) => JsValue::from_str(&e),
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_request_thumbnails_batch(image_ids: &[u32]) -> JsValue {
    match request_thumbnails_batch(image_ids.to_vec()) {
        Ok(_) => JsValue::from_str("ok"),
        Err(e) => JsValue::from_str(&e),
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_thumbnail(image_id: u32) -> JsValue {
    match get_thumbnail(image_id) {
        Some(thumbnail) => to_value(&thumbnail).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_has_thumbnail(image_id: u32) -> bool {
    has_thumbnail(image_id)
}

// SharedArrayBuffer support
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_init_shared_buffer(buffer: js_sys::SharedArrayBuffer) -> Result<(), JsValue> {
    super::shared_buffer::init_shared_buffer_impl(buffer)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub async fn wasm_add_image_from_shared_buffer(project_id: u32, name: Option<String>) -> Result<u32, JsValue> {
    super::shared_buffer::add_image_from_shared_buffer_impl(project_id, name).await
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_cleanup_orphaned_images() -> u32 {
    // For now, return 0 as we're not tracking orphaned images in memory
    // This will be implemented when we add proper image lifecycle management
    0
}

// 事件系统初始化
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_init_event_system() {
    // 标记当前线程为主线程
    crate::common::events::mark_as_main_thread();
    
    // 在WASM环境中初始化事件发射器
    let event_emitter = crate::common::events::WasmEventEmitter::new();
    crate::common::EVENT_SYSTEM.register_emitter(
        "wasm".to_string(),
        Box::new(event_emitter)
    );
    Logger::info("WASM event system initialized");
}

// 设置Worker事件回调
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_set_event_callback(callback: js_sys::Function) {
    use wasm_bindgen::JsValue;
    
    let callback_clone = callback.clone();
    crate::common::events::set_worker_event_callback(move |event_name: String, event_data: serde_json::Value| {
        let event_name_js = JsValue::from_str(&event_name);
        let event_data_js = match js_sys::JSON::parse(&event_data.to_string()) {
            Ok(value) => value,
            Err(_) => {
                Logger::error("Failed to parse event data JSON for callback");
                return;
            }
        };

        if let Err(e) = callback_clone.call2(&JsValue::NULL, &event_name_js, &event_data_js) {
            Logger::error(&format!("Event callback error: {:?}", e));
        }
    });
}

// LabelPlus文件验证
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_validate_labelplus_file(content: String) -> JsValue {
    match validate_labelplus_file(&content) {
        Ok(data) => to_value(&data).unwrap_or(JsValue::NULL),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &JsValue::from_str(&e)).unwrap();
            error_obj.into()
        }
    }
}

// 导入LabelPlus数据
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_import_labelplus_data(project_id: u32, content: String) -> JsValue {
    match import_labelplus_data(project_id, &content) {
        Ok(()) => JsValue::from_str("ok"),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &JsValue::from_str(&e)).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_export_labelplus_data(project_id: u32) -> JsValue {
    match export_labelplus_data(project_id) {
        Ok(content) => JsValue::from_str(&content),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &JsValue::from_str(&e)).unwrap();
            error_obj.into()
        }
    }
}

// Bunny (海兔) OCR and translation functions
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_request_ocr(marker_id: u32, ocr_model: String) -> JsValue {
    match request_ocr(marker_id, ocr_model) {
        Ok(task_id) => JsValue::from_str(&task_id),
        Err(e) => {
            Logger::error(&format!("Failed to request OCR: {}", e));
            JsValue::from_str("")
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_request_translation(marker_id: u32, service_name: String, source_lang: Option<String>, target_lang: String) -> JsValue {
    match request_translation(marker_id, service_name, source_lang, target_lang) {
        Ok(task_id) => JsValue::from_str(&task_id),
        Err(e) => {
            Logger::error(&format!("Failed to request translation: {}", e));
            JsValue::from_str("")
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_cancel_bunny_task(task_id: String) -> bool {
    cancel_bunny_task(task_id)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_all_bunny_tasks() -> bool {
    clear_all_bunny_tasks()
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_bunny_task_status(task_id: String) -> JsValue {
    match get_bunny_task_status(task_id) {
        Some(task) => to_value(&task).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_bunny_queued_tasks(project_id: Option<u32>) -> JsValue {
    let tasks = get_bunny_queued_tasks(project_id);
    to_value(&tasks).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_ocr_result(marker_id: u32) -> JsValue {
    match get_ocr_result(marker_id) {
        Some(result) => JsValue::from_str(&result),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_translation_result(marker_id: u32) -> JsValue {
    match get_translation_result(marker_id) {
        Some(result) => JsValue::from_str(&result),
        None => JsValue::NULL,
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_available_ocr_services() -> JsValue {
    let services = get_available_ocr_services();
    to_value(&services).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_available_translation_services() -> JsValue {
    let services = get_available_translation_services();
    to_value(&services).unwrap_or(JsValue::NULL)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_register_ocr_service(service_info: JsValue) -> JsValue {
    match serde_wasm_bindgen::from_value::<crate::service::bunny::OCRServiceInfo>(service_info) {
        Ok(info) => {
            match register_ocr_service(info) {
                Ok(_) => JsValue::undefined(),
                Err(e) => {
                    let error_obj = js_sys::Object::new();
                    js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
                    error_obj.into()
                }
            }
        }
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &format!("Invalid service info: {}", e).into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_register_translation_service(service_info: JsValue) -> JsValue {
    match serde_wasm_bindgen::from_value::<crate::service::bunny::TranslationServiceInfo>(service_info) {
        Ok(info) => {
            match register_translation_service(info) {
                Ok(_) => JsValue::undefined(),
                Err(e) => {
                    let error_obj = js_sys::Object::new();
                    js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
                    error_obj.into()
                }
            }
        }
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &format!("Invalid service info: {}", e).into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_get_bunny_cache(marker_id: u32) -> JsValue {
    match get_bunny_cache(crate::common::MarkerId(marker_id)) {
        Ok(Some(cache_data)) => to_value(&cache_data).unwrap_or(JsValue::NULL),
        Ok(None) => JsValue::NULL,
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_original_text(marker_id: u32, text: String, model: String) -> JsValue {
    match update_original_text(crate::common::MarkerId(marker_id), text, model) {
        Ok(_) => JsValue::undefined(),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_update_machine_translation(marker_id: u32, text: String, service: String) -> JsValue {
    match update_machine_translation(crate::common::MarkerId(marker_id), text, service) {
        Ok(_) => JsValue::undefined(),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_clear_bunny_cache(marker_id: u32) -> JsValue {
    match clear_bunny_cache(crate::common::MarkerId(marker_id)) {
        Ok(_) => JsValue::undefined(),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_unregister_bunny_service(service_id: String) -> JsValue {
    match unregister_bunny_service(service_id) {
        Ok(_) => JsValue::undefined(),
        Err(e) => {
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &e.into()).unwrap();
            error_obj.into()
        }
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_save_project(project_id: u32) -> JsValue {
    match save_project(project_id) {
        Ok(data) => {
            // Convert Vec<u8> to Uint8Array for JavaScript
            let uint8_array = js_sys::Uint8Array::new_with_length(data.len() as u32);
            uint8_array.copy_from(&data);
            uint8_array.into()
        },
        Err(e) => {
            // Return error object
            let error_obj = js_sys::Object::new();
            js_sys::Reflect::set(&error_obj, &"error".into(), &JsValue::from_str(&e)).unwrap();
            error_obj.into()
        }
    }
}