/// 完全自动化的 Tauri 命令注册系统
/// 
/// 使用宏来自动生成和注册所有 core 命令

/// 定义所有需要自动注册的命令
/// 当添加新的业务模块时，只需要在这里添加即可
/// 生成只包含core命令的handler
#[macro_export]
macro_rules! generate_core_commands {
    () => {
        tauri::generate_handler![
            // Data bindings 模块的命令（主要功能）
            // 临时项目命令
            $crate::bindings::tauri::tauri_create_empty_opening_project,
            $crate::bindings::tauri::tauri_create_opening_project_from_path,
            $crate::bindings::tauri::tauri_create_opening_project_from_binary,
            $crate::bindings::tauri::tauri_get_opening_project_info,
            $crate::bindings::tauri::tauri_flush_opening_project_images,
            $crate::bindings::tauri::tauri_finalize_opening_project,
            $crate::bindings::tauri::tauri_delete_opening_project,
            // 项目命令
            $crate::bindings::tauri::tauri_get_project_info,
            $crate::bindings::tauri::tauri_get_all_projects_info,
            $crate::bindings::tauri::tauri_update_project_name,
            $crate::bindings::tauri::tauri_update_project_languages,
            $crate::bindings::tauri::tauri_delete_project,
            $crate::bindings::tauri::tauri_get_project_images,
            $crate::bindings::tauri::tauri_get_project_images_metadata,
            $crate::bindings::tauri::tauri_add_image_from_path_to_project,
            $crate::bindings::tauri::tauri_add_image_from_binary_to_project,
            $crate::bindings::tauri::tauri_get_image_info,
            $crate::bindings::tauri::tauri_update_image_info,
            $crate::bindings::tauri::tauri_update_image_data_from_path,
            $crate::bindings::tauri::tauri_update_image_data_from_binary,
            $crate::bindings::tauri::tauri_remove_image_from_project,
            $crate::bindings::tauri::tauri_reorder_project_images,
            $crate::bindings::tauri::tauri_get_image_markers,
            $crate::bindings::tauri::tauri_add_point_marker_to_image,
            $crate::bindings::tauri::tauri_add_rectangle_marker_to_image,
            $crate::bindings::tauri::tauri_get_marker_info,
            $crate::bindings::tauri::tauri_update_point_marker_position,
            $crate::bindings::tauri::tauri_update_rectangle_marker_geometry,
            $crate::bindings::tauri::tauri_update_marker_translation,
            $crate::bindings::tauri::tauri_update_marker_style,
            $crate::bindings::tauri::tauri_move_marker_order,
            $crate::bindings::tauri::tauri_update_point_marker_full,
            $crate::bindings::tauri::tauri_update_rectangle_marker_full,
            $crate::bindings::tauri::tauri_remove_marker_from_image,
            $crate::bindings::tauri::tauri_clear_image_markers,
            $crate::bindings::tauri::tauri_get_stats,
            $crate::bindings::tauri::tauri_get_project_stats,
            $crate::bindings::tauri::tauri_clear_all_data,
            $crate::bindings::tauri::tauri_clear_project_data,
            $crate::bindings::tauri::tauri_get_image_binary_data,
            $crate::bindings::tauri::tauri_get_image_mime_type,
            $crate::bindings::tauri::tauri_get_image_file_path,
            // 缩略图命令
            $crate::bindings::tauri::tauri_request_thumbnail,
            $crate::bindings::tauri::tauri_get_thumbnail,
            $crate::bindings::tauri::tauri_has_thumbnail,
            // 撤销重做命令
            $crate::bindings::tauri::tauri_undo,
            $crate::bindings::tauri::tauri_redo,
            $crate::bindings::tauri::tauri_clear_undo_redo_history,
            $crate::bindings::tauri::tauri_clear_all_undo_redo_history,
            // LabelPlus文件命令
            $crate::bindings::tauri::tauri_validate_labelplus_file,
            $crate::bindings::tauri::tauri_import_labelplus_data,
            $crate::bindings::tauri::tauri_export_labelplus_data,
            // 项目保存命令
            $crate::bindings::tauri::tauri_save_project
        ]
    };
}

