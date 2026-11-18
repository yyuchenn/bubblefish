import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { zipSync } from 'fflate';
import { resolveWasmBindgen } from '../../../scripts/wasm-bindgen.mjs';

const examples = dirname(fileURLToPath(import.meta.url));
const root = resolve(examples, '../../..');
const output = join(root, '.cache/plugin-sdk-example');
const target = join(root, 'target');
const webOnly = process.argv.includes('--web-only');
function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

const bindgen = await resolveWasmBindgen({ root });
await mkdir(output, { recursive: true });
run('cargo', [
  'build',
  '--locked',
  '-p',
  'bubblefish-plugin-sdk',
  '--example',
  'wasm_echo',
  '--target',
  'wasm32-unknown-unknown',
  '--features',
  'wasm',
  '--target-dir',
  target,
]);
run(bindgen, [
  join(target, 'wasm32-unknown-unknown/debug/examples/wasm_echo.wasm'),
  '--target',
  'web',
  '--out-dir',
  join(output, 'pkg'),
]);
await writeFile(join(output, 'wasm-entry.mjs'), await readFile(join(examples, 'wasm-entry.mjs')));
const bundle = await rolldown({ input: join(output, 'wasm-entry.mjs') });
await bundle.write({ file: join(output, 'entry.js'), format: 'es' });
await bundle.close();

const manifest = {
  id: 'example.echo',
  name: 'Rust SDK example',
  version: '0.1.0',
  apiVersion: 1,
  description:
    'Rust WASM/native: providers, image bytes, transactions, history, events and isolated text hooks.',
  entrypoints: { web: 'entry.js' },
  contributes: {
    ocr: [{ id: 'echo-ocr', name: 'Echo OCR' }],
    translation: [{ id: 'prefix-translation', name: 'Prefix translation example' }],
    commands: [
      { id: 'inspect-document', title: 'Rust: inspect document and history' },
      { id: 'duplicate-image', title: 'Rust: duplicate first image' },
      { id: 'task-demo', title: 'Rust: task progress and cancellation' },
    ],
    beforeCommitHooks: [{ id: 'normalize-text', priority: 20, operations: ['translation.set'] }],
  },
  permissions: [
    'document.read',
    'document.write',
    'images.read',
    'images.write',
    'history.read',
    'history.control',
    'document.intercept',
  ],
};
const files = {
  'entry.js': new Uint8Array(await readFile(join(output, 'entry.js'))),
  'wasm_echo_bg.wasm': new Uint8Array(await readFile(join(output, 'pkg/wasm_echo_bg.wasm'))),
};
if (!webOnly) {
  run('cargo', [
    'build',
    '--locked',
    '-p',
    'bubblefish-plugin-sdk',
    '--example',
    'echo',
    '--target-dir',
    target,
  ]);
  const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8', cwd: root }).match(
    /^host: (.+)$/m,
  )?.[1];
  if (!host) throw new Error('rustc did not report the native target');
  const executable = process.platform === 'win32' ? 'echo.exe' : 'echo';
  const entry = `bin/${executable}`;
  manifest.entrypoints.native = { [host]: entry };
  files[entry] = new Uint8Array(await readFile(join(target, `debug/examples/${executable}`)));
}
files['plugin.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
const destination = join(output, 'example.echo.bfplugin');
await writeFile(destination, zipSync(files));
process.stdout.write(`Built ${destination}\n`);
