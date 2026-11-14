# Bubblefish Kha White OCR model conversion

The Bubblefish plugin embeds `encoder.onnx`, `decoder.onnx`, `config.json`, and
`vocab.txt` from `plugins/kha-white-ocr-plugin/onnx_model/` at compile time. Use the
official [kha-white/manga-ocr-base](https://huggingface.co/kha-white/manga-ocr-base)
checkpoint at revision `aa6573bd10b0d446cbf622e29c3e084914df9741`.

Run the following commands from the **repository root** with Python 3.12. The
isolated environment, checkpoint, staging output, and logs stay under the
Git-ignored `plugins/kha-white-ocr-plugin/target/model-conversion/` directory.
ONNX Runtime 1.22.0 matches the plugin's `ort-sys` 2.0.0-rc.10 runtime.

```bash
conversion_dir="$PWD/plugins/kha-white-ocr-plugin/target/model-conversion"
python3.12 -m venv "$conversion_dir/venv"
"$conversion_dir/venv/bin/python" -m pip install \
  --cache-dir "$conversion_dir/pip-cache" \
  -r plugins/kha-white-ocr-plugin/snippet/requirements-conversion.txt
"$conversion_dir/venv/bin/python" -m pip freeze > "$conversion_dir/requirements.freeze.txt"
mkdir -p "$conversion_dir/logs"

"$conversion_dir/venv/bin/python" - <<'PY'
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download

work = Path('plugins/kha-white-ocr-plugin/target/model-conversion')
revision = 'aa6573bd10b0d446cbf622e29c3e084914df9741'
source = Path(snapshot_download(
    repo_id='kha-white/manga-ocr-base', revision=revision,
    local_dir=work / 'source',
    allow_patterns=['*.json', '*.bin', 'vocab.txt', 'README.md'],
))
weights = source / 'pytorch_model.bin'
if weights.stat().st_size != 444135475:
    raise RuntimeError('Unexpected official checkpoint size')
with weights.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != 'c63e0bb5b3ff798c5991de18a8e0956c7ee6d1563aca6729029815eda6f5c2eb':
    raise RuntimeError('Official checkpoint SHA256 mismatch')
(work / 'source-manifest.json').write_text(json.dumps({
    'repo_id': 'kha-white/manga-ocr-base', 'revision': revision,
    'weight_file': str(weights), 'weight_size_bytes': weights.stat().st_size,
    'weight_sha256': digest,
}, indent=2) + '\n', encoding='utf-8')
PY

set -o pipefail
"$conversion_dir/venv/bin/python" \
  plugins/kha-white-ocr-plugin/snippet/convert_to_onnx.py \
  --model "$conversion_dir/source" --output "$conversion_dir/staging" --opset 14 \
  2>&1 | tee "$conversion_dir/logs/conversion.log"
```

Conversion uses CPU FP32, eager attention, the legacy PyTorch ONNX exporter, and
self-contained weights. It requires all four plugin files, checks ONNX graphs,
loads both models from bytes with ONNX Runtime, and runs decoder sequence lengths
1, 2, and 8. Any failure exits nonzero; keep the staging output unpublished until
these checks pass.

The current local conversion workspace also includes `validate_model.py` for
additional PyTorch/ONNX numerical comparisons and a generated Japanese text
smoke test. Rerun it with:

```bash
"$conversion_dir/venv/bin/python" \
  "$conversion_dir/validate_model.py" \
  --model "$conversion_dir/staging" --source "$conversion_dir/source" \
  --output "$conversion_dir/validation"
```

This helper is a local, Git-ignored artifact supplied with the current run; a
clean checkout needs that helper copied separately. Retain
`source-manifest.json`, `requirements.freeze.txt`, logs, and
`validation/results.json` in the conversion workspace for the source revision,
installed dependency versions, and validation evidence.

After validation passes, install the four files and check the native plugin:

```bash
mkdir -p plugins/kha-white-ocr-plugin/onnx_model
for model_file in encoder.onnx decoder.onnx config.json vocab.txt; do
  cp "$conversion_dir/staging/$model_file" plugins/kha-white-ocr-plugin/onnx_model/
done
cargo check --locked --offline -p kha-white-ocr-plugin --features native
```

The model directory is Git-ignored. These commands do not rebuild or replace
`desktop/resources/plugins/libkha_white_ocr_plugin.dylib`; embedded models take
effect when the native plugin is subsequently rebuilt.

## Historical standalone Rust example

The remaining notes describe the older `snippet/main.rs` CLI example, not the
Bubblefish plugin build. This directory has no standalone Cargo manifest for that
example; its binary commands require a separate CLI project.

A Rust implementation of manga OCR using ONNX Runtime.

### Prerequisites

1. ONNX model files (generated using `convert_to_onnx.py` from the parent directory)
2. ONNX Runtime library

### Building

```bash
cargo build --release
```

### Running

#### Option 1: Using Python's ONNX Runtime library

If you have onnxruntime installed via pip, you can use its library:

```bash
# Find the library path
python3 -c "import onnxruntime; import os; print(os.path.dirname(onnxruntime.__file__))"

# Run with the library path
ORT_DYLIB_PATH=/path/to/onnxruntime/capi/libonnxruntime.*.dylib \
    ./target/release/manga_ocr_rust --image /path/to/image.png
```

#### Option 2: Install ONNX Runtime system-wide

Download and install ONNX Runtime from: https://github.com/microsoft/onnxruntime/releases

### Usage

```bash
manga_ocr_rust --image <IMAGE_PATH> [--model <MODEL_DIR>] [--verbose]
```

Arguments:
- `--image`: Path to the input image (required)
- `--model`: Path to ONNX model directory (default: `../onnx_model`)
- `--verbose`: Enable verbose output

### Example

```bash
ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib \
    ./target/release/manga_ocr_rust --image example.png --verbose
```

### Features

- Fast ONNX Runtime inference
- Support for manga/comic text recognition
- Japanese text post-processing
- Minimal dependencies
