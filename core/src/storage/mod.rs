// Storage module - contains all data structures and basic CRUD operations
pub mod traits;
pub mod state;
pub mod project;
pub mod marker;
pub mod image_data;
pub mod image;
pub mod dimension_extractor;
pub mod opening_project;
pub mod undo_redo;

// Re-export commonly used items
pub use traits::Storage;
pub use state::{
    APP_STATE, AppState,
    ProjectStorage, ImageStorage, MarkerStorage, ThumbnailStorage
};
pub use project::Project;
pub use marker::{Marker, MarkerStyle};
pub use image_data::{ImageData, ImageFormat};
pub use image::{Image, ImageMetadata};
pub use opening_project::{OpeningProject, OpeningProjectStorage, OPENING_PROJECT_STORAGE};
pub use undo_redo::{
    ActionType, UndoRedoAction, ProjectUndoRedoStack, UndoRedoStack, UNDO_REDO_STACK
};