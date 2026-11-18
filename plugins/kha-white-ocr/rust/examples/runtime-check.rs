//! Load the actual packaged runtime without requiring any OCR model files.
use bubblefish_kha_white_ocr::native::{
    initialize_runtime_at, runtime_path, shutdown_runtime_after_sessions_drop,
};
use std::{env, error::Error, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let directory = arguments
        .next()
        .ok_or("Usage: runtime-check PLUGIN_DIRECTORY")?;
    if arguments.next().is_some() {
        return Err("Usage: runtime-check PLUGIN_DIRECTORY".into());
    }
    let directory = PathBuf::from(directory).canonicalize()?;
    env::set_current_dir(&directory)?;
    let runtime = runtime_path()?;
    if !runtime.starts_with(&directory) {
        return Err(format!(
            "Resolved runtime {} is outside plugin directory {}",
            runtime.display(),
            directory.display()
        )
        .into());
    }
    initialize_runtime_at(&runtime)?;
    // No sessions or tensors are created by this model-free initialization check.
    unsafe {
        shutdown_runtime_after_sessions_drop();
    }
    println!(
        "Packaged ONNX Runtime initialized and shut down: {}",
        runtime.display()
    );
    Ok(())
}
