use crate::common::CoreResult;
use crate::common::{ImageId, MarkerId, IMAGE_ID_GENERATOR};
use crate::common::dto::image::{ImageDTO, ImageMetadataDTO, ImageDataDTO, ImageFormat as ImageFormatDTO};
use crate::storage::traits::Storage;
use crate::storage::state::APP_STATE;
use crate::storage::image_data::{ImageData, ImageFormat};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

// Image metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageMetadata {
    pub id: ImageId,
    pub name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<ImageFormat>,
    pub size: Option<u64>,
    pub checksum: Option<String>,
}

// Main Image structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Image {
    pub metadata: ImageMetadata,
    pub data: ImageData,
    pub marker_ids: Vec<MarkerId>,
}

impl Image {
    pub fn new_from_path(id: ImageId, path: PathBuf) -> Self {
        let data = ImageData::FilePath(path.clone());
        
        // Try to read file and process it in parallel
        let (dimensions, checksum) = if let Ok(file_data) = std::fs::read(&path) {
            if let Some(format) = data.get_format() {
                // Process image to extract dimensions and checksum
                        use md5::{Digest, Md5};
                
                let (dimensions, checksum) = rayon::join(
                    || crate::storage::dimension_extractor::extract_dimensions_from_bytes(&file_data, &format),
                    || {
                        let mut hasher = Md5::new();
                        hasher.update(&file_data);
                        format!("{:x}", hasher.finalize())
                    },
                );
                
                let processing_result = (
                    dimensions,
                    Some(checksum)
                );
                (
                    processing_result.0,
                    processing_result.1
                )
            } else {
                (data.get_dimensions(), None)
            }
        } else {
            (data.get_dimensions(), None)
        };
        
        if let Some((width, height)) = dimensions {
            crate::common::Logger::info(&format!(
                "Successfully extracted dimensions from file: {}x{} (path: {:?})",
                width, height, path
            ));
        }
        
        if let Some(ref checksum) = checksum {
            crate::common::Logger::info(&format!(
                "Calculated MD5 checksum for file: {}",
                checksum
            ));
        }
        
        Self {
            metadata: ImageMetadata {
                id,
                name: None,
                width: dimensions.map(|(w, _)| w),
                height: dimensions.map(|(_, h)| h),
                format: data.get_format(),
                size: data.get_size(),
                checksum,
            },
            data,
            marker_ids: Vec::new(),
        }
    }

    pub fn new_from_binary(id: ImageId, format: ImageFormat, data: Vec<u8>) -> Self {
        // Process image to extract dimensions and checksum in parallel
        use md5::{Digest, Md5};
        
        let (dimensions, checksum) = rayon::join(
            || crate::storage::dimension_extractor::extract_dimensions_from_bytes(&data, &format),
            || {
                let mut hasher = Md5::new();
                hasher.update(&data);
                Some(format!("{:x}", hasher.finalize()))
            },
        );
        
        if let Some((width, height)) = dimensions {
            crate::common::Logger::info(&format!(
                "Successfully extracted dimensions from binary data: {}x{} (format: {:?})",
                width, height, format
            ));
        }
        
        if let Some(ref checksum_val) = checksum {
            crate::common::Logger::info(&format!(
                "Calculated MD5 checksum for image: {}",
                checksum_val
            ));
        }
        
        let image_data = ImageData::Binary { format, data: Arc::new(data) };
        
        Self {
            metadata: ImageMetadata {
                id,
                name: None,
                width: dimensions.map(|(w, _)| w),
                height: dimensions.map(|(_, h)| h),
                format: Some(format),
                size: image_data.get_size(),
                checksum,
            },
            data: image_data,
            marker_ids: Vec::new(),
        }
    }

