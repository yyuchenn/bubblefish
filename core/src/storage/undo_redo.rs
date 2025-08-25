use crate::common::CoreResult;
use crate::common::{ImageId, MarkerId, ProjectId};
use crate::storage::marker::{Marker, MarkerStyle};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::RwLock;
use once_cell::sync::Lazy;
use uuid::Uuid;

const MAX_UNDO_HISTORY: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActionType {
    // Image actions
    AddImage { id: ImageId, name: Option<String> },
    RemoveImage { id: ImageId, name: Option<String>, data: Vec<u8> },
    UpdateImage { id: ImageId, old_name: Option<String>, new_name: Option<String> },
    
    // Marker actions
    AddMarker { marker: Marker },
    RemoveMarker { marker: Marker },
    UpdateMarker { 
        id: MarkerId, 
        old_position: (f64, f64),
        new_position: (f64, f64),
        old_translation: String,
        new_translation: String,
        old_style: MarkerStyle,
        new_style: MarkerStyle,
    },
    UpdateMarkerPosition { id: MarkerId, old_pos: (f64, f64), new_pos: (f64, f64) },
    UpdateMarkerTranslation { id: MarkerId, old_trans: String, new_trans: String },
    UpdateMarkerStyle { id: MarkerId, old_style: MarkerStyle, new_style: MarkerStyle },
    
    // Batch operations
    ClearImageMarkers { image_id: ImageId, markers: Vec<Marker> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoRedoAction {
    pub id: Uuid,
    pub action_type: ActionType,
    pub project_id: ProjectId,
    #[cfg(not(target_arch = "wasm32"))]
    pub timestamp: u64,
}

impl UndoRedoAction {
    pub fn new(action_type: ActionType, project_id: ProjectId) -> Self {
        Self {
            id: Uuid::new_v4(),
            action_type,
            project_id,
            #[cfg(not(target_arch = "wasm32"))]
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
    
    pub fn with_id(id: Uuid, action_type: ActionType, project_id: ProjectId) -> Self {
        Self {
            id,
            action_type,
            project_id,
            #[cfg(not(target_arch = "wasm32"))]
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
}

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