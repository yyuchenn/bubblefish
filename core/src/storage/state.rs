use crate::common::{CoreError, CoreResult};
use crate::common::{ProjectId, ImageId, MarkerId};
use crate::storage::traits::Storage;
use crate::storage::project::Project;
use crate::storage::marker::Marker;
use crate::storage::image::Image;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

// Project Storage
#[derive(Debug, Default)]
pub struct ProjectStorage {
    pub(crate) projects: HashMap<ProjectId, Project>,
}

impl Storage<ProjectId, Project> for ProjectStorage {
    type Iter<'a> = std::collections::hash_map::Iter<'a, ProjectId, Project> where Self: 'a;

    fn insert(&mut self, key: ProjectId, value: Project) -> CoreResult<()> {
        self.projects.insert(key, value);
        Ok(())
    }

    fn get(&self, key: &ProjectId) -> Option<&Project> {
        self.projects.get(key)
    }

    fn get_mut(&mut self, key: &ProjectId) -> Option<&mut Project> {
        self.projects.get_mut(key)
    }

    fn remove(&mut self, key: &ProjectId) -> Option<Project> {
        self.projects.remove(key)
    }

    fn contains(&self, key: &ProjectId) -> bool {
        self.projects.contains_key(key)
    }

    fn clear(&mut self) {
        self.projects.clear();
    }

    fn iter(&self) -> Self::Iter<'_> {
        self.projects.iter()
    }
}

// Image Storage with memory tracking
#[derive(Debug)]
pub struct ImageStorage {
    pub(crate) images: HashMap<ImageId, Arc<Image>>,
    pub(crate) current_memory: usize,
    pub(crate) max_memory: usize,
}

impl Default for ImageStorage {
    fn default() -> Self {
        // Different memory limits for different platforms
        #[cfg(target_arch = "wasm32")]
        let max_memory = 2 * 1024 * 1024 * 1024; // 2GB for WASM
        
        #[cfg(not(target_arch = "wasm32"))]
        let max_memory = 4 * 1024 * 1024 * 1024; // 4GB for native
        
        Self {
            images: HashMap::new(),
            current_memory: 0,
            max_memory,
        }
    }
}

impl ImageStorage {
    pub fn new(max_memory: usize) -> Self {
        Self {
            images: HashMap::new(),
            current_memory: 0,
            max_memory,
        }
    }

    pub fn insert_with_memory_check(&mut self, id: ImageId, image: Image) -> CoreResult<()> {
        let image_size = image.estimated_size();
        
        if self.current_memory + image_size > self.max_memory {
            return Err(CoreError::MemoryLimitExceeded {
                requested: image_size,
                available: self.max_memory - self.current_memory,
            });
        }

        self.images.insert(id, Arc::new(image));
        self.current_memory += image_size;
        Ok(())
    }

    pub fn get_arc(&self, id: &ImageId) -> Option<Arc<Image>> {
        self.images.get(id).cloned()
    }

    pub fn current_memory_usage(&self) -> usize {
        self.current_memory
    }
}

impl Storage<ImageId, Arc<Image>> for ImageStorage {
    type Iter<'a> = std::collections::hash_map::Iter<'a, ImageId, Arc<Image>> where Self: 'a;

    fn insert(&mut self, key: ImageId, value: Arc<Image>) -> CoreResult<()> {
        let image_size = value.estimated_size();
        self.images.insert(key, value);
        self.current_memory += image_size;
        Ok(())
    }

    fn get(&self, key: &ImageId) -> Option<&Arc<Image>> {
        self.images.get(key)
    }

    fn get_mut(&mut self, key: &ImageId) -> Option<&mut Arc<Image>> {
        self.images.get_mut(key)
    }

    fn remove(&mut self, key: &ImageId) -> Option<Arc<Image>> {
        if let Some(image) = self.images.remove(key) {
            self.current_memory = self.current_memory.saturating_sub(image.estimated_size());
            Some(image)
        } else {
            None
        }
    }

    fn contains(&self, key: &ImageId) -> bool {
        self.images.contains_key(key)
    }

    fn clear(&mut self) {
        self.images.clear();
        self.current_memory = 0;
    }

    fn iter(&self) -> Self::Iter<'_> {
        self.images.iter()
    }
}

// Marker Storage
#[derive(Debug, Default)]
pub struct MarkerStorage {
    pub(crate) markers: HashMap<MarkerId, Marker>,
    pub(crate) by_image: HashMap<ImageId, Vec<MarkerId>>,
}

impl MarkerStorage {
    pub fn insert_with_image(&mut self, marker: Marker) -> CoreResult<MarkerId> {
        let id = marker.id;
        let image_id = marker.image_id;
        
        self.markers.insert(id, marker);
        self.by_image.entry(image_id).or_default().push(id);
        
        Ok(id)
    }

