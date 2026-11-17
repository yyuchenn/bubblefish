// Undo/Redo Service - 处理撤销重做相关的业务逻辑
use std::sync::Arc;
use std::collections::{HashMap, VecDeque};
use std::sync::RwLock;
use crate::common::{CoreResult, ProjectId, ImageId, MarkerId};
use crate::api::undo_redo::UndoRedoResult;
use crate::service::events::{DomainEvent, EventBus, EventHandler};
use crate::common::EVENT_SYSTEM;
use super::actions::{ActionType, UndoRedoAction};
use super::performer::{perform_undo, perform_redo};
use uuid::Uuid;
use once_cell::sync::Lazy;

const MAX_UNDO_HISTORY: usize = 100;

pub struct ProjectUndoRedoStack {
    pub undo_stack: VecDeque<UndoRedoAction>,
    pub redo_stack: VecDeque<UndoRedoAction>,
}

impl ProjectUndoRedoStack {
    pub fn new() -> Self {
        Self {
            undo_stack: VecDeque::with_capacity(MAX_UNDO_HISTORY),
            redo_stack: VecDeque::with_capacity(MAX_UNDO_HISTORY),
        }
    }
    
    pub fn get_current_commit_id(&self) -> Option<Uuid> {
        self.undo_stack.back().map(|action| action.id)
    }
}

pub struct UndoRedoStack {
    pub project_stacks: RwLock<HashMap<ProjectId, ProjectUndoRedoStack>>,
    pub is_undoing: RwLock<bool>,
}

impl UndoRedoStack {
    pub fn new() -> Self {
        Self {
            project_stacks: RwLock::new(HashMap::new()),
            is_undoing: RwLock::new(false),
        }
    }
    
    pub fn get_or_create_project_stack(&self, project_id: ProjectId) -> CoreResult<()> {
        let mut stacks = self.project_stacks.write()?;
        if !stacks.contains_key(&project_id) {
            stacks.insert(project_id, ProjectUndoRedoStack::new());
        }
        Ok(())
    }
    
    pub fn push_action(&self, action: UndoRedoAction) -> CoreResult<()> {
        // Don't record actions while undoing/redoing
        let is_undoing = self.is_undoing.read()?;
        if *is_undoing {
            return Ok(());
        }
        
        let project_id = action.project_id;
        self.get_or_create_project_stack(project_id)?;
        
        let mut stacks = self.project_stacks.write()?;
        if let Some(project_stack) = stacks.get_mut(&project_id) {
            // Clear redo stack when new action is performed
            project_stack.redo_stack.clear();
            
            // Add to undo stack
            project_stack.undo_stack.push_back(action);
            
            // Maintain max history size
            if project_stack.undo_stack.len() > MAX_UNDO_HISTORY {
                project_stack.undo_stack.pop_front();
            }
        }
        
        Ok(())
    }
    
    pub fn can_undo(&self, project_id: ProjectId) -> CoreResult<bool> {
        let stacks = self.project_stacks.read()?;
        Ok(stacks.get(&project_id)
            .map(|s| !s.undo_stack.is_empty())
            .unwrap_or(false))
    }
    
    pub fn can_redo(&self, project_id: ProjectId) -> CoreResult<bool> {
        let stacks = self.project_stacks.read()?;
        Ok(stacks.get(&project_id)
            .map(|s| !s.redo_stack.is_empty())
            .unwrap_or(false))
    }
    
    pub fn pop_undo_action(&self, project_id: ProjectId) -> CoreResult<Option<UndoRedoAction>> {
        self.get_or_create_project_stack(project_id)?;
        
        let mut stacks = self.project_stacks.write()?;
        Ok(stacks.get_mut(&project_id)
            .and_then(|s| s.undo_stack.pop_back()))
    }
    
    pub fn push_redo_action(&self, project_id: ProjectId, action: UndoRedoAction) -> CoreResult<()> {
        let mut stacks = self.project_stacks.write()?;
        if let Some(project_stack) = stacks.get_mut(&project_id) {
            project_stack.redo_stack.push_back(action);
        }
        Ok(())
    }
    
