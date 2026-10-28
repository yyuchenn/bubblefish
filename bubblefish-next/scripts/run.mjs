import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const extra = process.argv.slice(3);
const children = new Set();
const cleanups = new Set();
const environment = {
  ...process.env,
  WASM_PACK_CACHE: join(root, '.cache', 'wasm-pack'),
  npm_config_cache: join(root, '.cache', 'npm'),
};
if (existsSync(join(root, '.cache', 'wasm-tools'))) {
  environment.PATH = `${join(root, '.cache', 'wasm-tools')}${delimiter}${process.env.PATH || ''}`;
}
// An optional workspace-local cache permits restricted environments to use a
// pre-populated registry without modifying the user's global Cargo directory.
if (!environment.CARGO_HOME && existsSync(join(root, '.cache', 'cargo', 'registry'))) {
  environment.CARGO_HOME = join(root, '.cache', 'cargo');
}
function start(binary, args, options = {}) {
  const child = spawn(binary, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function completion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (${signal || code})`)),
    );
  });
}
async function run(binary, args, options) {
  await completion(start(binary, args, options));
}
const node = (path, args = []) =>
  run(process.execPath, [join(root, 'node_modules', path), ...args]);

async function sourceHash() {
  const hash = createHash('sha256');
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      hash.update(path.slice(root.length));
      hash.update(await readFile(path));
    }
  }
  for (const name of [
    'Cargo.lock',
    'Cargo.toml',
    'crates/core',
    'crates/formats',
    'crates/wasm',
    'scripts/run.mjs',
  ])
    await visit(join(root, name));
  return hash.digest('hex');
}
async function wasm(release = false) {
  await mkdir(join(root, '.cache'), { recursive: true });
  const fingerprint = `${release ? 'release' : 'dev'}:${await sourceHash()}`;
  const cachePath = join(root, '.cache', 'wasm-build');
  const cached = await readFile(cachePath, 'utf8').catch(() => '');
  if (cached === fingerprint && existsSync(join(root, 'src/wasm/bubblefish_wasm_bg.wasm'))) return;
  await node('wasm-pack/run.js', [
    'build',
    'crates/wasm',
    '--target',
    'web',
    '--out-dir',
    '../../src/wasm',
    '--out-name',
    'bubblefish_wasm',
    release ? '--release' : '--dev',
    '--no-pack',
    '--',
    '--locked',
  ]);
  await writeFile(cachePath, fingerprint);
}
async function vite(build, desktop) {
  await node('vite/bin/vite.js', [
    ...(build ? ['build'] : []),
    '--mode',
    desktop ? 'desktop' : 'web',
    ...(!desktop ? extra : []),
  ]);
}
async function waitForDevServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:5174')).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vite did not start on port 5174');
}
async function webDevelopment() {
  await wasm();
  const { createServer } = await import('vite');
  const option = (name) => {
    const inline = extra.find((value) => value.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = extra.indexOf(name);
    if (index < 0) return undefined;
    return extra[index + 1] && !extra[index + 1].startsWith('--') ? extra[index + 1] : true;
  };
  const requestedPort = option('--port');
  const port = requestedPort === undefined ? undefined : Number(requestedPort);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error('--port requires a valid TCP port');
  const host = option('--host');
  const server = await createServer({
    mode: 'web',
    server: {
      ...(port ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(extra.includes('--open') ? { open: true } : {}),
      watch: { ignored: ['**/target/**', '**/.cache/**', '**/src-tauri/gen/**'] },
    },
  });
  await server.listen();
  server.printUrls();
  const watchers = [];
  let timer;
  let rebuilding = false;
  let dirty = false;
  async function rebuild() {
    if (rebuilding) {
      dirty = true;
      return;
    }
    rebuilding = true;
    do {
      dirty = false;
      try {
        console.log('[core] Rust sources changed; rebuilding WASM…');
        await wasm();
        server.ws.send({ type: 'full-reload' });
      } catch (error) {
        console.error(
          '[core] WASM rebuild failed; fix the Rust error to retry:',
          error instanceof Error ? error.message : error,
        );
      }
    } while (dirty);
    rebuilding = false;
  }
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void rebuild();
    }, 300);
  };
  watchers.push(
    watch(join(root, 'crates'), { recursive: true }, (_event, filename) => {
      const path = String(filename || '');
      if (path.endsWith('.rs') || path.endsWith('Cargo.toml')) changed();
    }),
  );
  watchers.push(
    watch(root, (_event, filename) => {
      if (['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml'].includes(String(filename))) changed();
    }),
  );
  for (const watcher of watchers)
    watcher.on('error', (error) => console.error('[core] Rust watcher failed:', error.message));
  cleanups.add(async () => {
    clearTimeout(timer);
    watchers.forEach((watcher) => watcher.close());
    await server.close();
  });
  console.log('[core] Watching Rust sources; a successful rebuild reloads the web application.');
  await new Promise(() => {});
}
async function main() {
  switch (command) {
    case 'types:generate':
      return run('cargo', ['run', '-p', 'bubblefish-typegen', '--locked']);
    case 'types:check':
      return run('cargo', ['run', '-p', 'bubblefish-typegen', '--locked', '--', '--check']);
    case 'test:core':
      return run('cargo', [
        'test',
        '-p',
        'bubblefish-core',
        '-p',
        'bubblefish-formats',
        '--locked',
        ...extra,
      ]);
    case 'test:host':
      return run('cargo', [
        'test',
        '-p',
        'bubblefish-wasm',
        '-p',
        'bubblefish-next-desktop',
        '--lib',
        '--locked',
        ...extra,
      ]);
    case 'check:wasm':
      return run('cargo', [
        'check',
        '-p',
        'bubblefish-wasm',
        '--target',
        'wasm32-unknown-unknown',
        '--locked',
        ...extra,
      ]);
    case 'build:wasm':
      return wasm(true);
    case 'dev:web':
      return webDevelopment();
    case 'build:web':
      await wasm(true);
      return vite(true, false);
    case 'build:desktop':
      await vite(true, true);
      return node('@tauri-apps/cli/tauri.js', ['build', ...extra]);
    case 'dev:desktop': {
      const server = start(process.execPath, [
        join(root, 'node_modules/vite/bin/vite.js'),
        '--mode',
        'desktop',
      ]);
      try {
        await waitForDevServer();
        await node('@tauri-apps/cli/tauri.js', ['dev', '--no-dev-server-wait', ...extra]);
      } finally {
        server.kill();
      }
      return;
    }
    default:
      throw new Error(`Unknown task: ${command}`);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    for (const child of children) child.kill();
    await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  for (const child of children) child.kill();
  process.exitCode = 1;
}
