use crate::common::{Logger, log_function_call, ImageId, MarkerId};
use crate::common::dto::marker::MarkerDTO;
use crate::service::{get_service, events::DomainEvent};

/// 为图片添加点型标记
pub fn add_point_marker_to_image(image_id: u32, x: f64, y: f64, translation: Option<String>) -> Option<u32> {
    log_function_call("add_point_marker_to_image", Some(serde_json::json!({
        "image_id": image_id,
        "x": x,
        "y": y,
        "translation": translation
    })));
    
    let service = get_service();
    
    // API层直接处理业务逻辑
    let result = if service.image_service.image_exists(image_id) {
        if let Some(marker_id) = service.marker_service.add_point_marker(image_id, x, y, translation) {
            if service.image_service.add_marker_to_image(image_id, marker_id) {
                service.event_bus.publish(DomainEvent::MarkerAddedToImage(
                    ImageId::from(image_id),
                    MarkerId::from(marker_id)
                ));
                Some(marker_id)
            } else {
                // 回滚操作
                service.marker_service.remove_marker(marker_id);
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    
    if result.is_none() {
        Logger::error(&format!("Failed to add point marker to image {}", image_id));
    }
    
    result
}

/// 为图片添加矩形型标记
pub fn add_rectangle_marker_to_image(image_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> Option<u32> {
    log_function_call("add_rectangle_marker_to_image", Some(serde_json::json!({
        "image_id": image_id,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "translation": translation
    })));
    
    let service = get_service();
    
    // API层直接处理业务逻辑
    let result = if service.image_service.image_exists(image_id) {
        if let Some(marker_id) = service.marker_service.add_rectangle_marker(image_id, x, y, width, height, translation) {
            if service.image_service.add_marker_to_image(image_id, marker_id) {
                service.event_bus.publish(DomainEvent::MarkerAddedToImage(
                    ImageId::from(image_id),
                    MarkerId::from(marker_id)
                ));
                Some(marker_id)
            } else {
                // 回滚操作
                service.marker_service.remove_marker(marker_id);
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    
    if result.is_none() {
        Logger::error(&format!("Failed to add rectangle marker to image {}", image_id));
    }
    
    result
}

/// 获取标记信息
pub fn get_marker_info(marker_id: u32) -> Option<MarkerDTO> {
    log_function_call("get_marker_info", Some(serde_json::json!({"marker_id": marker_id})));
    let service = get_service();
    service.marker_service.get_marker(marker_id)
}

/// 获取图片上的所有标记
pub fn get_markers_for_image(image_id: u32) -> Vec<MarkerDTO> {
    log_function_call("get_markers_for_image", Some(serde_json::json!({"image_id": image_id})));
    let service = get_service();
    service.marker_service.get_markers_for_image(image_id)
}

/// 更新点型标记位置
pub fn update_point_marker_position(marker_id: u32, x: f64, y: f64) -> bool {
    log_function_call("update_point_marker_position", Some(serde_json::json!({
        "marker_id": marker_id,
        "x": x,
        "y": y
    })));
    
    let service = get_service();
    service.marker_service.update_point_marker_position(marker_id, x, y)
}

/// 更新矩形型标记几何
pub fn update_rectangle_marker_geometry(marker_id: u32, x: f64, y: f64, width: f64, height: f64) -> bool {
    log_function_call("update_rectangle_marker_geometry", Some(serde_json::json!({
        "marker_id": marker_id,
        "x": x,
        "y": y,
        "width": width,
        "height": height
    })));
    
    let service = get_service();
    service.marker_service.update_rectangle_marker_geometry(marker_id, x, y, width, height)
}

/// 更新标记翻译
pub fn update_marker_translation(marker_id: u32, translation: String) -> bool {
    log_function_call("update_marker_translation", Some(serde_json::json!({
        "marker_id": marker_id,
        "translation": &translation
    })));
    
    let service = get_service();
    service.marker_service.update_marker_translation(marker_id, translation)
}

/// 更新标记样式
pub fn update_marker_style(marker_id: u32, overlay_text: bool, horizontal: bool) -> bool {
    log_function_call("update_marker_style", Some(serde_json::json!({
        "marker_id": marker_id,
        "overlay_text": overlay_text,
        "horizontal": horizontal
    })));
    
    let service = get_service();
    service.marker_service.update_marker_style(marker_id, overlay_text, horizontal)
}

/// 移动标记在图片内的顺序
pub fn move_marker_order(marker_id: u32, new_index: u32) -> bool {
    log_function_call("move_marker_order", Some(serde_json::json!({
        "marker_id": marker_id,
        "new_index": new_index
    })));
    
    let service = get_service();
    service.marker_service.move_marker_order(marker_id, new_index)
}

/// 更新点型标记完整信息
pub fn update_point_marker_full(marker_id: u32, x: f64, y: f64, translation: Option<String>) -> bool {
    log_function_call("update_point_marker_full", Some(serde_json::json!({
        "marker_id": marker_id,
        "x": x,
        "y": y,
        "translation": translation
    })));
    
    let service = get_service();
    service.marker_service.update_point_marker_full(marker_id, x, y, translation)
}

/// 更新矩形型标记完整信息
pub fn update_rectangle_marker_full(marker_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> bool {
    log_function_call("update_rectangle_marker_full", Some(serde_json::json!({
        "marker_id": marker_id,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "translation": translation
    })));
    
    let service = get_service();
    service.marker_service.update_rectangle_marker_full(marker_id, x, y, width, height, translation)
}

/// 从图片中移除标记
pub fn remove_marker_from_image(image_id: u32, marker_id: u32) -> bool {
    log_function_call("remove_marker_from_image", Some(serde_json::json!({
        "image_id": image_id,
        "marker_id": marker_id
    })));

    let service = get_service();

    let removed_from_image = service.image_service.remove_marker_from_image(image_id, marker_id);
    let removed_marker = service.marker_service.remove_marker(marker_id);

    // Clear bunny cache for this marker
    if removed_marker {
        let _ = crate::storage::bunny_cache::clear_bunny_cache_storage(crate::common::MarkerId(marker_id));
    }

    removed_from_image && removed_marker
}

/// 清空图片的所有标记
pub fn clear_image_markers(image_id: u32) -> bool {
    log_function_call("clear_image_markers", Some(serde_json::json!({"image_id": image_id})));
    
    let service = get_service();
    
    // 发布清空图片标记事件，MarkerService会处理实际的清理工作
    service.event_bus.publish(DomainEvent::ImageMarkersClearing(ImageId::from(image_id)));
    true
}

/// 将矩形marker转换为点型marker（使用矩形上边的中点）
pub fn convert_rectangle_to_point_marker(marker_id: u32) -> bool {
    log_function_call("convert_rectangle_to_point_marker", Some(serde_json::json!({"marker_id": marker_id})));
    
    let service = get_service();
    service.marker_service.convert_rectangle_to_point(marker_id)
}

/// 将点型marker转换为矩形marker（5% x 5%的矩形，点为上边中点）
pub fn convert_point_to_rectangle_marker(marker_id: u32) -> bool {
    log_function_call("convert_point_to_rectangle_marker", Some(serde_json::json!({"marker_id": marker_id})));
    
    let service = get_service();
    service.marker_service.convert_point_to_rectangle(marker_id)
}