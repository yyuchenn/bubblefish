use crate::common::{CoreError, CoreResult};
use crate::common::ImageId;
use crate::storage::state::APP_STATE;
use crate::storage::traits::Storage;
use crate::storage::ImageFormat;
use crate::common::EVENT_SYSTEM;
use rayon::prelude::*;
use image::{DynamicImage, GenericImageView};
use std::io::Cursor;
use serde::{Deserialize, Serialize};

pub const DEFAULT_THUMBNAIL_SIZE: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailData {
    pub image_id: ImageId,
    pub data: Vec<u8>,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
}

// Image processing configuration
#[derive(Debug, Clone)]
pub struct ProcessingConfig {
    pub thumbnail_size: u32,
    pub jpeg_quality: u8,
    pub parallel_threshold: usize, // Minimum size in bytes to use parallel processing
}

impl Default for ProcessingConfig {
    fn default() -> Self {
        Self {
            thumbnail_size: DEFAULT_THUMBNAIL_SIZE,
            jpeg_quality: 85,
            parallel_threshold: 1024 * 1024, // 1MB
        }
    }
}

// Request thumbnail for a single image
pub fn request_thumbnail(image_id: ImageId) -> CoreResult<()> {
    // Check if image exists
    let image_exists = {
        let storage = APP_STATE.images.read()?;
        storage.contains(&image_id)
    };
    
    if !image_exists {
        return Err(CoreError::NotFound(format!("Image with id {} not found", image_id.0)));
    }

    let mut thumbnail_storage = APP_STATE.thumbnails.write()?;
    
    // If thumbnail already exists, push it
    if let Some(thumbnail) = thumbnail_storage.get(&image_id) {
        let thumbnail_data = ThumbnailData {
            image_id,
            data: thumbnail.clone(),
            format: ImageFormat::Jpeg,
            width: DEFAULT_THUMBNAIL_SIZE,
            height: DEFAULT_THUMBNAIL_SIZE,
        };
        drop(thumbnail_storage);
        push_thumbnail_to_frontend(thumbnail_data);
        return Ok(());
    }

    // If already generating, return
    if thumbnail_storage.contains(&image_id) {
        return Ok(());
    }

    // Mark as pending
    thumbnail_storage.insert(image_id, Vec::new())?;
    drop(thumbnail_storage);

    // Generate thumbnail using Rayon
    rayon::spawn(move || {
        if let Err(e) = generate_thumbnail_internal(image_id) {
            crate::common::Logger::error(&format!("Failed to generate thumbnail for image {}: {}", image_id, e));
            
            // Clean up pending state
            if let Ok(mut storage) = APP_STATE.thumbnails.write() {
                storage.remove(&image_id);
            }
        }
    });

    Ok(())
}

