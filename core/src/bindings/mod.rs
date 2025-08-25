#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "tauri")]
pub mod tauri;

#[cfg(feature = "wasm")]
pub use wasm::*;

#[cfg(feature = "tauri")]
pub use tauri::*;