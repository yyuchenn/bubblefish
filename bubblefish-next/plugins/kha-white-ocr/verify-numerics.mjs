// Numerical parity tool. The Web engine runs under Node, not a browser; browser
// installation, Worker/blob loading, and OCR workflow are separate Playwright tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..'),
  args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert(target);
const work = resolve(option('--output', join(root, '.cache/kha-numerics')));
const modelDirectory = resolve(
  option('--models', join(root, '../plugins/kha-white-ocr-plugin/onnx_model')),
);
const packagePath = resolve(
  option('--package', join(root, 'dist/plugins', `kha-white-ocr-plugin-${target}.bfplugin`)),
);
const cargoMode = args.includes('--offline') ? '--offline' : '--locked';
await mkdir(work, { recursive: true });
const pkg = unzipSync(new Uint8Array(await readFile(packagePath)));
const model = JSON.parse(new TextDecoder().decode(pkg['model-manifest.json']));
const fixturePath = join(work, 'japanese-smoke.png');
await writeFile(fixturePath, pkg['japanese-smoke.png']);
const libraryName = target.includes('apple')
  ? 'libonnxruntime.1.22.0.dylib'
  : target.includes('windows')
    ? 'onnxruntime.dll'
    : 'libonnxruntime.so.1.22.0';
const nativeLibrary = resolve(option('--ort-runtime', join(work, libraryName)));
if (!args.includes('--ort-runtime')) {
  const library = pkg[`vendor/native/${target}/${libraryName}`];
  assert(library, `Package has no native ORT library for ${target}`);
  await writeFile(nativeLibrary, library);
  // Windows CPU runtime packages may include provider/shared dependency DLLs.
  for (const [name, bytes] of Object.entries(pkg))
    if (name.startsWith(`vendor/native/${target}/`) && name.endsWith('.dll'))
      await writeFile(join(work, name.split('/').at(-1)), bytes);
}
const approvedFiles = [];
for (const file of model.files) {
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of createReadStream(join(modelDirectory, file.path))) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  const digest = hash.digest('hex');
  assert.equal(length, file.byteLength, file.path);
  assert.equal(digest, file.sha256, file.path);
  approvedFiles.push({ path: file.path, byteLength: length, sha256: digest });
}
function run(command, values) {
  execFileSync(command, values, { cwd: root, stdio: 'inherit' });
}
run('cargo', [
  'build',
  cargoMode,
  '-p',
  'bubblefish-kha-white-ocr',
  '--release',
  '--features',
  'native',
  '--target',
  target,
  '--example',
  'probe',
]);
const probe = join(
  root,
  `target/${target}/release/examples/probe${process.platform === 'win32' ? '.exe' : ''}`,
);
run(probe, [modelDirectory, fixturePath, work, nativeLibrary]);
const nativeReport = JSON.parse(await readFile(join(work, 'report.json'), 'utf8'));
assert.equal(nativeReport.passed, true);

// Compile the unmodified legacy ImageProcessor source separately. This avoids
// proving parity by having both sides call the newly extracted implementation.
const legacySourcePath = join(root, '../plugins/kha-white-ocr-plugin/src/lib.rs');
const legacySource = await readFile(legacySourcePath, 'utf8');
const start = legacySource.indexOf('struct ImageProcessor {'),
  end = legacySource.indexOf('struct Tokenizer {', start);
assert(start >= 0 && end > start, 'Cannot locate the original Rust ImageProcessor reference');
const legacy = join(work, 'legacy-reference');
await mkdir(join(legacy, 'src'), { recursive: true });
await writeFile(
  join(legacy, 'Cargo.toml'),
  '[package]\nname="kha-legacy-preprocess"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[dependencies]\nimage={version="=0.25.10",default-features=false,features=["png","jpeg"]}\nndarray="=0.16.1"\nserde={version="=1.0.229",features=["derive"]}\nserde_json="=1.0.151"\n',
);
await writeFile(
  join(legacy, 'src/main.rs'),
  `use image::DynamicImage;use ndarray::Array4;use serde::Deserialize;
#[derive(Deserialize)]struct PreprocessorConfig{image_size:[u32;2],rescale_factor:f32,image_mean:[f32;3],image_std:[f32;3]}
${legacySource.slice(start, end)}
fn main()->Result<(),Box<dyn std::error::Error>>{let args:Vec<_>=std::env::args().skip(1).collect();let config:serde_json::Value=serde_json::from_slice(&std::fs::read(&args[0])?)?;let processor=ImageProcessor::new(serde_json::from_value(config["preprocessor"].clone())?);let image=image::load_from_memory(&std::fs::read(&args[1])?)?;let grayscale=image.to_luma8();let rgb_image=DynamicImage::ImageLuma8(grayscale).to_rgb8();let converted_image=DynamicImage::ImageRgb8(rgb_image);let pixels=processor.process(&converted_image)?;let (values,_)=pixels.into_raw_vec_and_offset();let data:Vec<u8>=values.iter().flat_map(|value|value.to_le_bytes()).collect();std::fs::write(&args[2],data)?;Ok(())}
`,
);
const legacyOutput = join(work, 'legacy-preprocess.f32');
run('cargo', [
  'run',
  ...(args.includes('--offline') ? ['--offline'] : []),
  '--quiet',
  '--manifest-path',
  join(legacy, 'Cargo.toml'),
  '--target-dir',
  join(root, 'target'),
  '--',
  join(modelDirectory, 'config.json'),
  fixturePath,
  legacyOutput,
]);
const nativePixels = await readFile(join(work, 'preprocess.f32'));
assert.equal(
  Buffer.compare(nativePixels, await readFile(legacyOutput)),
  0,
  'New native preprocessing differs from the original Rust implementation',
);