// Batch request thumbnails
pub fn request_thumbnails_batch(image_ids: Vec<ImageId>) -> CoreResult<()> {
    if image_ids.is_empty() {
        return Ok(());
    }
    
    let mut thumbnail_storage = APP_STATE.thumbnails.write()?;
    let mut pending_ids = Vec::new();
    
    for &image_id in &image_ids {
        // Check if image exists
        let image_exists = {
            let storage = APP_STATE.images.read()?;
            storage.contains(&image_id)
        };
        
        if !image_exists {
            continue;
        }
        
        // If thumbnail exists, push it
        if let Some(thumbnail) = thumbnail_storage.get(&image_id).cloned() {
            if !thumbnail.is_empty() {
                push_thumbnail_to_frontend(ThumbnailData {
                    image_id,
                    data: thumbnail,
                    format: ImageFormat::Jpeg,
                    width: DEFAULT_THUMBNAIL_SIZE,
                    height: DEFAULT_THUMBNAIL_SIZE,
                });
                continue;
            }
        }
        
        // If not pending, add to list
        if !thumbnail_storage.contains(&image_id) {
            thumbnail_storage.insert(image_id, Vec::new()).ok();
            pending_ids.push(image_id);
        }
    }
    
    drop(thumbnail_storage);
    
    if pending_ids.is_empty() {
        return Ok(());
    }
    
    // Process thumbnails with appropriate parallelism based on platform
    #[cfg(target_arch = "wasm32")]
    {
        // For WASM, process in smaller batches with limited parallelism to avoid memory issues
        // Process 3 at a time maximum
        let batch_size = 3;
        for chunk in pending_ids.chunks(batch_size) {
            // Use only 2 threads for WASM to reduce memory pressure
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(2)
                .build()
                .map_err(|e| CoreError::PlatformError(format!("Failed to create thread pool: {}", e)))?;
            
            pool.install(|| {
                chunk.par_iter().for_each(|&image_id| {
                    if let Err(e) = generate_thumbnail_internal(image_id) {
                        crate::common::Logger::error(&format!("Failed to generate thumbnail for image {}: {}", image_id, e));
                        
                        // Clean up pending state
                        if let Ok(mut storage) = APP_STATE.thumbnails.write() {
                            storage.remove(&image_id);
                        }
                    }
                });
            });
        }
    }
    
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Native platforms can handle more parallelism
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .map_err(|e| CoreError::PlatformError(format!("Failed to create thread pool: {}", e)))?;
        
        pool.install(|| {
            pending_ids.par_iter().for_each(|&image_id| {
                if let Err(e) = generate_thumbnail_internal(image_id) {
                    crate::common::Logger::error(&format!("Failed to generate thumbnail for image {}: {}", image_id, e));
                    
                    // Clean up pending state
                    if let Ok(mut storage) = APP_STATE.thumbnails.write() {
                        storage.remove(&image_id);
                    }
                }
            });
        });
    }
    
    Ok(())
}

// Generate thumbnail using fast_image_resize for better performance
fn generate_thumbnail(data: &[u8], config: &ProcessingConfig) -> CoreResult<Vec<u8>> {
    let img = image::load_from_memory(data)
        .map_err(|e| CoreError::ImageProcessingError(format!("Failed to load image: {}", e)))?;
    
    // Calculate new dimensions maintaining aspect ratio
    let (orig_width, orig_height) = img.dimensions();
    
    // If image is already smaller than thumbnail size, just re-encode as JPEG
    if orig_width <= config.thumbnail_size && orig_height <= config.thumbnail_size {
        // Convert to RGB and encode as JPEG for consistency
        let rgb_img = img.to_rgb8();
        let mut output = Vec::new();
        let mut cursor = Cursor::new(&mut output);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, config.jpeg_quality);
        image::DynamicImage::ImageRgb8(rgb_img).write_with_encoder(encoder)
            .map_err(|e| CoreError::ImageProcessingError(format!("Failed to encode thumbnail: {}", e)))?;
        return Ok(output);
    }
    
    // Calculate thumbnail dimensions
    let ratio = (config.thumbnail_size as f32 / orig_width.max(orig_height) as f32).min(1.0);
    let new_width = (orig_width as f32 * ratio) as u32;
    let new_height = (orig_height as f32 * ratio) as u32;
    
    // Always use optimized fast_image_resize for all images
    let thumbnail_data = generate_thumbnail_fast_resize_optimized(&img, new_width, new_height, config.jpeg_quality)?;
    
    Ok(thumbnail_data)
}

