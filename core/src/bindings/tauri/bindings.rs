#[cfg(feature = "tauri")]
use std::path::PathBuf;
#[cfg(feature = "tauri")]
use std::sync::Arc;

#[cfg(feature = "tauri")]
use crate::api::*;
#[cfg(feature = "tauri")]
use crate::api::{create_opening_project_from_path, create_opening_project_from_binary, get_opening_project_info, flush_opening_project_images, finalize_opening_project, delete_opening_project};
#[cfg(feature = "tauri")]
use crate::api::marker::{
    add_point_marker_to_image, add_rectangle_marker_to_image,
    update_point_marker_position, update_rectangle_marker_geometry,
    update_point_marker_full, update_rectangle_marker_full,
    convert_rectangle_to_point_marker, convert_point_to_rectangle_marker
};
#[cfg(feature = "tauri")]
use crate::api::bunny::{
    get_available_ocr_services, get_available_translation_services,
    get_bunny_cache, update_original_text, update_machine_translation, clear_bunny_cache
};
#[cfg(feature = "tauri")]
use crate::common::dto::image::{ImageDataDTO, ImageFormat};

// 临时项目相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_create_empty_opening_project(project_name: String) -> Result<u32, String> {
    create_empty_opening_project(project_name)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_create_opening_project_from_path(path: String, project_name: String) -> Result<u32, String> {
    let path_buf = PathBuf::from(path);
    create_opening_project_from_path(path_buf, project_name)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_create_opening_project_from_binary(data: Vec<u8>, file_extension: String, project_name: String) -> Result<u32, String> {
    create_opening_project_from_binary(data, file_extension, project_name)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_opening_project_info(project_id: u32) -> Option<crate::common::dto::opening_project::OpeningProjectDTO> {
    get_opening_project_info(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_flush_opening_project_images(project_id: u32) -> bool {
    flush_opening_project_images(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_finalize_opening_project(project_id: u32) -> bool {
    finalize_opening_project(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_delete_opening_project(project_id: u32) -> bool {
    delete_opening_project(project_id)
}

// 项目相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_project_info(project_id: u32) -> Option<crate::common::dto::project::ProjectDTO> {
    get_project_info(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_all_projects_info() -> Vec<crate::common::dto::project::ProjectDTO> {
    get_all_projects_info()
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_project_name(project_id: u32, name: String) -> bool {
    update_project_name(project_id, name)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_project_languages(project_id: u32, source_language: crate::common::Language, target_language: crate::common::Language) -> bool {
    update_project_languages(project_id, source_language, target_language)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_delete_project(project_id: u32) -> bool {
    delete_project(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_project_images(project_id: u32) -> Vec<crate::common::dto::image::ImageDTO> {
    get_project_images(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_project_images_metadata(project_id: u32) -> Vec<crate::common::dto::image::ImageMetadataDTO> {
    get_project_images_metadata(project_id)
}

// 图片相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_add_image_from_path_to_project(project_id: u32, path: String) -> Option<u32> {
    let path_buf = PathBuf::from(path);
    add_image_from_path_to_project(project_id, path_buf)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_add_image_from_binary_to_project(project_id: u32, format_str: String, data: Vec<u8>, name: Option<String>) -> Option<u32> {
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

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_image_info(image_id: u32) -> Option<crate::common::dto::image::ImageDTO> {
    get_image_info(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_image_info(image_id: u32, name: Option<String>) -> bool {
    update_image_info(image_id, None, name)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_image_data_from_path(image_id: u32, path: String) -> bool {
    let path_buf = PathBuf::from(path);
    let image_data = ImageDataDTO::FilePath(path_buf);
    update_image_info(image_id, Some(image_data), None)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_image_data_from_binary(image_id: u32, format_str: String, data: Vec<u8>) -> bool {
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

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_remove_image_from_project(project_id: u32, image_id: u32) -> bool {
    remove_image_from_project(project_id, image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_reorder_project_images(project_id: u32, image_ids: Vec<u32>) -> bool {
    reorder_project_images(project_id, image_ids)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_image_markers(image_id: u32) -> Vec<crate::common::dto::marker::MarkerDTO> {
    get_image_markers(image_id)
}

// 标记相关命令 - 点型marker
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_add_point_marker_to_image(image_id: u32, x: f64, y: f64, translation: Option<String>) -> Option<u32> {
    add_point_marker_to_image(image_id, x, y, translation)
}

// 标记相关命令 - 矩形型marker
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_add_rectangle_marker_to_image(image_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> Option<u32> {
    add_rectangle_marker_to_image(image_id, x, y, width, height, translation)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_marker_info(marker_id: u32) -> Option<crate::common::dto::marker::MarkerDTO> {
    get_marker_info(marker_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_point_marker_position(marker_id: u32, x: f64, y: f64) -> bool {
    update_point_marker_position(marker_id, x, y)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_rectangle_marker_geometry(marker_id: u32, x: f64, y: f64, width: f64, height: f64) -> bool {
    update_rectangle_marker_geometry(marker_id, x, y, width, height)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_marker_translation(marker_id: u32, translation: String) -> bool {
    update_marker_translation(marker_id, translation)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_marker_style(marker_id: u32, overlay_text: bool, horizontal: bool) -> bool {
    update_marker_style(marker_id, overlay_text, horizontal)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_move_marker_order(marker_id: u32, new_index: u32) -> bool {
    marker::move_marker_order(marker_id, new_index)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_point_marker_full(marker_id: u32, x: f64, y: f64, translation: Option<String>) -> bool {
    update_point_marker_full(marker_id, x, y, translation)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_rectangle_marker_full(marker_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> bool {
    update_rectangle_marker_full(marker_id, x, y, width, height, translation)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_remove_marker_from_image(image_id: u32, marker_id: u32) -> bool {
    remove_marker_from_image(image_id, marker_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_image_markers(image_id: u32) -> bool {
    clear_image_markers(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_convert_rectangle_to_point_marker(marker_id: u32) -> bool {
    convert_rectangle_to_point_marker(marker_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_convert_point_to_rectangle_marker(marker_id: u32) -> bool {
    convert_point_to_rectangle_marker(marker_id)
}

// 统计相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_stats() -> ProjectStats {
    get_stats()
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_project_stats(project_id: u32) -> Option<SingleProjectStats> {
    get_project_stats(project_id)
}

// 数据清理命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_all_data() {
    clear_all_data()
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_image_binary_data(image_id: u32) -> Result<Vec<u8>, String> {
    get_image_binary_data(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_image_mime_type(image_id: u32) -> Option<String> {
    get_image_mime_type(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_image_file_path(image_id: u32) -> Option<String> {
    get_image_file_path(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_project_data(project_id: u32) -> bool {
    clear_project_data(project_id)
}

// 缩略图相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_request_thumbnail(image_id: u32) -> Result<(), String> {
    request_thumbnail(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_thumbnail(image_id: u32) -> Option<crate::service::image::ThumbnailData> {
    get_thumbnail(image_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_has_thumbnail(image_id: u32) -> bool {
    has_thumbnail(image_id)
}

// 撤销重做相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_undo(project_id: u32) -> UndoRedoResult {
    undo(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_redo(project_id: u32) -> UndoRedoResult {
    redo(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_undo_redo_history(project_id: u32) {
    clear_undo_redo_history(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_all_undo_redo_history() {
    clear_all_undo_redo_history()
}

// LabelPlus文件相关命令
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_validate_labelplus_file(content: String) -> Result<crate::service::io::labelplus::LabelplusData, String> {
    validate_labelplus_file(&content)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_import_labelplus_data(project_id: u32, content: String) -> Result<(), String> {
    import_labelplus_data(project_id, &content)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_export_labelplus_data(project_id: u32) -> Result<String, String> {
    export_labelplus_data(project_id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_save_project(project_id: u32) -> Result<Vec<u8>, String> {
    save_project(project_id)
}

// Tauri 命令注册辅助函数
#[cfg(feature = "tauri")]
pub fn register_data_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        // 临时项目命令
        tauri_create_empty_opening_project,
        tauri_create_opening_project_from_path,
        tauri_create_opening_project_from_binary,
        tauri_get_opening_project_info,
        tauri_flush_opening_project_images,
        tauri_finalize_opening_project,
        tauri_delete_opening_project,
        // 项目命令
        tauri_get_project_info,
        tauri_get_all_projects_info,
        tauri_update_project_name,
        tauri_delete_project,
        tauri_get_project_images,
        tauri_get_project_images_metadata,
        // 图片命令
        tauri_add_image_from_path_to_project,
        tauri_add_image_from_binary_to_project,
        tauri_get_image_info,
        tauri_update_image_info,
        tauri_update_image_data_from_path,
        tauri_update_image_data_from_binary,
        tauri_remove_image_from_project,
        tauri_reorder_project_images,
        tauri_get_image_markers,
        // 标记命令
        tauri_add_point_marker_to_image,
        tauri_add_rectangle_marker_to_image,
        tauri_get_marker_info,
        tauri_update_point_marker_position,
        tauri_update_rectangle_marker_geometry,
        tauri_update_marker_translation,
        tauri_update_marker_style,
        tauri_move_marker_order,
        tauri_update_point_marker_full,
        tauri_update_rectangle_marker_full,
        tauri_remove_marker_from_image,
        tauri_clear_image_markers,
        tauri_convert_rectangle_to_point_marker,
        tauri_convert_point_to_rectangle_marker,
        // 统计命令
        tauri_get_stats,
        tauri_get_project_stats,
        // 清理命令
        tauri_clear_all_data,
        tauri_clear_project_data,
        // 图片数据获取命令
        tauri_get_image_binary_data,
        tauri_get_image_mime_type,
        tauri_get_image_file_path,
        // 缩略图命令
        tauri_request_thumbnail,
        tauri_get_thumbnail,
        tauri_has_thumbnail,
        // 撤销重做命令
        tauri_undo,
        tauri_redo,
        tauri_clear_undo_redo_history,
        tauri_clear_all_undo_redo_history,
        // LabelPlus文件命令
        tauri_validate_labelplus_file,
        tauri_import_labelplus_data,
        tauri_export_labelplus_data,
        tauri_save_project,
        // Bunny (海兔) OCR and translation commands
        tauri_get_available_ocr_services,
        tauri_get_available_translation_services,
        tauri_get_bunny_cache,
        tauri_update_original_text,
        tauri_update_machine_translation,
        tauri_clear_bunny_cache
    ])
}

// Bunny (海兔) OCR and translation commands
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_available_ocr_services() -> Vec<serde_json::Value> {
    get_available_ocr_services()
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_available_translation_services() -> Vec<serde_json::Value> {
    get_available_translation_services()
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_get_bunny_cache(marker_id: u32) -> Result<Option<crate::storage::bunny_cache::BunnyCacheData>, String> {
    get_bunny_cache(crate::common::MarkerId(marker_id))
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_original_text(marker_id: u32, text: String, model: String) -> Result<(), String> {
    update_original_text(crate::common::MarkerId(marker_id), text, model)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_update_machine_translation(marker_id: u32, text: String, service: String) -> Result<(), String> {
    update_machine_translation(crate::common::MarkerId(marker_id), text, service)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn tauri_clear_bunny_cache(marker_id: u32) -> Result<(), String> {
    clear_bunny_cache(crate::common::MarkerId(marker_id))
}