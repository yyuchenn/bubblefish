fn main() {
    let result = bubblefish_plugin_sdk::native::serve_stdio(
        bubblefish_kha_white_ocr::native::KhaPlugin::default(),
    );
    // serve_stdio owns and drops the plugin and all sessions before returning.
    unsafe {
        bubblefish_kha_white_ocr::native::shutdown_runtime_after_sessions_drop();
    }
    if let Err(error) = result {
        eprintln!("Kha White OCR: {error}");
        std::process::exit(1);
    }
}
