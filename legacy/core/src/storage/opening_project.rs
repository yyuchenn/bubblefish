use crate::common::{CoreError, CoreResult, ProjectId, ImageId, PROJECT_ID_GENERATOR};
use crate::storage::project::Project;
use crate::service::io::labelplus::LabelplusData;
use crate::service::io::bf::BfProjectData;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use once_cell::sync::Lazy;
use std::path::Path;

/// 标准化文件名用于比较
/// 移除路径分隔符并提取纯文件名
fn normalize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string()
}

/// 临时项目结构，用于管理正在创建的项目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpeningProject {
    /// 内部的项目对象
    pub project: Project,
    /// 完整的图片列表（从文件解析出来的）
    pub required_images: Vec<String>,
    /// 待上传的图片列表
    pub pending_images: Vec<String>,
    /// 已上传的图片映射：图片名称 -> ImageId
    pub uploaded_images: HashMap<String, ImageId>,
    /// labelplus原始数据
    pub labelplus_data: Option<LabelplusData>,
    /// bf原始数据
    pub bf_data: Option<BfProjectData>,
}

impl OpeningProject {
    pub fn new(name: String, required_images: Vec<String>) -> Self {
        let project_id = PROJECT_ID_GENERATOR.next();
        let project = Project::new(project_id, name);
        
        Self {
            project,
            required_images: required_images.clone(),
            pending_images: required_images,
            uploaded_images: HashMap::new(),
            labelplus_data: None,
            bf_data: None,
        }
    }
    
    pub fn empty(name: String) -> Self {
        Self::new(name, Vec::new())
    }
    
    pub fn with_labelplus_data(mut self, data: LabelplusData) -> Self {
        self.labelplus_data = Some(data);
        self
    }
    
    pub fn with_bf_data(mut self, data: BfProjectData) -> Self {
        self.bf_data = Some(data);
        self
    }
    
    /// 检查图片是否是项目需要的
    pub fn is_image_required(&self, image_name: &str) -> bool {
        // 如果没有指定需要的图片列表（新建项目的情况），则接受所有图片
        if self.required_images.is_empty() {
            return true;
        }
        // 标准化图片名称进行比较
        let normalized_name = normalize_file_name(image_name);
        self.required_images.iter().any(|required| {
            normalize_file_name(required) == normalized_name
        })
    }
    
    /// 标记图片已上传
    pub fn mark_image_uploaded(&mut self, image_name: String, image_id: ImageId) {
        // 使用标准化的名称作为key
        let normalized_name = normalize_file_name(&image_name);
        
        // 找到匹配的原始名称
        let matched_name = self.required_images.iter()
            .find(|required| normalize_file_name(required) == normalized_name)
            .cloned()
            .unwrap_or(image_name);
        
        self.uploaded_images.insert(matched_name.clone(), image_id);
        self.pending_images.retain(|name| normalize_file_name(name) != normalized_name);
        
        // 添加到项目的图片列表中
        if !self.project.image_ids.contains(&image_id) {
            self.project.image_ids.push(image_id);
        }
    }
    
    /// 移除不需要的图片
    pub fn remove_unneeded_image(&mut self, image_name: &str) -> Option<ImageId> {
        self.uploaded_images.remove(image_name)
    }
    
    /// 检查所有需要的图片是否都已上传
    pub fn is_complete(&self) -> bool {
        // 如果没有指定需要的图片（新建项目），总是返回true
        if self.required_images.is_empty() {
            return true;
        }
        // 否则检查是否所有需要的图片都已上传
        self.pending_images.is_empty()
    }
    
    /// 准备finalize，返回排序后的项目
    pub fn prepare_finalize(&mut self) -> Project {
        // 如果有required_images，按照其顺序重新排序图片ID
        if !self.required_images.is_empty() {
            let mut ordered_image_ids = Vec::with_capacity(self.required_images.len());
            for image_name in &self.required_images {
                if let Some(&image_id) = self.uploaded_images.get(image_name) {
                    ordered_image_ids.push(image_id);
                }
            }
            self.project.image_ids = ordered_image_ids;
        }
        
        self.project.clone()
    }
}

/// 全局的OpeningProject存储
pub struct OpeningProjectStorage {
    storage: Arc<RwLock<HashMap<ProjectId, OpeningProject>>>,
}

impl OpeningProjectStorage {
    pub fn new() -> Self {
        Self {
            storage: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub fn insert(&self, project_id: ProjectId, opening_project: OpeningProject) -> CoreResult<()> {
        let mut storage = self.storage.write()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        storage.insert(project_id, opening_project);
        Ok(())
    }
    
    pub fn get(&self, project_id: ProjectId) -> CoreResult<Option<OpeningProject>> {
        let storage = self.storage.read()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        Ok(storage.get(&project_id).cloned())
    }
    
    pub fn get_mut<F, R>(&self, project_id: ProjectId, f: F) -> CoreResult<Option<R>>
    where
        F: FnOnce(&mut OpeningProject) -> R,
    {
        let mut storage = self.storage.write()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        Ok(storage.get_mut(&project_id).map(f))
    }
    
    pub fn remove(&self, project_id: ProjectId) -> CoreResult<Option<OpeningProject>> {
        let mut storage = self.storage.write()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        Ok(storage.remove(&project_id))
    }
    
    pub fn exists(&self, project_id: ProjectId) -> bool {
        if let Ok(storage) = self.storage.read() {
            storage.contains_key(&project_id)
        } else {
            false
        }
    }
    
    pub fn list(&self) -> CoreResult<Vec<ProjectId>> {
        let storage = self.storage.read()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        Ok(storage.keys().cloned().collect())
    }
    
    pub fn clear(&self) -> CoreResult<()> {
        let mut storage = self.storage.write()
            .map_err(|_| CoreError::LockPoisoned("OpeningProjectStorage".to_string()))?;
        storage.clear();
        Ok(())
    }
}

impl Default for OpeningProjectStorage {
    fn default() -> Self {
        Self::new()
    }
}

// Global opening project storage instance
pub static OPENING_PROJECT_STORAGE: Lazy<OpeningProjectStorage> = Lazy::new(OpeningProjectStorage::new);