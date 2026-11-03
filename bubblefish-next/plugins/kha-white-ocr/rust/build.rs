fn main() {
    println!(
        "cargo:rustc-env=BF_KHA_NATIVE_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
}
