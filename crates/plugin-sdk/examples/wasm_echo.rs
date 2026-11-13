//! Compile with --target wasm32-unknown-unknown --features wasm --example wasm_echo.
#[path = "echo.rs"]
mod echo;

#[cfg(target_arch = "wasm32")]
bubblefish_plugin_sdk::export_wasm_plugin!(echo::Echo);
