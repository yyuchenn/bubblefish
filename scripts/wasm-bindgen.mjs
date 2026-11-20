import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function* cachedBinaries(directory, binary) {
  let entries;
  try {
    if (!(await lstat(directory)).isDirectory()) return;
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'target') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* cachedBinaries(path, binary);
    else if (entry.isFile() && entry.name === binary) yield path;
  }
}

export async function resolveWasmBindgen({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  root = resolve(root);
  const lock = await readFile(join(root, 'Cargo.lock'), 'utf8');
  const versions = new Set();
  for (const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] !== 'wasm-bindgen') continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!version || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version))
      throw new Error('Expected an exact wasm-bindgen version in Cargo.lock');
    versions.add(version);
  }
  if (versions.size !== 1)
    throw new Error(
      `Expected one wasm-bindgen version in Cargo.lock; found ${versions.size ? [...versions].sort().join(', ') : 'none'}`,
    );
  const [version] = versions;
  const expected = `wasm-bindgen ${version}`;
  function check(command) {
    const installed = exec(command, ['--version'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    }).trim();
    if (installed !== expected)
      throw new Error(`Expected ${expected}, found ${installed || 'empty version output'}`);
  }
  if (env.BUBBLEFISH_WASM_BINDGEN !== undefined) {
    const command = env.BUBBLEFISH_WASM_BINDGEN;
    try {
      check(command);
    } catch (cause) {
      throw new Error(
        `Invalid BUBBLEFISH_WASM_BINDGEN (${command}); expected ${expected}: ${cause.message}`,
        { cause },
      );
    }
    return command;
  }
  const binary = `wasm-bindgen${platform === 'win32' ? '.exe' : ''}`;
  for await (const command of cachedBinaries(join(root, '.cache/wasm-pack'), binary)) {
    try {
      check(command);
      return command;
    } catch {
      // Old versions or incomplete/restored tools must not hide a matching CLI.
    }
  }
  try {
    check('wasm-bindgen');
    return 'wasm-bindgen';
  } catch (cause) {
    throw new Error(
      `Cannot find ${expected}. Run npm run build:wasm to prepare the project CLI cache, or set BUBBLEFISH_WASM_BINDGEN to the matching CLI. ${cause.message}`,
      { cause },
    );
  }
}