    pub fn get_by_image(&self, image_id: &ImageId) -> Vec<&Marker> {
        self.by_image
            .get(image_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.markers.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn remove_with_cleanup(&mut self, id: &MarkerId) -> Option<Marker> {
        if let Some(marker) = self.markers.remove(id) {
            // Clean up by_image index
            if let Some(ids) = self.by_image.get_mut(&marker.image_id) {
                ids.retain(|&mid| mid != *id);
                if ids.is_empty() {
                    self.by_image.remove(&marker.image_id);
                }
            }
            Some(marker)
        } else {
            None
        }
    }
}

impl Storage<MarkerId, Marker> for MarkerStorage {
    type Iter<'a> = std::collections::hash_map::Iter<'a, MarkerId, Marker> where Self: 'a;

    fn insert(&mut self, key: MarkerId, value: Marker) -> CoreResult<()> {
        self.markers.insert(key, value);
        Ok(())
    }

    fn get(&self, key: &MarkerId) -> Option<&Marker> {
        self.markers.get(key)
    }

    fn get_mut(&mut self, key: &MarkerId) -> Option<&mut Marker> {
        self.markers.get_mut(key)
    }

    fn remove(&mut self, key: &MarkerId) -> Option<Marker> {
        self.markers.remove(key)
    }

    fn contains(&self, key: &MarkerId) -> bool {
        self.markers.contains_key(key)
    }

    fn clear(&mut self) {
        self.markers.clear();
        self.by_image.clear();
    }

    fn iter(&self) -> Self::Iter<'_> {
        self.markers.iter()
    }
}

// Thumbnail Storage
#[derive(Debug, Default)]
pub struct ThumbnailStorage {
    thumbnails: HashMap<ImageId, Vec<u8>>,
}

impl Storage<ImageId, Vec<u8>> for ThumbnailStorage {
    type Iter<'a> = std::collections::hash_map::Iter<'a, ImageId, Vec<u8>> where Self: 'a;

    fn insert(&mut self, key: ImageId, value: Vec<u8>) -> CoreResult<()> {
        self.thumbnails.insert(key, value);
        Ok(())
    }

    fn get(&self, key: &ImageId) -> Option<&Vec<u8>> {
        self.thumbnails.get(key)
    }

    fn get_mut(&mut self, key: &ImageId) -> Option<&mut Vec<u8>> {
        self.thumbnails.get_mut(key)
    }

    fn remove(&mut self, key: &ImageId) -> Option<Vec<u8>> {
        self.thumbnails.remove(key)
    }

    fn contains(&self, key: &ImageId) -> bool {
        self.thumbnails.contains_key(key)
    }

    fn clear(&mut self) {
        self.thumbnails.clear();
    }

    fn iter(&self) -> Self::Iter<'_> {
        self.thumbnails.iter()
    }
}

// Main Application State
pub struct AppState {
    pub projects: Arc<RwLock<ProjectStorage>>,
    pub images: Arc<RwLock<ImageStorage>>,
    pub markers: Arc<RwLock<MarkerStorage>>,
    pub thumbnails: Arc<RwLock<ThumbnailStorage>>,
    pub bunny_cache: Arc<RwLock<super::bunny_cache::BunnyCacheStorage>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            projects: Arc::new(RwLock::new(ProjectStorage::default())),
            images: Arc::new(RwLock::new(ImageStorage::default())),
            markers: Arc::new(RwLock::new(MarkerStorage::default())),
            thumbnails: Arc::new(RwLock::new(ThumbnailStorage::default())),
            bunny_cache: Arc::new(RwLock::new(super::bunny_cache::BunnyCacheStorage::default())),
        }
    }

    pub fn with_memory_limit(max_memory: usize) -> Self {
        Self {
            projects: Arc::new(RwLock::new(ProjectStorage::default())),
            images: Arc::new(RwLock::new(ImageStorage::new(max_memory))),
            markers: Arc::new(RwLock::new(MarkerStorage::default())),
            thumbnails: Arc::new(RwLock::new(ThumbnailStorage::default())),
            bunny_cache: Arc::new(RwLock::new(super::bunny_cache::BunnyCacheStorage::default())),
        }
    }

    // Helper methods for common operations
    pub fn get_project(&self, id: ProjectId) -> CoreResult<Option<Project>> {
        let storage = self.projects.read()?;
        Ok(storage.get(&id).cloned())
    }

    pub fn get_image(&self, id: ImageId) -> CoreResult<Option<Arc<Image>>> {
        let storage = self.images.read()?;
        Ok(storage.get_arc(&id))
    }

    pub fn get_markers_for_image(&self, image_id: ImageId) -> CoreResult<Vec<Marker>> {
        let storage = self.markers.read()?;
        Ok(storage.get_by_image(&image_id).into_iter().cloned().collect())
    }

    pub fn clear_all(&self) -> CoreResult<()> {
        self.projects.write()?.clear();
        self.images.write()?.clear();
        self.markers.write()?.clear();
        self.thumbnails.write()?.clear();
        self.bunny_cache.write()?.clear();
        Ok(())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// Global app state instance
use once_cell::sync::Lazy;
pub static APP_STATE: Lazy<AppState> = Lazy::new(AppState::new);