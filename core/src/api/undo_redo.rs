use serde::{Deserialize, Serialize};
use crate::common::{Logger, log_function_call};
use crate::service::get_service;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoRedoResult {
    pub success: bool,
    pub image_id: Option<u32>,
    pub marker_id: Option<u32>,
}

/// 执行撤销操作
pub fn undo(project_id: u32) -> UndoRedoResult {
    log_function_call("undo", Some(serde_json::json!({ "project_id": project_id })));
    
    let service = get_service();
    let result = service.undo_redo_service.undo(project_id);
    
    if result.success {
        Logger::info_with_data(
            "撤销操作成功",
            serde_json::json!({
                "image_id": result.image_id.unwrap_or(0),
                "marker_id": result.marker_id.unwrap_or(0)
            })
        );
    } else {
        Logger::info("没有可撤销的操作");
    }
    
    result
}

/// 执行重做操作
pub fn redo(project_id: u32) -> UndoRedoResult {
    log_function_call("redo", Some(serde_json::json!({ "project_id": project_id })));
    
    let service = get_service();
    let result = service.undo_redo_service.redo(project_id);
    
    if result.success {
        Logger::info_with_data(
            "重做操作成功",
            serde_json::json!({
                "image_id": result.image_id.unwrap_or(0),
                "marker_id": result.marker_id.unwrap_or(0)
            })
        );
    } else {
        Logger::info("没有可重做的操作");
    }
    
    result
}

/// 清空撤销重做历史
pub fn clear_undo_redo_history(project_id: u32) {
    log_function_call("clear_undo_redo_history", Some(serde_json::json!({ "project_id": project_id })));
    let service = get_service();
    service.undo_redo_service.clear_project_history(project_id);
}

/// 清空所有项目的撤销重做历史
pub fn clear_all_undo_redo_history() {
    log_function_call("clear_all_undo_redo_history", None);
    let service = get_service();
    service.undo_redo_service.clear_all_history();
}