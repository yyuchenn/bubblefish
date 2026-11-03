import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { zipSync, strToU8 } from 'fflate';

const directory = dirname(fileURLToPath(import.meta.url)),
  root = resolve(directory, '../..');
const args = process.argv.slice(2),
  webOnly = args.includes('--web-only');
const targetArg = args.indexOf('--target');
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const target = targetArg < 0 ? host : args[targetArg + 1];
if (!target) throw new Error('No Rust target');
const work = join(root, '.cache/kha-white-ocr'),
  generated = join(work, 'pkg');
await mkdir(generated, { recursive: true });
function run(command, values, env = {}) {
  execFileSync(command, values, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}
const cargoMode = args.includes('--offline') ? '--offline' : '--locked';
run('cargo', [
  'build',
  cargoMode,
  '-p',
  'bubblefish-kha-white-ocr',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--no-default-features',
  '--features',
  'wasm',
]);
const lock = await readFile(join(root, 'Cargo.lock'), 'utf8');
const version = lock.match(/\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/)?.[1];
const cached = join(
  root,
  `.cache/wasm-pack/wasm-bindgen-cargo-install-${version}/wasm-bindgen${process.platform === 'win32' ? '.exe' : ''}`,
);
const bindgen =
  process.env.BUBBLEFISH_WASM_BINDGEN ?? (existsSync(cached) ? cached : 'wasm-bindgen');
if (execFileSync(bindgen, ['--version'], { encoding: 'utf8' }).trim() !== `wasm-bindgen ${version}`)
  throw new Error(`Install wasm-bindgen-cli ${version}, or run npm run build:web first`);
run(bindgen, [
  join(root, 'target/wasm32-unknown-unknown/release/bubblefish_kha_white_ocr.wasm'),
  '--target',
  'web',
  '--out-name',
  'shared',
  '--out-dir',
  generated,
]);

async function bundle(entry) {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  if (output.length !== 1 || output[0].type !== 'chunk')
    throw new Error(
      'Kha plugin must use explicit resource assets, not implicit bundle dependencies',
    );
  return strToU8(output[0].code);
}
const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'));
const files = {
  'web.js': await bundle(join(directory, 'web.ts')),
  'shared.js': new Uint8Array(await readFile(join(generated, 'shared.js'))),
  'shared_bg.wasm': new Uint8Array(await readFile(join(generated, 'shared_bg.wasm'))),
  'model-manifest.json': new Uint8Array(await readFile(join(directory, 'model-manifest.json'))),
  'japanese-smoke.png': new Uint8Array(
    await readFile(join(root, 'tests/fixtures/kha-white/japanese-smoke.png')),
  ),
};
const panel = await readFile(join(directory, 'panel.html'), 'utf8');
files['panel.html'] = strToU8(
  panel.replace(
    '<!-- plugin:script -->',
    `<script type="module">${new TextDecoder().decode(await bundle(join(directory, 'panel.ts'))).replaceAll('</script', '<\\/script')}</script>`,
  ),
);
for (const name of [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
])
  files[`vendor/ort/${name}`] = new Uint8Array(
    await readFile(join(root, 'node_modules/onnxruntime-web/dist', name)),
  );
files['NOTICE.txt'] = strToU8(
  'Kha White Manga OCR: kha-white/manga-ocr-base, revision aa6573bd10b0d446cbf622e29c3e084914df9741, Apache-2.0.\nONNX Runtime 1.22.0: Microsoft, MIT.\nRust image preprocessing preserves the original Bubblefish plugin behavior.\n',
);
files['LICENSE-ONNXRUNTIME.txt'] = new Uint8Array(
  await readFile(join(directory, 'LICENSE-ONNXRUNTIME.md')),
);
files['LICENSE-APACHE-2.0.txt'] = new Uint8Array(await readFile(resolve(root, '../LICENSE')));
const output = join(root, 'dist/plugins');
await mkdir(output, { recursive: true });
async function pack(name) {
  files['plugin.json'] = strToU8(JSON.stringify(manifest, null, 2));
  if (Object.values(files).reduce((size, bytes) => size + bytes.length, 0) > 256 * 1024 * 1024)
    throw new Error('Plugin assets exceed 256 MiB');
  const path = join(output, name);
  await writeFile(path, zipSync(files));
  console.log(path);
}
await pack('kha-white-ocr-plugin-web.bfplugin');
if (!webOnly) {
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
    '--bin',
    'kha-white-ocr',
  ]);
  const executable = `kha-white-ocr${target.includes('windows') ? '.exe' : ''}`;
  const entry = `native/${target}/${executable}`;
  files[entry] = new Uint8Array(
    await readFile(join(root, `target/${target}/release/${executable}`)),
  );
  manifest.entrypoints.native = { [target]: entry };
  const library = target.includes('windows')
    ? 'onnxruntime.dll'
    : target.includes('apple')
      ? 'libonnxruntime.1.22.0.dylib'
      : 'libonnxruntime.so.1.22.0';
  const runtimeAt = args.indexOf('--ort-runtime');
  const candidates = [
    runtimeAt < 0 ? process.env.BUBBLEFISH_ORT_RUNTIME : args[runtimeAt + 1],
    target === host && target.includes('apple')
      ? resolve(
          root,
          `../plugins/kha-white-ocr-plugin/target/model-conversion/venv/lib/python3.12/site-packages/onnxruntime/capi/${library}`,
        )
      : undefined,
  ].filter(Boolean);
  const runtime = candidates.find((path) => existsSync(path));
  if (!runtime)
    throw new Error(
      `Supply ONNX Runtime 1.22.0 for ${target} using --ort-runtime <${library}> or BUBBLEFISH_ORT_RUNTIME`,
    );
  files[`vendor/native/${target}/${library}`] = new Uint8Array(await readFile(runtime));
  if (target.includes('windows')) {
    for (const entry of await readdir(dirname(runtime), { withFileTypes: true }))
      if (entry.isFile() && /\.dll$/i.test(entry.name))
        files[`vendor/native/${target}/${entry.name}`] = new Uint8Array(
          await readFile(join(dirname(runtime), entry.name)),
        );
  }
  await pack(`kha-white-ocr-plugin-${target}.bfplugin`);
  // An extracted development package is also useful to inspect runtime dependencies.
  const extracted = join(work, target);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(extracted, path)), { recursive: true });
    await writeFile(join(extracted, path), bytes);
  }
  const { chmod } = await import('node:fs/promises');
  await chmod(join(extracted, entry), 0o755);
  console.log(`Extracted package: ${extracted}`);
}
