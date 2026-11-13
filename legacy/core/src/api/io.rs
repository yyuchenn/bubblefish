use crate::common::{log_function_call, ProjectId};
use crate::service::io::labelplus::{
    LabelplusData,
    validate_labelplus_file as service_validate_labelplus_file,
    import_labelplus_data_direct as service_import_labelplus_data_direct,
    export_labelplus_data as service_export_labelplus_data,
};
use crate::service::io::bf::{
    save_project as service_save_project,
    save_project_to_path as service_save_project_to_path,
};
use crate::storage::project::update_project_file_path_storage;

pub fn validate_labelplus_file(content: &str) -> Result<LabelplusData, String> {
    log_function_call("validate_labelplus_file", Some(serde_json::json!({"content_len": content.len()})));
    service_validate_labelplus_file(content)
        .map_err(|e| e.to_string())
}

pub fn import_labelplus_data(project_id: u32, content: &str) -> Result<(), String> {
    log_function_call("import_labelplus_data", Some(serde_json::json!({"project_id": project_id, "content_len": content.len()})));
    match service_validate_labelplus_file(content) {
        Ok(data) => {
            service_import_labelplus_data_direct(
                ProjectId::from(project_id),
                data
            ).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string())
    }
}

pub fn export_labelplus_data(project_id: u32) -> Result<String, String> {
    log_function_call("export_labelplus_data", Some(serde_json::json!({"project_id": project_id})));
    service_export_labelplus_data(ProjectId::from(project_id))
        .map_err(|e| e.to_string())
}

pub fn save_project(project_id: u32) -> Result<Vec<u8>, String> {
    log_function_call("save_project", Some(serde_json::json!({"project_id": project_id})));
    service_save_project(ProjectId::from(project_id))
        .map_err(|e| e.to_string())
}

pub fn save_project_to_path(project_id: u32, path: &str) -> Result<Vec<u8>, String> {
    log_function_call("save_project_to_path", Some(serde_json::json!({"project_id": project_id, "path": path})));
    service_save_project_to_path(ProjectId::from(project_id), path)
        .map_err(|e| e.to_string())
}

pub fn update_project_file_path(project_id: u32, file_path: Option<String>) -> Result<bool, String> {
    log_function_call("update_project_file_path", Some(serde_json::json!({"project_id": project_id, "file_path": file_path})));
    update_project_file_path_storage(ProjectId::from(project_id), file_path)
        .map_err(|e| e.to_string())
}