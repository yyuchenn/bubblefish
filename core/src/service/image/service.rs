// Image Service - 处理图片相关的业务逻辑
use std::sync::Arc;
use std::path::PathBuf;
use crate::common::{ImageId, MarkerId};
use crate::common::dto::image::{ImageDTO, ImageDataDTO, ImageFormat as ImageFormatDTO};
use crate::common::dto::marker::MarkerDTO;
use crate::storage::{ImageData, ImageFormat};
use crate::service::events::{DomainEvent, EventBus, EventHandler};
use rayon::prelude::*;
use md5::{Digest, Md5};

pub struct ImageService {
    event_bus: Arc<EventBus>,
}

/// Result of processing an image
#[derive(Debug, Clone)]
pub struct ImageProcessingResult {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub checksum: Option<String>,
    pub format: ImageFormat,
}

impl ImageService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }
    
    // === 图片创建操作 ===
    
    pub fn add_image_from_path(&self, path: PathBuf, name: Option<String>) -> Option<u32> {
        match crate::storage::image::add_image_from_path_storage(path, name) {
            Ok(id) => Some(id.into()),
            Err(_) => None,
        }
    }
    
    pub fn add_image_from_binary(&self, format: ImageFormatDTO, data: Vec<u8>, name: Option<String>) -> Option<u32> {
        // 转换DTO的ImageFormat到storage的ImageFormat
        let storage_format = match format {
            ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
            ImageFormatDTO::Png => ImageFormat::Png,
            ImageFormatDTO::Gif => ImageFormat::Gif,
            ImageFormatDTO::Webp => ImageFormat::Webp,
            ImageFormatDTO::Bmp => ImageFormat::Bmp,
        };
        match crate::storage::image::add_image_from_binary_storage(storage_format, data, name) {
            Ok(id) => Some(id.into()),
            Err(_) => None,
        }
    }
    
    // === 图片查询操作 ===
    
    pub fn get_image(&self, image_id: u32) -> Option<ImageDTO> {
        match crate::storage::image::get_image_storage(ImageId::from(image_id)) {
            Ok(opt) => opt.map(|arc| arc.to_dto()),
            Err(_) => None,
        }
    }
    
    pub fn get_image_binary_data(&self, image_id: u32) -> Result<Vec<u8>, String> {
        if let Some(image) = crate::storage::image::get_image_storage(ImageId::from(image_id)).ok().flatten() {
            self.get_image_data_for_display(&image.data)
        } else {
            Err("Image not found".to_string())
        }
    }
    
    pub fn get_image_file_path(&self, image_id: u32) -> Option<String> {
        if let Some(image) = crate::storage::image::get_image_storage(ImageId::from(image_id)).ok().flatten() {
            match &image.data {
                ImageData::FilePath(path) => Some(path.to_string_lossy().to_string()),
                _ => None,
            }
        } else {
            None
        }
    }
    
    pub fn get_image_mime_type(&self, image_id: u32) -> Option<String> {
        if let Some(image) = crate::storage::image::get_image_storage(ImageId::from(image_id)).ok().flatten() {
            self.get_image_mime_type_internal(&image.data)
        } else {
            None
        }
    }
    
    pub fn image_exists(&self, image_id: u32) -> bool {
        match crate::storage::image::image_exists_storage(ImageId::from(image_id)) {
            Ok(exists) => exists,
            Err(_) => false,
        }
    }
    
    // === 图片更新操作 ===
    
    pub fn update_image(&self, image_id: u32, data: Option<ImageDataDTO>, name: Option<String>) -> bool {
        let storage_data = data.map(|d| match d {
            ImageDataDTO::FilePath(path) => ImageData::FilePath(path),
            ImageDataDTO::Binary { format, data } => ImageData::Binary {
                format: match format {
                    ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
                    ImageFormatDTO::Png => ImageFormat::Png,
                    ImageFormatDTO::Gif => ImageFormat::Gif,
                    ImageFormatDTO::Webp => ImageFormat::Webp,
                    ImageFormatDTO::Bmp => ImageFormat::Bmp,
                },
                data,
            },
            ImageDataDTO::SharedBuffer { format, buffer_id } => ImageData::SharedBuffer {
                format: match format {
                    ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
                    ImageFormatDTO::Png => ImageFormat::Png,
                    ImageFormatDTO::Gif => ImageFormat::Gif,
                    ImageFormatDTO::Webp => ImageFormat::Webp,
                    ImageFormatDTO::Bmp => ImageFormat::Bmp,
                },
                buffer_id,
            },
        });
        let result = match crate::storage::image::update_image_storage(ImageId::from(image_id), storage_data, name) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ImageUpdated(ImageId::from(image_id)));
        }
        
        result
    }
    
    pub fn update_image_data(&self, image_id: u32, data: ImageDataDTO) -> bool {
        let storage_data = match data {
            ImageDataDTO::FilePath(path) => ImageData::FilePath(path),
            ImageDataDTO::Binary { format, data } => ImageData::Binary {
                format: match format {
                    ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
                    ImageFormatDTO::Png => ImageFormat::Png,
                    ImageFormatDTO::Gif => ImageFormat::Gif,
                    ImageFormatDTO::Webp => ImageFormat::Webp,
                    ImageFormatDTO::Bmp => ImageFormat::Bmp,
                },
                data,
            },
            ImageDataDTO::SharedBuffer { format, buffer_id } => ImageData::SharedBuffer {
                format: match format {
                    ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
                    ImageFormatDTO::Png => ImageFormat::Png,
                    ImageFormatDTO::Gif => ImageFormat::Gif,
                    ImageFormatDTO::Webp => ImageFormat::Webp,
                    ImageFormatDTO::Bmp => ImageFormat::Bmp,
                },
                buffer_id,
            },
        };
        let result = match crate::storage::image::update_image_data_storage(ImageId::from(image_id), storage_data) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ImageUpdated(ImageId::from(image_id)));
        }
        
        result
    }
    
    pub fn update_image_name(&self, image_id: u32, name: Option<String>) -> bool {
        let result = match crate::storage::image::update_image_name_storage(ImageId::from(image_id), name) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ImageUpdated(ImageId::from(image_id)));
        }
        
        result
    }
    
    // === 图片删除操作 ===
    
    pub fn remove_image(&self, image_id: u32) -> bool {
        let result = match crate::storage::image::delete_image_storage(ImageId::from(image_id)) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::ImageDeleted(ImageId::from(image_id)));
        }
        
        result
    }
    
    // === 标记相关操作 ===
    
    pub fn get_image_markers(&self, image_id: u32) -> Vec<MarkerDTO> {
        let services = crate::service::get_service();
        match services.marker_service.get_image_markers(ImageId::from(image_id)) {
            Ok(markers) => markers,
            Err(_) => Vec::new(),
        }
    }
    
    pub fn add_marker_to_image(&self, image_id: u32, marker_id: u32) -> bool {
        match crate::storage::image::add_marker_to_image_storage(ImageId::from(image_id), MarkerId::from(marker_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn remove_marker_from_image(&self, image_id: u32, marker_id: u32) -> bool {
        match crate::storage::image::remove_marker_from_image_storage(ImageId::from(image_id), MarkerId::from(marker_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn clear_image_markers(&self, image_id: u32) -> bool {
        match crate::storage::image::clear_image_markers_storage(ImageId::from(image_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn get_image_marker_ids(&self, image_id: u32) -> crate::common::CoreResult<Vec<u32>> {
        Ok(crate::storage::image::get_image_marker_ids_storage(ImageId::from(image_id))?
            .into_iter()
            .map(|id| id.into())
            .collect())
    }
    
    pub fn image_count(&self) -> crate::common::CoreResult<usize> {
        crate::storage::image::image_count_storage()
    }
    
    // === 清理操作 ===
    
    pub fn clear_all(&self) {
        let _ = crate::storage::image::clear_all_images_storage();
    }
    
    // === 实用工具函数 ===
    
    /// 从ImageData获取数据用于显示
    fn get_image_data_for_display(&self, image_data: &ImageData) -> Result<Vec<u8>, String> {
        match image_data {
            ImageData::Binary { data, .. } => Ok((**data).clone()),
            ImageData::FilePath(path) => {
                std::fs::read(path)
                    .map_err(|e| format!("Failed to read file: {}", e))
            }
            ImageData::SharedBuffer { .. } => Err("Cannot get binary data from shared buffer".to_string()),
        }
    }
    
    /// 获取ImageData的MIME类型
    fn get_image_mime_type_internal(&self, image_data: &ImageData) -> Option<String> {
        match image_data {
            ImageData::Binary { format, .. } => Some(format.mime_type().to_string()),
            ImageData::SharedBuffer { format, .. } => Some(format.mime_type().to_string()),
            ImageData::FilePath(path) => {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .and_then(ImageFormat::from_extension)
                    .map(|format| format.mime_type().to_string())
            }
        }
    }
    
    // === 图像处理相关 ===
    
    /// Process a single image - extract dimensions and calculate checksum in parallel
    pub fn process_image_parallel(&self, data: &[u8], format: &ImageFormat) -> ImageProcessingResult {
        // Use rayon to parallelize dimension extraction and checksum calculation
        let (dimensions, checksum) = rayon::join(
            || self.extract_dimensions(data, format),
            || self.calculate_checksum(data),
        );
        
        ImageProcessingResult {
            width: dimensions.0,
            height: dimensions.1,
            checksum: Some(checksum),
            format: format.clone(),
        }
    }
    
    /// Extract image dimensions
    fn extract_dimensions(&self, data: &[u8], format: &ImageFormat) -> (Option<u32>, Option<u32>) {
        match crate::storage::dimension_extractor::extract_dimensions_from_bytes(data, format) {
            Some((width, height)) => (Some(width), Some(height)),
            None => (None, None),
        }
    }
    
    /// Calculate MD5 checksum of image data
    fn calculate_checksum(&self, data: &[u8]) -> String {
        let mut hasher = Md5::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
    
    /// Process multiple images in parallel
    pub fn process_images_batch(&self, images: Vec<(Vec<u8>, ImageFormat)>) -> Vec<ImageProcessingResult> {
        images
            .into_par_iter()
            .map(|(data, format)| self.process_image_parallel(&data, &format))
            .collect()
    }
}

// 实现事件处理器 - 自动处理级联删除
impl EventHandler for ImageService {
    fn handle(&self, event: &DomainEvent) {
        match event {
            // 项目即将删除时，删除所有相关图片
            DomainEvent::ProjectDeleting(project_id) => {
                // 获取项目的所有图片
                let services = crate::service::get_service();
                if let Ok(Some(project)) = services.project_service.get_project_by_id(*project_id) {
                    let image_ids = project.image_ids.clone();
                    
                    // 发布批量删除事件
                    if !image_ids.is_empty() {
                        self.event_bus.publish(DomainEvent::ProjectImagesDeleting(*project_id, image_ids.clone()));
                        
                        // 删除每个图片
                        for image_id in image_ids {
                            // 清理图片的markers (项目删除时不需要记录撤销)
                            let _ = services.marker_service.take_image_markers(image_id);
                            
                            // 删除图片
                            self.remove_image(image_id.0);
                            
                            // 发布图片已删除事件
                            self.event_bus.publish(DomainEvent::ImageDeleted(image_id));
                        }
                    }
                }
            },
            // 清空所有数据时，清理所有图片
            DomainEvent::AllDataClearing => {
                self.clear_all();
            },
            _ => {}
        }
    }
}