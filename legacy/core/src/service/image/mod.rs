// Image service模块
mod service;
pub mod thumbnail;

pub use service::{ImageService, ImageProcessingResult};
pub use thumbnail::{
    ThumbnailData, ProcessingConfig, DEFAULT_THUMBNAIL_SIZE,
    request_thumbnail, request_thumbnails_batch,
    get_thumbnail, has_thumbnail, clear_all_thumbnails
};