const generated = join(root, '.cache/kha-white-ocr/pkg');
const shared = await import(pathToFileURL(join(generated, 'shared.js')).href);
await shared.default({ module_or_path: await readFile(join(generated, 'shared_bg.wasm')) });
const processor = new shared.KhaProcessor(
  await readFile(join(modelDirectory, 'config.json'), 'utf8'),
  await readFile(join(modelDirectory, 'vocab.txt'), 'utf8'),
);
const pixels = processor.preprocess(new Uint8Array(pkg['japanese-smoke.png']));
assert.equal(
  Buffer.compare(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), nativePixels),
  0,
  'WASM preprocessing differs from native Rust',
);
const ortDirectory = join(root, 'node_modules/onnxruntime-web/dist');
const ort = await import(pathToFileURL(join(ortDirectory, 'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = {
  mjs: pathToFileURL(join(ortDirectory, 'ort-wasm-simd-threaded.mjs')).href,
  wasm: pathToFileURL(join(ortDirectory, 'ort-wasm-simd-threaded.wasm')).href,
};
const comparisons = [];
async function compare(name, values, shape) {
  const bytes = await readFile(join(work, `${name}.f32`));
  const expected = new Float32Array(new Uint8Array(bytes).buffer);
  assert.equal(values.length, expected.length, `${name} length`);
  let maxAbsError = 0,
    sumAbsError = 0,
    outside = 0;
  for (let index = 0; index < values.length; index++) {
    assert(Number.isFinite(values[index]), `${name} contains a non-finite element`);
    const error = Math.abs(values[index] - expected[index]);
    maxAbsError = Math.max(maxAbsError, error);
    sumAbsError += error;
    if (error > 1e-4 + 1e-3 * Math.abs(expected[index])) outside++;
  }
  const result = {
    name,
    shape,
    maxAbsError,
    meanAbsError: sumAbsError / values.length,
    elementsOutsideTolerance: outside,
    passed: outside === 0,
  };
  comparisons.push(result);
  assert.equal(outside, 0, JSON.stringify(result));
}
let encoder, decoder, hidden;
try {
  encoder = await ort.InferenceSession.create(
    new Uint8Array(await readFile(join(modelDirectory, 'encoder.onnx'))),
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
  );
  decoder = await ort.InferenceSession.create(
    new Uint8Array(await readFile(join(modelDirectory, 'decoder.onnx'))),
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
  );
  const input = new ort.Tensor('float32', pixels, [1, 3, 224, 224]);
  try {
    hidden = (await encoder.run({ pixel_values: input })).encoder_hidden_states;
  } finally {
    input.dispose();
  }
  assert.deepEqual(hidden.dims, [1, 197, 768]);
  await compare('encoder', hidden.data, hidden.dims);
  for (const length of [1, 2, 8, 32, 300]) {
    const ids = new ort.Tensor('int64', new BigInt64Array(length).fill(2n), [1, length]);
    const mask = new ort.Tensor('int64', new BigInt64Array(length).fill(1n), [1, length]);
    let result;
    try {
      result = await decoder.run({
        input_ids: ids,
        encoder_hidden_states: hidden,
        attention_mask: mask,
      });
      assert.deepEqual(result.logits.dims, [1, length, 6144]);
      await compare(`decoder-${length}`, result.logits.data, result.logits.dims);
    } finally {
      ids.dispose();
      mask.dispose();
      for (const value of Object.values(result ?? {})) value.dispose();
    }
  }
  const tokens = [2];
  for (let step = 0; step < 300; step++) {
    const ids = new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]);
    const mask = new ort.Tensor('int64', new BigInt64Array(tokens.length).fill(1n), [
      1,
      tokens.length,
    ]);
    let result, next;
    try {
      result = await decoder.run({
        input_ids: ids,
        encoder_hidden_states: hidden,
        attention_mask: mask,
      });
      const logits = result.logits.data;
      next = shared.argmax(logits.subarray(logits.length - 6144));
    } finally {
      ids.dispose();
      mask.dispose();
      for (const value of Object.values(result ?? {})) value.dispose();
    }
    tokens.push(next);
    if (next === 3) break;
  }
  assert.deepEqual(tokens, nativeReport.tokenIds);
  const text = processor.decode(Int32Array.from(tokens.slice(1)));
  assert.equal(text, '今日はいい天気ですね。');
  const report = {
    passed: true,
    backend: 'node-onnxruntime-web-wasm',
    browserVerification: false,
    runtimeVersion: '1.22.0',
    numThreads: 1,
    models: approvedFiles,
    legacySourceSha256: createHash('sha256').update(legacySource).digest('hex'),
    preprocessByteExact: true,
    preprocessSha256: createHash('sha256').update(nativePixels).digest('hex'),
    atol: 1e-4,
    rtol: 1e-3,
    comparisons,
    text,
    tokenIds: tokens,
  };
  await writeFile(join(work, 'web-comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  hidden?.dispose();
  await decoder?.release();
  await encoder?.release();
  processor.free();
}
