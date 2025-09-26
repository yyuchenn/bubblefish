// Marker Service - 处理标记相关的业务逻辑
use std::sync::Arc;
use crate::common::{CoreResult, ImageId, MarkerId, MARKER_ID_GENERATOR};
use crate::common::dto::marker::MarkerDTO;
use crate::storage::marker::{self as storage, Marker, MarkerStyle, MarkerGeometry};
use crate::storage::state::APP_STATE;
use crate::storage::traits::Storage;
// Removed direct undo_redo imports - now using event system
use crate::service::events::{DomainEvent, EventBus, EventHandler};

pub struct MarkerService {
    event_bus: Arc<EventBus>,
}

impl MarkerService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }
    
    // === 标记创建操作 ===
    
    // 点型marker
    pub fn add_point_marker(&self, image_id: u32, x: f64, y: f64, translation: Option<String>) -> Option<u32> {
        match self.add_point_marker_to_image(ImageId::from(image_id), x, y, translation) {
            Ok(id) => Some(id.into()),
            Err(_) => None,
        }
    }
    
    // 矩形型marker
    pub fn add_rectangle_marker(&self, image_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> Option<u32> {
        match self.add_rectangle_marker_to_image(ImageId::from(image_id), x, y, width, height, translation) {
            Ok(id) => Some(id.into()),
            Err(_) => None,
        }
    }
    
    // Business logic with undo/redo support for point markers
    pub fn add_point_marker_to_image(&self, image_id: ImageId, x: f64, y: f64, translation: Option<String>) -> CoreResult<MarkerId> {
        let id = MARKER_ID_GENERATOR.next();
        
        // Get next image index by finding the highest current index
        let marker_storage = APP_STATE.markers.read()?;
        let markers = marker_storage.get_by_image(&image_id);
        let image_index = if markers.is_empty() {
            1
        } else {
            // Find the highest image_index and add 1
            markers.iter()
                .map(|m| m.image_index)
                .max()
                .unwrap_or(0) + 1
        };
        drop(marker_storage);
        
        let marker = match translation {
            Some(trans) => Marker::point_with_translation(id, image_id, x, y, trans, image_index),
            None => Marker::new_point(id, image_id, x, y, image_index),
        };
        
        let mut storage = APP_STATE.markers.write()?;
        storage.insert_with_image(marker.clone())?;
        
        // Update image marker list
        crate::storage::image::add_marker_to_image_storage(image_id, id)?;
        
        // Event will be published by API layer which will trigger undo recording
        
        Ok(id)
    }
    
    // Business logic with undo/redo support for rectangle markers
    pub fn add_rectangle_marker_to_image(&self, image_id: ImageId, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> CoreResult<MarkerId> {
        let id = MARKER_ID_GENERATOR.next();
        
        // Get next image index by finding the highest current index
        let marker_storage = APP_STATE.markers.read()?;
        let markers = marker_storage.get_by_image(&image_id);
        let image_index = if markers.is_empty() {
            1
        } else {
            // Find the highest image_index and add 1
            markers.iter()
                .map(|m| m.image_index)
                .max()
                .unwrap_or(0) + 1
        };
        drop(marker_storage);
        
        let marker = match translation {
            Some(trans) => Marker::rectangle_with_translation(id, image_id, x, y, width, height, trans, image_index),
            None => Marker::new_rectangle(id, image_id, x, y, width, height, image_index),
        };
        
        let mut storage = APP_STATE.markers.write()?;
        storage.insert_with_image(marker.clone())?;
        
        // Update image marker list
        crate::storage::image::add_marker_to_image_storage(image_id, id)?;
        
        // Event will be published by API layer which will trigger undo recording
        
        Ok(id)
    }
    
    // === 标记查询操作 ===
    
    pub fn get_marker(&self, marker_id: u32) -> Option<MarkerDTO> {
        match self.get_marker_by_id(MarkerId::from(marker_id)) {
            Ok(opt) => opt,
            Err(_) => None,
        }
    }
    
    pub fn get_marker_by_id(&self, id: MarkerId) -> CoreResult<Option<MarkerDTO>> {
        Ok(storage::get_marker_storage(id)?.map(|m| m.to_dto()))
    }
    
    // 内部使用方法，返回实际的Marker结构
    pub(crate) fn get_marker_internal(&self, marker_id: u32) -> Option<Marker> {
        match storage::get_marker_storage(MarkerId::from(marker_id)) {
            Ok(opt) => opt,
            Err(_) => None,
        }
    }
    
    pub fn get_image_markers(&self, image_id: ImageId) -> CoreResult<Vec<MarkerDTO>> {
        Ok(storage::get_image_markers_storage(image_id)?
            .into_iter()
            .map(|m| m.to_dto())
            .collect())
    }
    
    // === 标记更新操作 ===
    
    // 点型marker位置更新
    pub fn update_point_marker_position(&self, marker_id: u32, x: f64, y: f64) -> bool {
        let result = match self.update_point_marker_position_with_undo(MarkerId::from(marker_id), x, y) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
        }
        
        result
    }
    
    pub fn update_point_marker_position_with_undo(&self, id: MarkerId, x: f64, y: f64) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 确保是点型marker
            if let MarkerGeometry::Point { x: old_x, y: old_y } = marker.geometry {
                let old_pos = (old_x, old_y);
                marker.geometry = MarkerGeometry::Point { x, y };
                
                drop(storage_guard);
                
                // Publish event for undo/redo
                self.event_bus.publish(DomainEvent::PointMarkerPositionUpdated { 
                    id, 
                    old_pos, 
                    new_pos: (x, y) 
                });
                
                Ok(true)
            } else {
                Ok(false) // 不是点型marker
            }
        } else {
            Ok(false)
        }
    }
    
    // 矩形型marker几何更新
    pub fn update_rectangle_marker_geometry(&self, marker_id: u32, x: f64, y: f64, width: f64, height: f64) -> bool {
        let result = match self.update_rectangle_marker_geometry_with_undo(MarkerId::from(marker_id), x, y, width, height) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
        }
        
        result
    }
    
    pub fn update_rectangle_marker_geometry_with_undo(&self, id: MarkerId, x: f64, y: f64, width: f64, height: f64) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 确保是矩形型marker
            if let MarkerGeometry::Rectangle { x: old_x, y: old_y, width: old_width, height: old_height } = marker.geometry {
                let old_geometry = (old_x, old_y, old_width, old_height);
                marker.geometry = MarkerGeometry::Rectangle { x, y, width, height };
                
                drop(storage_guard);
                
                // Publish RectangleGeometryUpdated event for undo/redo
                self.event_bus.publish(DomainEvent::RectangleGeometryUpdated { 
                    id, 
                    old_geometry, 
                    new_geometry: (x, y, width, height) 
                });
                
                Ok(true)
            } else {
                Ok(false) // 不是矩形型marker
            }
        } else {
            Ok(false)
        }
    }
    
    pub fn update_marker_translation(&self, marker_id: u32, translation: String) -> bool {
        let result = match self.update_marker_translation_with_undo(MarkerId::from(marker_id), translation) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
        }
        
        result
    }
    
    pub fn update_marker_translation_with_undo(&self, id: MarkerId, translation: String) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            let old_trans = marker.translation.clone();
            let new_trans = translation.clone();
            marker.translation = translation;
            
            drop(storage_guard);
            
            // Publish event for undo/redo
            self.event_bus.publish(DomainEvent::MarkerTranslationUpdated { 
                id, 
                old_trans, 
                new_trans
            });
            
            Ok(true)
        } else {
            Ok(false)
        }
    }
    
    pub fn update_marker_style(&self, marker_id: u32, overlay_text: bool, horizontal: bool) -> bool {
        let style = MarkerStyle {
            overlay_text,
            horizontal,
        };
        
        let result = match self.update_marker_style_with_undo(MarkerId::from(marker_id), style) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
        }
        
        result
    }
    
    pub fn update_marker_style_with_undo(&self, id: MarkerId, style: MarkerStyle) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            let old_style = marker.style.clone();
            let new_style = style.clone();
            marker.style = style;
            
            drop(storage_guard);
            
            // Publish event for undo/redo
            self.event_bus.publish(DomainEvent::MarkerStyleUpdated { 
                id, 
                old_style, 
                new_style
            });
            
            Ok(true)
        } else {
            Ok(false)
        }
    }
    
    // === 标记顺序移动操作 ===
    
    pub fn move_marker_order(&self, marker_id: u32, new_index: u32) -> bool {
        match self.move_marker_order_with_undo(MarkerId::from(marker_id), new_index) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    pub fn move_marker_order_with_undo(&self, id: MarkerId, new_index: u32) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        
        // Get the marker and its current index
        let marker = storage_guard.get(&id).cloned();
        if marker.is_none() {
            return Ok(false);
        }
        
        let marker = marker.unwrap();
        let image_id = marker.image_id;
        let old_index = marker.image_index;
        
        // If same position, no need to move
        if old_index == new_index {
            return Ok(true);
        }
        
        // Get all markers for this image
        let marker_ids = storage_guard.by_image.get(&image_id).cloned().unwrap_or_default();
        
        // Adjust indices for other markers
        for marker_id in &marker_ids {
            if let Some(other_marker) = storage_guard.markers.get_mut(marker_id) {
                if other_marker.id == id {
                    // This is the marker we're moving
                    other_marker.image_index = new_index;
                } else if old_index < new_index {
                    // Moving forward: shift markers in between backwards
                    if other_marker.image_index > old_index && other_marker.image_index <= new_index {
                        other_marker.image_index -= 1;
                    }
                } else {
                    // Moving backward: shift markers in between forwards
                    if other_marker.image_index >= new_index && other_marker.image_index < old_index {
                        other_marker.image_index += 1;
                    }
                }
            }
        }
        
        drop(storage_guard);
        
        // Publish event for undo/redo
        self.event_bus.publish(DomainEvent::MarkerOrderMoved { 
            id,
            image_id,
            old_index,
            new_index,
        });
        
        Ok(true)
    }
    
    // 点型marker完整更新
    pub fn update_point_marker_full(&self, marker_id: u32, x: f64, y: f64, translation: Option<String>) -> bool {
        if let Some(current) = self.get_marker_internal(marker_id) {
            // 检查是否是点型marker
            if let MarkerGeometry::Point { .. } = current.geometry {
                let result = match self.update_point_marker_with_undo(
                    MarkerId::from(marker_id),
                    x,
                    y,
                    translation.unwrap_or(current.translation),
                    current.style
                ) {
                    Ok(res) => res,
                    Err(_) => false,
                };
                
                if result {
                    self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
                }
                
                result
            } else {
                false
            }
        } else {
            false
        }
    }
    
    pub fn update_point_marker_with_undo(&self, id: MarkerId, x: f64, y: f64, translation: String, style: MarkerStyle) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 检查是否是点型marker
            if let MarkerGeometry::Point { x: old_x, y: old_y } = marker.geometry {
                let old_position = (old_x, old_y);
                let old_translation = marker.translation.clone();
                let old_style = marker.style.clone();
                
                marker.geometry = MarkerGeometry::Point { x, y };
                marker.translation = translation.clone();
                marker.style = style.clone();
                
                let new_translation = marker.translation.clone();
                let new_style = marker.style.clone();
                
                drop(storage_guard);
                
                // Publish event for undo/redo
                self.event_bus.publish(DomainEvent::MarkerFullUpdated { 
                    id,
                    old_position,
                    new_position: (x, y),
                    old_translation,
                    new_translation,
                    old_style,
                    new_style
                });
                
                Ok(true)
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        }
    }
    
    // 矩形型marker完整更新
    pub fn update_rectangle_marker_full(&self, marker_id: u32, x: f64, y: f64, width: f64, height: f64, translation: Option<String>) -> bool {
        if let Some(current) = self.get_marker_internal(marker_id) {
            // 检查是否是矩形型marker
            if let MarkerGeometry::Rectangle { .. } = current.geometry {
                let result = match self.update_rectangle_marker_with_undo(
                    MarkerId::from(marker_id),
                    x,
                    y,
                    width,
                    height,
                    translation.unwrap_or(current.translation),
                    current.style
                ) {
                    Ok(res) => res,
                    Err(_) => false,
                };
                
                if result {
                    self.event_bus.publish(DomainEvent::MarkerUpdated(MarkerId::from(marker_id)));
                }
                
                result
            } else {
                false
            }
        } else {
            false
        }
    }
    
    pub fn update_rectangle_marker_with_undo(&self, id: MarkerId, x: f64, y: f64, width: f64, height: f64, translation: String, style: MarkerStyle) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 检查是否是矩形型marker
            if let MarkerGeometry::Rectangle { x: old_x, y: old_y, .. } = marker.geometry {
                let old_position = (old_x, old_y);
                let old_translation = marker.translation.clone();
                let old_style = marker.style.clone();
                
                marker.geometry = MarkerGeometry::Rectangle { x, y, width, height };
                marker.translation = translation.clone();
                marker.style = style.clone();
                
                let new_translation = marker.translation.clone();
                let new_style = marker.style.clone();
                
                drop(storage_guard);
                
                // Publish event for undo/redo
                self.event_bus.publish(DomainEvent::MarkerFullUpdated { 
                    id,
                    old_position,
                    new_position: (x, y),
                    old_translation,
                    new_translation,
                    old_style,
                    new_style
                });
                
                Ok(true)
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        }
    }
    
    // === 标记删除操作 ===
    
    pub fn remove_marker(&self, marker_id: u32) -> bool {
        let result = match self.remove_marker_with_undo(MarkerId::from(marker_id)) {
            Ok(res) => res,
            Err(_) => false,
        };
        
        if result {
            self.event_bus.publish(DomainEvent::MarkerDeleted(MarkerId::from(marker_id)));
        }
        
        result
    }
    
    pub fn remove_marker_with_undo(&self, id: MarkerId) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        if let Some(marker) = storage_guard.remove_with_cleanup(&id) {
            let image_id = marker.image_id;
            
            // Update image marker list
            crate::storage::image::remove_marker_from_image_storage(image_id, id)?;
            
            // Renumber remaining markers for this image
            storage::renumber_image_markers(&mut storage_guard, image_id)?;
            
            // Drop lock before publishing event
            drop(storage_guard);
            
            // Publish event with marker data for undo/redo
            self.event_bus.publish(DomainEvent::MarkerRemovedFromImage(image_id, id, marker));
            
            Ok(true)
        } else {
            Ok(false)
        }
    }
    
    pub fn clear_image_markers(&self, image_id: u32) -> bool {
        match self.clear_image_markers_with_undo(ImageId::from(image_id)) {
            Ok(_) => true,
            Err(_) => false,
        }
    }
    
    pub fn clear_image_markers_with_undo(&self, image_id: ImageId) -> CoreResult<()> {
        let mut storage_guard = APP_STATE.markers.write()?;
        let mut removed_markers = Vec::new();
        let mut marker_ids_to_clear = Vec::new();

        if let Some(marker_ids) = storage_guard.by_image.get(&image_id).cloned() {
            for marker_id in marker_ids {
                marker_ids_to_clear.push(marker_id);
                if let Some(marker) = storage_guard.markers.remove(&marker_id) {
                    removed_markers.push(marker);
                }
            }
            storage_guard.by_image.remove(&image_id);
        }

        // Drop lock before publishing event
        drop(storage_guard);

        // Clear bunny cache for all removed markers
        for marker_id in marker_ids_to_clear {
            let _ = crate::storage::bunny_cache::clear_bunny_cache_storage(marker_id);
        }

        // Publish event with markers data for undo/redo if any markers were removed
        if !removed_markers.is_empty() {
            self.event_bus.publish(DomainEvent::ImageMarkersCleared(image_id, removed_markers));
        }

        // Also clear from image
        crate::storage::image::clear_image_markers_storage(image_id)?;
        Ok(())
    }
    
    /// Transfer ownership of all markers for an image out of storage
    /// This removes markers from storage and returns their ownership to the caller
    /// Used when deleting images - the markers are moved into the undo/redo action
    /// If the action is dropped (e.g., overwritten), the markers are automatically freed
    pub fn take_image_markers(&self, image_id: ImageId) -> CoreResult<Vec<Marker>> {
        let mut storage_guard = APP_STATE.markers.write()?;
        let mut removed_markers = Vec::new();
        
        // Remove markers from storage and collect them
        if let Some(marker_ids) = storage_guard.by_image.get(&image_id).cloned() {
            for marker_id in marker_ids {
                if let Some(marker) = storage_guard.markers.remove(&marker_id) {
                    removed_markers.push(marker);  // Transfer ownership
                }
            }
            storage_guard.by_image.remove(&image_id);
        }
        
        drop(storage_guard);
        
        // Clear from image storage index
        crate::storage::image::clear_image_markers_storage(image_id)?;
        
        // Return owned markers - caller now has responsibility for their lifetime
        Ok(removed_markers)
    }
    
    /// Restore markers back to storage (used during undo)
    /// Takes ownership of markers and puts them back into storage
    pub fn restore_image_markers(&self, markers: Vec<Marker>) -> CoreResult<()> {
        if markers.is_empty() {
            return Ok(());
        }
        
        let mut storage_guard = APP_STATE.markers.write()?;
        for marker in &markers {
            let image_id = marker.image_id;
            let marker_id = marker.id;
            
            // Insert marker back into storage (clone to transfer ownership)
            storage_guard.markers.insert(marker_id, marker.clone());
            storage_guard.by_image.entry(image_id).or_default().push(marker_id);
        }
        drop(storage_guard);
        
        // Update image storage index after releasing the lock
        for marker in &markers {
            crate::storage::image::add_marker_to_image_storage(marker.image_id, marker.id)?;
        }
        
        Ok(())
    }
    
    // === 标记类型转换操作 ===
    
    /// 将矩形marker转换为点型marker（使用矩形上边的中点）
    pub fn convert_rectangle_to_point(&self, marker_id: u32) -> bool {
        match self.convert_rectangle_to_point_with_undo(MarkerId::from(marker_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    fn convert_rectangle_to_point_with_undo(&self, id: MarkerId) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 只能转换矩形marker
            if let MarkerGeometry::Rectangle { x, y, width, .. } = &marker.geometry {
                let old_marker = marker.clone();
                let image_id = marker.image_id;
                
                // 计算上边中点坐标
                let new_x = x + width / 2.0;
                let new_y = *y;
                
                // 创建新的点型geometry
                let new_geometry = MarkerGeometry::Point { x: new_x, y: new_y };
                marker.geometry = new_geometry;
                
                let new_marker = marker.clone();
                drop(storage_guard);
                
                // 记录转换动作用于撤销重做
                let project_id = crate::service::get_service().project_service.find_project_by_image(image_id)?;
                if let Some(project_id) = project_id {
                    let action = crate::service::undo_redo::UndoRedoAction::new(
                        crate::service::undo_redo::ActionType::ConvertRectangleToPoint {
                            marker_id: id,
                            old_marker,
                            new_marker,
                        },
                        project_id,
                    );
                    let _ = crate::service::get_service().undo_redo_service.record_action(action);
                }
                
                // 发布更新事件
                self.event_bus.publish(DomainEvent::MarkerUpdated(id));
                
                Ok(true)
            } else {
                Ok(false) // 不是矩形marker
            }
        } else {
            Ok(false)
        }
    }
    
    /// 将点型marker转换为矩形marker（5% x 5%的矩形，点为上边中点）
    pub fn convert_point_to_rectangle(&self, marker_id: u32) -> bool {
        match self.convert_point_to_rectangle_with_undo(MarkerId::from(marker_id)) {
            Ok(res) => res,
            Err(_) => false,
        }
    }
    
    fn convert_point_to_rectangle_with_undo(&self, id: MarkerId) -> CoreResult<bool> {
        let mut storage_guard = APP_STATE.markers.write()?;
        
        if let Some(marker) = storage_guard.get_mut(&id) {
            // 只能转换点型marker
            if let MarkerGeometry::Point { x, y } = &marker.geometry {
                let old_marker = marker.clone();
                let image_id = marker.image_id;
                
                // marker坐标系统是百分比（0-100），所以直接使用5作为5%
                let rect_width = 5.0;  // 5%的宽度
                let rect_height = 5.0; // 5%的高度
                
                // 原点作为矩形上边中点，计算矩形左上角
                let mut rect_x = x - rect_width / 2.0;
                let mut rect_y = *y;
                
                // 确保矩形在图片范围内（坐标系是0-100）
                // 检查左边界
                if rect_x < 0.0 {
                    rect_x = 0.0;
                }
                // 检查右边界
                if rect_x + rect_width > 100.0 {
                    rect_x = 100.0 - rect_width;
                }
                // 检查下边界
                if rect_y + rect_height > 100.0 {
                    rect_y = 100.0 - rect_height;
                }
                
                // 创建新的矩形geometry
                let new_geometry = MarkerGeometry::Rectangle { 
                    x: rect_x, 
                    y: rect_y, 
                    width: rect_width, 
                    height: rect_height 
                };
                marker.geometry = new_geometry;
                
                let new_marker = marker.clone();
                drop(storage_guard);
                
                // 记录转换动作用于撤销重做
                let project_id = crate::service::get_service().project_service.find_project_by_image(image_id)?;
                if let Some(project_id) = project_id {
                    let action = crate::service::undo_redo::UndoRedoAction::new(
                        crate::service::undo_redo::ActionType::ConvertPointToRectangle {
                            marker_id: id,
                            old_marker,
                            new_marker,
                        },
                        project_id,
                    );
                    let _ = crate::service::get_service().undo_redo_service.record_action(action);
                }
                
                // 发布更新事件
                self.event_bus.publish(DomainEvent::MarkerUpdated(id));
                
                Ok(true)
            } else {
                Ok(false) // 不是点型marker
            }
        } else {
            Ok(false)
        }
    }
    
    // === 清理操作 ===
    
    pub fn clear_all(&self) {
        let _ = self.clear_all_markers();
    }
    
    pub fn clear_all_markers(&self) -> CoreResult<()> {
        storage::clear_all_markers_storage()
    }
    
    pub fn marker_count(&self) -> CoreResult<usize> {
        storage::marker_count_storage()
    }
    
    pub fn marker_exists(&self, id: MarkerId) -> CoreResult<bool> {
        storage::marker_exists_storage(id)
    }
    
    #[cfg(test)]
    pub fn reset_marker_storage(&self) -> CoreResult<()> {
        self.clear_all_markers()
    }
}

// 实现事件处理器
impl EventHandler for MarkerService {
    fn handle(&self, event: &DomainEvent) {
        match event {
            // 清空所有数据时，清理所有标记
            DomainEvent::AllDataClearing => {
                self.clear_all();
            },
            // 清空图片标记的请求
            DomainEvent::ImageMarkersClearing(image_id) => {
                self.clear_image_markers(image_id.0);
            },
            _ => {}
        }
    }
}