    pub fn new_from_shared_buffer(id: ImageId, format: ImageFormat, buffer_id: u32) -> Self {
        let data = ImageData::SharedBuffer { format, buffer_id };
        
        // For SharedBuffer, we'll calculate checksum when the data is accessed
        // For now, just extract dimensions
        let dimensions = data.get_dimensions();
        
        Self {
            metadata: ImageMetadata {
                id,
                name: None,
                width: dimensions.map(|(w, _)| w),
                height: dimensions.map(|(_, h)| h),
                format: data.get_format(),
                size: data.get_size(),
                checksum: None, // Will be calculated when buffer is accessed
            },
            data,
            marker_ids: Vec::new(),
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.metadata.name = Some(name);
        self
    }

    pub fn with_dimensions(mut self, width: u32, height: u32) -> Self {
        self.metadata.width = Some(width);
        self.metadata.height = Some(height);
        self
    }

    pub fn id(&self) -> ImageId {
        self.metadata.id
    }

    pub fn name(&self) -> &Option<String> {
        &self.metadata.name
    }

    pub fn estimated_size(&self) -> usize {
        // Estimate memory usage: data size + metadata overhead
        let data_size = match &self.data {
            ImageData::Binary { data, .. } => data.len(),
            ImageData::FilePath(_) => 256, // Just path string
            ImageData::SharedBuffer { .. } => 8, // Just buffer ID
        };
        
        // Add metadata overhead (approximately)
        data_size + 256 + (self.marker_ids.len() * 4)
    }

    pub fn to_dto(&self) -> ImageDTO {
        ImageDTO {
            metadata: ImageMetadataDTO {
                id: self.metadata.id,
                name: self.metadata.name.clone(),
                width: self.metadata.width,
                height: self.metadata.height,
                format: self.metadata.format.map(|f| match f {
                    ImageFormat::Jpeg => ImageFormatDTO::Jpeg,
                    ImageFormat::Png => ImageFormatDTO::Png,
                    ImageFormat::Gif => ImageFormatDTO::Gif,
                    ImageFormat::Webp => ImageFormatDTO::Webp,
                    ImageFormat::Bmp => ImageFormatDTO::Bmp,
                }),
                size: self.metadata.size,
                checksum: self.metadata.checksum.clone(),
            },
            data: match &self.data {
                ImageData::FilePath(path) => ImageDataDTO::FilePath(path.clone()),
                ImageData::Binary { format, data } => ImageDataDTO::Binary {
                    format: match format {
                        ImageFormat::Jpeg => ImageFormatDTO::Jpeg,
                        ImageFormat::Png => ImageFormatDTO::Png,
                        ImageFormat::Gif => ImageFormatDTO::Gif,
                        ImageFormat::Webp => ImageFormatDTO::Webp,
                        ImageFormat::Bmp => ImageFormatDTO::Bmp,
                    },
                    data: data.clone(),
                },
                ImageData::SharedBuffer { format, buffer_id } => ImageDataDTO::SharedBuffer {
                    format: match format {
                        ImageFormat::Jpeg => ImageFormatDTO::Jpeg,
                        ImageFormat::Png => ImageFormatDTO::Png,
                        ImageFormat::Gif => ImageFormatDTO::Gif,
                        ImageFormat::Webp => ImageFormatDTO::Webp,
                        ImageFormat::Bmp => ImageFormatDTO::Bmp,
                    },
                    buffer_id: *buffer_id,
                },
            },
            marker_ids: self.marker_ids.clone(),
        }
    }

    pub fn from_dto(dto: ImageDTO) -> Self {
        Self {
            metadata: ImageMetadata {
                id: dto.metadata.id,
                name: dto.metadata.name,
                width: dto.metadata.width,
                height: dto.metadata.height,
                format: dto.metadata.format.map(|f| match f {
                    ImageFormatDTO::Jpeg => ImageFormat::Jpeg,
                    ImageFormatDTO::Png => ImageFormat::Png,
                    ImageFormatDTO::Gif => ImageFormat::Gif,
                    ImageFormatDTO::Webp => ImageFormat::Webp,
                    ImageFormatDTO::Bmp => ImageFormat::Bmp,
                }),
                size: dto.metadata.size,
                checksum: dto.metadata.checksum,
            },
            data: match dto.data {
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
            },
            marker_ids: dto.marker_ids,
        }
    }
}

// Basic storage operations for images (no business logic)
pub fn add_image_from_path_storage(path: PathBuf, name: Option<String>) -> CoreResult<ImageId> {
    let id = IMAGE_ID_GENERATOR.next();
    let mut image = Image::new_from_path(id, path);
    if let Some(n) = name {
        image = image.with_name(n);
    }
    
    let mut storage = APP_STATE.images.write()?;
    storage.insert_with_memory_check(id, image)?;
    Ok(id)
}

pub fn add_image_from_binary_storage(format: ImageFormat, data: Vec<u8>, name: Option<String>) -> CoreResult<ImageId> {
    let id = IMAGE_ID_GENERATOR.next();
    let mut image = Image::new_from_binary(id, format, data);
    if let Some(n) = name {
        image = image.with_name(n);
    }
    
    let mut storage = APP_STATE.images.write()?;
    storage.insert_with_memory_check(id, image)?;
    Ok(id)
}

pub fn add_image_from_shared_buffer_storage(format: ImageFormat, buffer_id: u32, name: Option<String>) -> CoreResult<ImageId> {
    let id = IMAGE_ID_GENERATOR.next();
    let mut image = Image::new_from_shared_buffer(id, format, buffer_id);
    if let Some(n) = name {
        image = image.with_name(n);
    }
    
    let mut storage = APP_STATE.images.write()?;
    storage.insert_with_memory_check(id, image)?;
    Ok(id)
}

pub fn get_image_storage(id: ImageId) -> CoreResult<Option<Arc<Image>>> {
    APP_STATE.get_image(id)
}

pub fn get_all_images_storage() -> CoreResult<Vec<Arc<Image>>> {
    let storage = APP_STATE.images.read()?;
    Ok(storage.iter().map(|(_, img)| img.clone()).collect())
}

pub fn update_image_data_storage(id: ImageId, data: ImageData) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&id) {
        // Use Arc::make_mut for COW optimization
        let image = Arc::make_mut(image_arc);
        image.data = data;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn update_image_name_storage(id: ImageId, name: Option<String>) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&id) {
        let image = Arc::make_mut(image_arc);
        image.metadata.name = name;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn update_image_storage(id: ImageId, data: Option<ImageData>, name: Option<String>) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&id) {
        let image = Arc::make_mut(image_arc);
        if let Some(d) = data {
            image.metadata.format = d.get_format();
            image.metadata.size = d.get_size();
            image.data = d;
        }
        image.metadata.name = name;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn update_image_dimensions_storage(id: ImageId, width: u32, height: u32) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&id) {
        let image = Arc::make_mut(image_arc);
        image.metadata.width = Some(width);
        image.metadata.height = Some(height);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn delete_image_storage(id: ImageId) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    Ok(storage.remove(&id).is_some())
}

