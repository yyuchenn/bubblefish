use crate::common::CoreResult;
use crate::common::{ProjectId, ImageId, PROJECT_ID_GENERATOR, Language};
use crate::common::dto::project::ProjectDTO;
use crate::storage::traits::Storage;
use crate::storage::state::APP_STATE;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    #[serde(rename = "imageIds")]
    pub image_ids: Vec<ImageId>,
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(rename = "sourceLanguage", default = "Language::default_source")]
    pub source_language: Language,
    #[serde(rename = "targetLanguage", default = "Language::default_target")]
    pub target_language: Language,
}

impl Project {
    pub fn new(id: ProjectId, name: String) -> Self {
        Self {
            id,
            name,
            image_ids: Vec::new(),
            file_path: None,
            source_language: Language::default_source(),
            target_language: Language::default_target(),
        }
    }

    pub fn to_dto(&self) -> ProjectDTO {
        ProjectDTO {
            id: self.id,
            name: self.name.clone(),
            image_ids: self.image_ids.clone(),
            file_path: self.file_path.clone(),
            source_language: self.source_language,
            target_language: self.target_language,
        }
    }

    pub fn from_dto(dto: ProjectDTO) -> Self {
        Self {
            id: dto.id,
            name: dto.name,
            image_ids: dto.image_ids,
            file_path: dto.file_path,
            source_language: dto.source_language,
            target_language: dto.target_language,
        }
    }
}

// Basic CRUD operations for Project storage
pub fn create_project_storage(name: String) -> CoreResult<ProjectId> {
    let id = PROJECT_ID_GENERATOR.next();
    let project = Project::new(id, name);
    
    let mut storage = APP_STATE.projects.write()?;
    storage.insert(id, project)?;
    Ok(id)
}

pub fn get_project_storage(id: ProjectId) -> CoreResult<Option<Project>> {
    APP_STATE.get_project(id)
}

pub fn get_all_projects_storage() -> CoreResult<Vec<Project>> {
    let storage = APP_STATE.projects.read()?;
    Ok(storage.iter().map(|(_, proj)| proj.clone()).collect())
}

pub fn update_project_name_storage(id: ProjectId, name: String) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&id) {
        project.name = name;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn add_image_to_project_storage(project_id: ProjectId, image_id: ImageId) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&project_id) {
        if !project.image_ids.contains(&image_id) {
            project.image_ids.push(image_id);
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn remove_image_from_project_storage(project_id: ProjectId, image_id: ImageId) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&project_id) {
        project.image_ids.retain(|&id| id != image_id);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn get_project_image_ids_storage(project_id: ProjectId) -> CoreResult<Vec<ImageId>> {
    let storage = APP_STATE.projects.read()?;
    Ok(storage.get(&project_id)
        .map(|proj| proj.image_ids.clone())
        .unwrap_or_default())
}

pub fn reorder_project_images_storage(project_id: ProjectId, new_order: Vec<ImageId>) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&project_id) {
        project.image_ids = new_order;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn find_project_by_image_storage(image_id: ImageId) -> CoreResult<Option<ProjectId>> {
    let storage = APP_STATE.projects.read()?;
    for (project_id, project) in storage.iter() {
        if project.image_ids.contains(&image_id) {
            return Ok(Some(*project_id));
        }
    }
    Ok(None)
}

pub fn clear_project_images_storage(project_id: ProjectId) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&project_id) {
        project.image_ids.clear();
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn delete_project_storage(id: ProjectId) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    Ok(storage.remove(&id).is_some())
}

pub fn clear_all_projects_storage() -> CoreResult<()> {
    let mut storage = APP_STATE.projects.write()?;
    storage.clear();
    Ok(())
}

pub fn project_count_storage() -> CoreResult<usize> {
    let storage = APP_STATE.projects.read()?;
    Ok(storage.iter().count())
}

pub fn project_exists_storage(id: ProjectId) -> CoreResult<bool> {
    let storage = APP_STATE.projects.read()?;
    Ok(storage.contains(&id))
}

pub fn update_project_file_path_storage(id: ProjectId, file_path: Option<String>) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&id) {
        project.file_path = file_path;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn update_project_languages_storage(
    id: ProjectId, 
    source_language: Language, 
    target_language: Language
) -> CoreResult<bool> {
    let mut storage = APP_STATE.projects.write()?;
    if let Some(project) = storage.get_mut(&id) {
        project.source_language = source_language;
        project.target_language = target_language;
        Ok(true)
    } else {
        Ok(false)
    }
}