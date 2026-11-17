use crate::common::{log_function_call, ImageId};
use crate::service::image::{ThumbnailData, request_thumbnail as service_request_thumbnail, 
                            request_thumbnails_batch as service_request_thumbnails_batch,
                            get_thumbnail as service_get_thumbnail,
                            has_thumbnail as service_has_thumbnail};

pub fn request_thumbnail(image_id: u32) -> Result<(), String> {
    log_function_call("request_thumbnail", Some(serde_json::json!({"image_id": image_id})));
    service_request_thumbnail(ImageId::from(image_id))
        .map_err(|e| e.to_string())
}

pub fn request_thumbnails_batch(image_ids: Vec<u32>) -> Result<(), String> {
    log_function_call("request_thumbnails_batch", Some(serde_json::json!({"image_ids": &image_ids})));
    let ids: Vec<ImageId> = image_ids.iter().map(|&id| ImageId::from(id)).collect();
    service_request_thumbnails_batch(ids)
        .map_err(|e| e.to_string())
}

pub fn get_thumbnail(image_id: u32) -> Option<ThumbnailData> {
    log_function_call("get_thumbnail", Some(serde_json::json!({"image_id": image_id})));
    service_get_thumbnail(ImageId::from(image_id))
        .ok()
        .flatten()
}

pub fn has_thumbnail(image_id: u32) -> bool {
    log_function_call("has_thumbnail", Some(serde_json::json!({"image_id": image_id})));
    service_has_thumbnail(ImageId::from(image_id))
        .unwrap_or(false)
}