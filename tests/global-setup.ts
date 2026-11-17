import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { testServerPort, testServerUrl } from './server';

async function newestRustInput(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return /\.(rs|toml|lock)$/.test(path) ? info.mtimeMs : 0;
  const timestamps = await Promise.all(
    (await readdir(path)).map((name) => newestRustInput(`${path}/${name}`)),
  );
  return Math.max(0, ...timestamps);
}

/** Directly own the Vite process so Windows teardown requires no taskkill tree privilege. */
export default async function setup() {
  const inputs = await Promise.all(
    ['Cargo.toml', 'Cargo.lock', 'crates/core', 'crates/formats', 'crates/wasm'].map(
      newestRustInput,
    ),
  );
  const built = await stat('src/wasm/bubblefish_wasm_bg.wasm')
    .then((info) => info.mtimeMs)
    .catch(() => 0);
  if (!built || Math.max(...inputs) > built) {
    await promisify(execFile)(process.execPath, ['scripts/run.mjs', 'build:wasm'], {
      cwd: resolve('.'),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
  }
  const available = async () => {
    try {
      return (await fetch(testServerUrl, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };
  if (await available()) return;
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--mode', 'web', '--port', String(testServerPort)],
    {
      cwd: resolve('.'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  server.stdout.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-16_000);
  });
  server.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-16_000);
  });
  const stop = async () => {
    if (server.exitCode !== null) return;
    await new Promise<void>((done) => {
      server.once('exit', () => done());
      server.kill();
      setTimeout(done, 1000).unref();
    });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Vite exited before startup:\n${output}`);
      if (await available()) return stop;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Vite did not start on port ${testServerPort}:\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
