fn main() {
    println!(
        "cargo:rustc-env=BF_NATIVE_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