    pub fn pop_redo_action(&self, project_id: ProjectId) -> CoreResult<Option<UndoRedoAction>> {
        self.get_or_create_project_stack(project_id)?;
        
        let mut stacks = self.project_stacks.write()?;
        Ok(stacks.get_mut(&project_id)
            .and_then(|s| s.redo_stack.pop_back()))
    }
    
    pub fn push_to_undo_stack(&self, project_id: ProjectId, action: UndoRedoAction) -> CoreResult<()> {
        let mut stacks = self.project_stacks.write()?;
        if let Some(project_stack) = stacks.get_mut(&project_id) {
            project_stack.undo_stack.push_back(action);
        }
        Ok(())
    }
    
    pub fn set_undoing(&self, undoing: bool) -> CoreResult<()> {
        let mut is_undoing = self.is_undoing.write()?;
        *is_undoing = undoing;
        Ok(())
    }
    
    pub fn clear(&self, project_id: ProjectId) -> CoreResult<()> {
        let mut stacks = self.project_stacks.write()?;
        if let Some(project_stack) = stacks.get_mut(&project_id) {
            project_stack.undo_stack.clear();
            project_stack.redo_stack.clear();
        }
        Ok(())
    }
    
    pub fn clear_all(&self) -> CoreResult<()> {
        let mut stacks = self.project_stacks.write()?;
        stacks.clear();
        Ok(())
    }
    
    pub fn get_current_commit_id(&self, project_id: ProjectId) -> CoreResult<Option<Uuid>> {
        let stacks = self.project_stacks.read()?;
        Ok(stacks.get(&project_id)
            .and_then(|s| s.get_current_commit_id()))
    }
}

// Global undo/redo stack
pub static UNDO_REDO_STACK: Lazy<UndoRedoStack> = Lazy::new(UndoRedoStack::new);

pub struct UndoRedoService {
    #[allow(dead_code)]
    event_bus: Arc<EventBus>,
}