// Optimized thumbnail generation using fast_image_resize with minimal memory copies
fn generate_thumbnail_fast_resize_optimized(img: &DynamicImage, new_width: u32, new_height: u32, quality: u8) -> CoreResult<Vec<u8>> {
    use fast_image_resize as fr;
    
    let (orig_width, orig_height) = img.dimensions();
    
    // Directly work with RGB format to avoid alpha channel overhead
    let rgb_img = img.to_rgb8();
    let src_image = fr::images::Image::from_vec_u8(
        orig_width,
        orig_height,
        rgb_img.into_raw(),
        fr::PixelType::U8x3,  // Use RGB instead of RGBA
    ).map_err(|e| CoreError::ImageProcessingError(format!("Failed to create source image: {:?}", e)))?;
    
    // Create destination image with RGB format
    let mut dst_image = fr::images::Image::new(
        new_width,
        new_height,
        fr::PixelType::U8x3,  // Use RGB instead of RGBA
    );
    
    // Use high-quality Convolution algorithm with Lanczos3 filter for better thumbnail quality
    // This provides excellent quality with good performance balance
    let mut resizer = fr::Resizer::new();
    let resize_options = fr::ResizeOptions::new()
        .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3));

    resizer.resize(&src_image, &mut dst_image, Some(&resize_options))
        .map_err(|e| CoreError::ImageProcessingError(format!("Failed to resize image: {:?}", e)))?;
    
    // Directly encode from the buffer without creating intermediate image
    let mut output = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality);
    encoder.encode(
        dst_image.buffer(),  // Use buffer directly
        new_width,
        new_height,
        image::ExtendedColorType::Rgb8,
    ).map_err(|e| CoreError::ImageProcessingError(format!("Failed to encode thumbnail: {}", e)))?;
    
    Ok(output)
}

fn generate_thumbnail_internal(image_id: ImageId) -> CoreResult<()> {
    // Get image
    let image = APP_STATE.get_image(image_id)?
        .ok_or_else(|| CoreError::NotFound(format!("Image with id {} not found", image_id.0)))?;
    
    // Read image data
    let image_data = image.data.read_data()?;
    
    // Generate thumbnail
    let config = ProcessingConfig::default();
    let thumbnail_data = generate_thumbnail(&image_data, &config)?;
    
    // Update dimensions if needed
    if image.metadata.width.is_none() || image.metadata.height.is_none() {
        if let Some((width, height)) = image.data.get_format().and_then(|format| {
            crate::storage::dimension_extractor::extract_dimensions_from_bytes(&image_data, &format)
        }) {
            crate::storage::image::update_image_dimensions_storage(image_id, width, height)?;
        }
    }
    
    let thumbnail = ThumbnailData {
        image_id,
        data: thumbnail_data.clone(),
        format: ImageFormat::Jpeg,
        width: config.thumbnail_size,
        height: config.thumbnail_size,
    };
    
    // Store thumbnail
    {
        let mut storage = APP_STATE.thumbnails.write()?;
        storage.insert(image_id, thumbnail_data)?;
    }
    
    // Push to frontend
    push_thumbnail_to_frontend(thumbnail);
    
    Ok(())
}

fn push_thumbnail_to_frontend(thumbnail: ThumbnailData) {
    use base64::{Engine as _, engine::general_purpose};
    
    let event_data = serde_json::json!({
        "image_id": thumbnail.image_id,
        "data": general_purpose::STANDARD.encode(&thumbnail.data),
        "format": thumbnail.format,
        "width": thumbnail.width,
        "height": thumbnail.height
    });

    if let Err(e) = EVENT_SYSTEM.emit_business_event("thumbnail_ready".to_string(), event_data) {
        crate::common::Logger::error(&format!("Failed to push thumbnail to frontend: {}", e));
    }
}

pub fn get_thumbnail(image_id: ImageId) -> CoreResult<Option<ThumbnailData>> {
    let storage = APP_STATE.thumbnails.read()?;
    Ok(storage.get(&image_id).map(|data| ThumbnailData {
        image_id,
        data: data.clone(),
        format: ImageFormat::Jpeg,
        width: DEFAULT_THUMBNAIL_SIZE,
        height: DEFAULT_THUMBNAIL_SIZE,
    }))
}

pub fn has_thumbnail(image_id: ImageId) -> CoreResult<bool> {
    let storage = APP_STATE.thumbnails.read()?;
    Ok(storage.contains(&image_id))
}

pub fn clear_all_thumbnails() -> CoreResult<()> {
    let mut storage = APP_STATE.thumbnails.write()?;
    storage.clear();
    Ok(())
}