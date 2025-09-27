# Manga OCR Rust

A Rust implementation of manga OCR using ONNX Runtime.

## Prerequisites

1. ONNX model files (generated using `convert_to_onnx.py` from the parent directory)
2. ONNX Runtime library

## Building

```bash
cargo build --release
```

## Running

### Option 1: Using Python's ONNX Runtime library

If you have onnxruntime installed via pip, you can use its library:

```bash
# Find the library path
python3 -c "import onnxruntime; import os; print(os.path.dirname(onnxruntime.__file__))"

# Run with the library path
ORT_DYLIB_PATH=/path/to/onnxruntime/capi/libonnxruntime.*.dylib \
    ./target/release/manga_ocr_rust --image /path/to/image.png
```

### Option 2: Install ONNX Runtime system-wide

Download and install ONNX Runtime from: https://github.com/microsoft/onnxruntime/releases

## Usage

```bash
manga_ocr_rust --image <IMAGE_PATH> [--model <MODEL_DIR>] [--verbose]
```

Arguments:
- `--image`: Path to the input image (required)
- `--model`: Path to ONNX model directory (default: `../onnx_model`)
- `--verbose`: Enable verbose output

## Example

```bash
ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib \
    ./target/release/manga_ocr_rust --image example.png --verbose
```

## Features

- Fast ONNX Runtime inference
- Support for manga/comic text recognition
- Japanese text post-processing
- Minimal dependencies