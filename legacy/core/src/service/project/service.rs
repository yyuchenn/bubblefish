// Project Service - 处理项目相关的业务逻辑
use std::sync::Arc;
use crate::common::{CoreResult, ProjectId, ImageId, Language};
use crate::common::dto::project::ProjectDTO;
use crate::common::dto::image::ImageDTO;
use crate::storage::project::{self as storage};
use crate::storage::state::APP_STATE;
use crate::service::events::{DomainEvent, EventBus, EventHandler};

pub struct ProjectService {
    event_bus: Arc<EventBus>,
}

impl ProjectService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }
    
    // === 基础项目操作 ===
    
    pub fn create_project(&self, name: String) -> CoreResult<ProjectId> {
        storage::create_project_storage(name)
    }
    
    pub fn get_project(&self, project_id: u32) -> Option<ProjectDTO> {
        match self.get_project_by_id(ProjectId::from(project_id)) {
            Ok(opt) => opt,
            Err(_) => None,
        }
    }
    
    pub fn get_project_by_id(&self, id: ProjectId) -> CoreResult<Option<ProjectDTO>> {
        Ok(storage::get_project_storage(id)?.map(|p| p.to_dto()))
    }
    
    pub fn get_all_projects(&self) -> Vec<ProjectDTO> {
        match self.get_all_projects_core() {
            Ok(projects) => projects,
            Err(_) => Vec::new(),
        }
    }
    
    pub fn get_all_projects_core(&self) -> CoreResult<Vec<ProjectDTO>> {
        Ok(storage::get_all_projects_storage()?
            .into_iter()
            .map(|p| p.to_dto())
            .collect())
    }
    
    pub fn update_project_name_internal(&self, project_id: u32, name: String) -> bool {
        let result = match self.update_project_name_core(ProjectId::from(project_id), name.clone()) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ProjectNameUpdated(
                ProjectId::from(project_id),
                name
            ));
        }
        
        result
    }
    
    pub fn update_project_name_core(&self, id: ProjectId, name: String) -> CoreResult<bool> {
        storage::update_project_name_storage(id, name)
    }
    
    pub fn update_project_languages_internal(&self, project_id: u32, source_language: Language, target_language: Language) -> bool {
        let result = match self.update_project_languages_core(
            ProjectId::from(project_id), 
            source_language, 
            target_language
        ) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ProjectLanguagesUpdated(
                ProjectId::from(project_id),
                source_language,
                target_language
            ));
        }
        
        result
    }
    
    pub fn update_project_languages_core(&self, id: ProjectId, source_language: Language, target_language: Language) -> CoreResult<bool> {
        storage::update_project_languages_storage(id, source_language, target_language)
    }
    
    pub fn delete_project(&self, project_id: u32) -> bool {
        match self.delete_project_core(ProjectId::from(project_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn delete_project_core(&self, id: ProjectId) -> CoreResult<bool> {
        storage::delete_project_storage(id)
    }
    
    pub fn project_exists(&self, project_id: u32) -> bool {
        match self.project_exists_core(ProjectId::from(project_id)) {
            Ok(exists) => exists,
            Err(_) => false,
        }
    }
    
    pub fn project_exists_core(&self, id: ProjectId) -> CoreResult<bool> {
        storage::project_exists_storage(id)
    }
    
    pub fn project_count(&self) -> CoreResult<usize> {
        storage::project_count_storage()
    }
    
    // === 图片相关操作 ===
    
    pub fn get_project_images(&self, project_id: u32) -> Vec<ImageDTO> {
        match self.get_project_images_core(ProjectId::from(project_id)) {
            Ok(images) => images,
            Err(_) => Vec::new(),
        }
    }
    
    pub fn get_project_images_core(&self, project_id: ProjectId) -> CoreResult<Vec<ImageDTO>> {
        let image_ids = self.get_project_image_ids(project_id)?;
        let mut images = Vec::new();
        for id in image_ids {
            if let Some(image) = APP_STATE.get_image(id)? {
                images.push(image.to_dto());
            }
        }
        Ok(images)
    }
    
    pub fn get_project_image_ids(&self, project_id: ProjectId) -> CoreResult<Vec<ImageId>> {
        storage::get_project_image_ids_storage(project_id)
    }
    
    pub fn get_project_images_metadata(&self, project_id: u32) -> Vec<crate::common::dto::image::ImageMetadataDTO> {
        match self.get_project_images_core(ProjectId::from(project_id)) {
            Ok(images) => images.into_iter().map(|img| img.metadata).collect(),
            Err(_) => Vec::new(),
        }
    }
    
    pub fn add_image_to_project(&self, project_id: u32, image_id: u32) -> bool {
        match self.add_image_to_project_core(ProjectId::from(project_id), ImageId::from(image_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn add_image_to_project_core(&self, project_id: ProjectId, image_id: ImageId) -> CoreResult<bool> {
        storage::add_image_to_project_storage(project_id, image_id)
    }
    
    pub fn remove_image_from_project(&self, project_id: u32, image_id: u32) -> bool {
        match self.remove_image_from_project_core(ProjectId::from(project_id), ImageId::from(image_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn remove_image_from_project_core(&self, project_id: ProjectId, image_id: ImageId) -> CoreResult<bool> {
        storage::remove_image_from_project_storage(project_id, image_id)
    }
    
    pub fn reorder_project_images(&self, project_id: u32, image_ids: Vec<u32>) -> bool {
        let new_order = image_ids.into_iter().map(ImageId::from).collect();
        match self.reorder_project_images_core(ProjectId::from(project_id), new_order) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn reorder_project_images_core(&self, project_id: ProjectId, new_order: Vec<ImageId>) -> CoreResult<bool> {
        storage::reorder_project_images_storage(project_id, new_order)
    }
    
    pub fn find_project_by_image(&self, image_id: ImageId) -> CoreResult<Option<ProjectId>> {
        storage::find_project_by_image_storage(image_id)
    }
    
    pub fn clear_project_images(&self, project_id: ProjectId) -> CoreResult<bool> {
        storage::clear_project_images_storage(project_id)
    }
    
    // === 清理操作 ===
    
    pub fn clear_all(&self) {
        let _ = self.clear_all_projects();
    }
    
    pub fn clear_all_projects(&self) -> CoreResult<()> {
        storage::clear_all_projects_storage()
    }
    
    #[cfg(test)]
    pub fn reset_project_storage(&self) -> CoreResult<()> {
        self.clear_all_projects()
    }
}

// 实现事件处理器 - 监听项目相关事件
impl EventHandler for ProjectService {
    fn handle(&self, event: &DomainEvent) {
        match event {
            // 清空所有数据时，清理所有项目
            DomainEvent::AllDataClearing => {
                self.clear_all();
            },
            _ => {}
        }
    }
}