/// 生成包含desktop和core命令的完整handler
#[macro_export]
macro_rules! generate_all_commands {
    ($($desktop_cmd:path),*) => {
        tauri::generate_handler![
            // Desktop 特有命令
            $($desktop_cmd),*,
            // Core 命令
            // 临时项目命令
            $crate::bindings::tauri::tauri_create_empty_opening_project,
            $crate::bindings::tauri::tauri_create_opening_project_from_path,
            $crate::bindings::tauri::tauri_create_opening_project_from_binary,
            $crate::bindings::tauri::tauri_get_opening_project_info,
            $crate::bindings::tauri::tauri_flush_opening_project_images,
            $crate::bindings::tauri::tauri_finalize_opening_project,
            $crate::bindings::tauri::tauri_delete_opening_project,
            // 项目命令
            $crate::bindings::tauri::tauri_get_project_info,
            $crate::bindings::tauri::tauri_get_all_projects_info,
            $crate::bindings::tauri::tauri_update_project_name,
            $crate::bindings::tauri::tauri_update_project_languages,
            $crate::bindings::tauri::tauri_delete_project,
            $crate::bindings::tauri::tauri_get_project_images,
            $crate::bindings::tauri::tauri_get_project_images_metadata,
            $crate::bindings::tauri::tauri_add_image_from_path_to_project,
            $crate::bindings::tauri::tauri_add_image_from_binary_to_project,
            $crate::bindings::tauri::tauri_get_image_info,
            $crate::bindings::tauri::tauri_update_image_info,
            $crate::bindings::tauri::tauri_update_image_data_from_path,
            $crate::bindings::tauri::tauri_update_image_data_from_binary,
            $crate::bindings::tauri::tauri_remove_image_from_project,
            $crate::bindings::tauri::tauri_reorder_project_images,
            $crate::bindings::tauri::tauri_get_image_markers,
            $crate::bindings::tauri::tauri_add_point_marker_to_image,
            $crate::bindings::tauri::tauri_add_rectangle_marker_to_image,
            $crate::bindings::tauri::tauri_get_marker_info,
            $crate::bindings::tauri::tauri_update_point_marker_position,
            $crate::bindings::tauri::tauri_update_rectangle_marker_geometry,
            $crate::bindings::tauri::tauri_update_marker_translation,
            $crate::bindings::tauri::tauri_update_marker_style,
            $crate::bindings::tauri::tauri_move_marker_order,
            $crate::bindings::tauri::tauri_update_point_marker_full,
            $crate::bindings::tauri::tauri_update_rectangle_marker_full,
            $crate::bindings::tauri::tauri_remove_marker_from_image,
            $crate::bindings::tauri::tauri_clear_image_markers,
            $crate::bindings::tauri::tauri_get_stats,
            $crate::bindings::tauri::tauri_get_project_stats,
            $crate::bindings::tauri::tauri_clear_all_data,
            $crate::bindings::tauri::tauri_clear_project_data,
            $crate::bindings::tauri::tauri_get_image_binary_data,
            $crate::bindings::tauri::tauri_get_image_mime_type,
            $crate::bindings::tauri::tauri_get_image_file_path,
            // 缩略图命令
            $crate::bindings::tauri::tauri_request_thumbnail,
            $crate::bindings::tauri::tauri_get_thumbnail,
            $crate::bindings::tauri::tauri_has_thumbnail,
            // 撤销重做命令
            $crate::bindings::tauri::tauri_undo,
            $crate::bindings::tauri::tauri_redo,
            $crate::bindings::tauri::tauri_clear_undo_redo_history,
            $crate::bindings::tauri::tauri_clear_all_undo_redo_history,
            // LabelPlus文件命令
            $crate::bindings::tauri::tauri_validate_labelplus_file,
            $crate::bindings::tauri::tauri_import_labelplus_data,
            $crate::bindings::tauri::tauri_export_labelplus_data,
            // 项目保存命令
            $crate::bindings::tauri::tauri_save_project
        ]
    };
}

/// 向后兼容的别名
#[macro_export]
macro_rules! generate_all_core_commands {
    () => {
        $crate::generate_core_commands!()
    };
}

/// 设置所有 core 模块的回调
#[cfg(feature = "tauri")]
pub fn setup_all_core_callbacks(_app_handle: tauri::AppHandle) {
    // 未来添加新模块时，只需要在这里添加一行
    // crate::new_module::setup_new_module_callbacks(_app_handle.clone());
}