impl UndoRedoService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }
    
    pub fn undo(&self, project_id: u32) -> UndoRedoResult {
        let project_id = ProjectId::from(project_id);
        match self.perform_undo(project_id) {
            Ok(Some((image_id, marker_id))) => {
                UndoRedoResult {
                    success: true,
                    image_id: image_id.map(|id| id.into()),
                    marker_id: marker_id.map(|id| id.into()),
                }
            },
            Ok(None) => {
                UndoRedoResult {
                    success: true,
                    image_id: None,
                    marker_id: None,
                }
            },
            Err(_) => {
                UndoRedoResult {
                    success: false,
                    image_id: None,
                    marker_id: None,
                }
            }
        }
    }
    
    pub fn redo(&self, project_id: u32) -> UndoRedoResult {
        let project_id = ProjectId::from(project_id);
        match self.perform_redo(project_id) {
            Ok(Some((image_id, marker_id))) => {
                UndoRedoResult {
                    success: true,
                    image_id: image_id.map(|id| id.into()),
                    marker_id: marker_id.map(|id| id.into()),
                }
            },
            Ok(None) => {
                UndoRedoResult {
                    success: true,
                    image_id: None,
                    marker_id: None,
                }
            },
            Err(_) => {
                UndoRedoResult {
                    success: false,
                    image_id: None,
                    marker_id: None,
                }
            }
        }
    }
    
    pub fn clear_project_history(&self, project_id: u32) {
        let project_id = ProjectId::from(project_id);
        let _ = UNDO_REDO_STACK.clear(project_id);
        self.emit_undo_redo_state(project_id, false, false, None);
    }
    
    pub fn clear_all_history(&self) {
        let _ = UNDO_REDO_STACK.clear_all();
    }

    // Record action through event
    pub fn record_action(&self, action: UndoRedoAction) -> CoreResult<()> {
        let project_id = action.project_id;
        UNDO_REDO_STACK.push_action(action)?;
        
        // Emit undo/redo state change event
        let can_undo = UNDO_REDO_STACK.can_undo(project_id)?;
        let can_redo = UNDO_REDO_STACK.can_redo(project_id)?;
        let current_commit_id = UNDO_REDO_STACK.get_current_commit_id(project_id)?;
        self.emit_undo_redo_state(project_id, can_undo, can_redo, current_commit_id);
        
        Ok(())
    }

    fn perform_undo(&self, project_id: ProjectId) -> CoreResult<Option<(Option<ImageId>, Option<MarkerId>)>> {
        UNDO_REDO_STACK.get_or_create_project_stack(project_id)?;
        
        let action = UNDO_REDO_STACK.pop_undo_action(project_id)?;
        
        if let Some(action) = action {
            // Set undoing flag
            UNDO_REDO_STACK.set_undoing(true)?;
            
            let location = action.get_affected_location();
            let result = perform_undo(&action);
            
            // Clear undoing flag
            UNDO_REDO_STACK.set_undoing(false)?;
            
            let reversed_action = result?;
            
            UNDO_REDO_STACK.push_redo_action(project_id, reversed_action)?;
            
            // Emit undo/redo state change event
            let can_undo = UNDO_REDO_STACK.can_undo(project_id)?;
            let can_redo = UNDO_REDO_STACK.can_redo(project_id)?;
            let current_commit_id = UNDO_REDO_STACK.get_current_commit_id(project_id)?;
            self.emit_undo_redo_state(project_id, can_undo, can_redo, current_commit_id);
            
            Ok(Some((location.0, location.1)))
        } else {
            Ok(None)
        }
    }
    
    fn perform_redo(&self, project_id: ProjectId) -> CoreResult<Option<(Option<ImageId>, Option<MarkerId>)>> {
        UNDO_REDO_STACK.get_or_create_project_stack(project_id)?;
        
        let action = UNDO_REDO_STACK.pop_redo_action(project_id)?;
        
        if let Some(action) = action {
            // Set undoing flag
            UNDO_REDO_STACK.set_undoing(true)?;
            
            let location = action.get_affected_location();
            let result = perform_redo(&action);
            
            // Clear undoing flag
            UNDO_REDO_STACK.set_undoing(false)?;
            
            let reversed_action = result?;
            
            UNDO_REDO_STACK.push_to_undo_stack(project_id, reversed_action)?;
            
            // Emit undo/redo state change event
            let can_undo = UNDO_REDO_STACK.can_undo(project_id)?;
            let can_redo = UNDO_REDO_STACK.can_redo(project_id)?;
            let current_commit_id = UNDO_REDO_STACK.get_current_commit_id(project_id)?;
            self.emit_undo_redo_state(project_id, can_undo, can_redo, current_commit_id);
            
            Ok(Some((location.0, location.1)))
        } else {
            Ok(None)
        }
    }

    fn emit_undo_redo_state(&self, project_id: ProjectId, can_undo: bool, can_redo: bool, current_commit_id: Option<Uuid>) {
        // Get the name of the action that can be undone
        let undo_action_name = if can_undo {
            let stacks = UNDO_REDO_STACK.project_stacks.read().unwrap();
            stacks.get(&project_id)
                .and_then(|s| s.undo_stack.back())
                .map(|action| action.action_type.get_action_name())
                .unwrap_or("none")
        } else {
            "none"
        };
        
        let _ = EVENT_SYSTEM.emit_business_event(
            "undo_redo_state_changed".to_string(),
            serde_json::json!({
                "project_id": project_id.0,
                "undo_action_name": undo_action_name,
                "can_redo": can_redo,
                "current_commit_id": current_commit_id.map(|id| id.to_string())
            })
        );
    }

    // Public API functions for compatibility
    pub fn can_undo(&self, project_id: ProjectId) -> CoreResult<bool> {
        UNDO_REDO_STACK.can_undo(project_id)
    }

    pub fn can_redo(&self, project_id: ProjectId) -> CoreResult<bool> {
        UNDO_REDO_STACK.can_redo(project_id)
    }
}

