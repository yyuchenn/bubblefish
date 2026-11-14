//! Platform-independent document model and serial command engine.
//! No filesystem, DOM, Tauri or clock dependencies live in this crate.
mod engine;
pub mod model;
pub mod protocol;
mod validation;

pub use engine::Engine;
pub use model::*;
pub use protocol::*;
pub use validation::validate_document;