pub fn clear_all_images_storage() -> CoreResult<()> {
    let mut storage = APP_STATE.images.write()?;
    storage.clear();
    Ok(())
}

pub fn image_count_storage() -> CoreResult<usize> {
    let storage = APP_STATE.images.read()?;
    Ok(storage.iter().count())
}

pub fn image_exists_storage(id: ImageId) -> CoreResult<bool> {
    let storage = APP_STATE.images.read()?;
    Ok(storage.contains(&id))
}

pub fn current_memory_usage_storage() -> CoreResult<usize> {
    let storage = APP_STATE.images.read()?;
    Ok(storage.current_memory_usage())
}

// Marker-related operations for images
pub fn add_marker_to_image_storage(image_id: ImageId, marker_id: MarkerId) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&image_id) {
        let image = Arc::make_mut(image_arc);
        if !image.marker_ids.contains(&marker_id) {
            image.marker_ids.push(marker_id);
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn remove_marker_from_image_storage(image_id: ImageId, marker_id: MarkerId) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&image_id) {
        let image = Arc::make_mut(image_arc);
        image.marker_ids.retain(|&id| id != marker_id);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn clear_image_markers_storage(image_id: ImageId) -> CoreResult<bool> {
    let mut storage = APP_STATE.images.write()?;
    if let Some(image_arc) = storage.get_mut(&image_id) {
        let image = Arc::make_mut(image_arc);
        image.marker_ids.clear();
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn get_image_marker_ids_storage(image_id: ImageId) -> CoreResult<Vec<MarkerId>> {
    let storage = APP_STATE.images.read()?;
    Ok(storage.get(&image_id)
        .map(|img| img.marker_ids.clone())
        .unwrap_or_default())
}