// 实现事件处理器，监听需要记录的操作
impl EventHandler for UndoRedoService {
    fn handle(&self, event: &DomainEvent) {
        match event {
            DomainEvent::ProjectDeleted(project_id) => {
                // 项目删除时清理历史
                self.clear_project_history(project_id.0);
            },
            DomainEvent::MarkerAddedToImage(image_id, marker_id) => {
                // Record add marker action
                if let Ok(services) = crate::service::try_get_service() {
                    if let Some(marker) = services.marker_service.get_marker_internal((*marker_id).into()) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(*image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::AddMarker { marker },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::MarkerRemovedFromImage(image_id, _marker_id, marker) => {
                // Record remove marker action
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(project_id)) = services.project_service.find_project_by_image(*image_id) {
                        let action = UndoRedoAction::new(
                            ActionType::RemoveMarker { marker: marker.clone() },
                            project_id
                        );
                        let _ = self.record_action(action);
                    }
                }
            },
            DomainEvent::RectangleGeometryUpdated { id, old_geometry, new_geometry } => {
                // Record rectangle geometry update
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(marker.image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::UpdateRectangleGeometry { 
                                    id: *id, 
                                    old_geometry: *old_geometry, 
                                    new_geometry: *new_geometry 
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::PointMarkerPositionUpdated { id, old_pos, new_pos } => {
                // Record position update
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(marker.image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::UpdatePointMarkerPosition { 
                                    id: *id, 
                                    old_pos: *old_pos, 
                                    new_pos: *new_pos 
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::MarkerTranslationUpdated { id, old_trans, new_trans } => {
                // Record translation update
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(marker.image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::UpdateMarkerTranslation { 
                                    id: *id, 
                                    old_trans: old_trans.clone(), 
                                    new_trans: new_trans.clone() 
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::MarkerStyleUpdated { id, old_style, new_style } => {
                // Record style update
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(marker.image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::UpdateMarkerStyle { 
                                    id: *id, 
                                    old_style: old_style.clone(), 
                                    new_style: new_style.clone() 
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::MarkerFullUpdated { id, old_position, new_position, old_translation, new_translation, old_style, new_style } => {
                // Record full update
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(marker)) = services.marker_service.get_marker_by_id(*id) {
                        if let Ok(Some(project_id)) = services.project_service.find_project_by_image(marker.image_id) {
                            let action = UndoRedoAction::new(
                                ActionType::UpdateMarker { 
                                    id: *id,
                                    old_position: *old_position,
                                    new_position: *new_position,
                                    old_translation: old_translation.clone(),
                                    new_translation: new_translation.clone(),
                                    old_style: old_style.clone(),
                                    new_style: new_style.clone(),
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            DomainEvent::MarkerOrderMoved { id, image_id, old_index, new_index } => {
                // Record marker order change
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(project_id)) = services.project_service.find_project_by_image(*image_id) {
                        let action = UndoRedoAction::new(
                            ActionType::UpdateMarkerOrder { 
                                id: *id,
                                image_id: *image_id,
                                old_index: *old_index,
                                new_index: *new_index,
                            },
                            project_id
                        );
                        let _ = self.record_action(action);
                    }
                }
            },
            DomainEvent::ImageMarkersCleared(image_id, markers) => {
                // Record clear image markers action
                if let Ok(services) = crate::service::try_get_service() {
                    if let Ok(Some(project_id)) = services.project_service.find_project_by_image(*image_id) {
                        if !markers.is_empty() {
                            let action = UndoRedoAction::new(
                                ActionType::ClearImageMarkers { 
                                    image_id: *image_id, 
                                    markers: markers.clone() 
                                },
                                project_id
                            );
                            let _ = self.record_action(action);
                        }
                    }
                }
            },
            _ => {
                // Other events don't need undo/redo recording yet
            }
        }
    }
}