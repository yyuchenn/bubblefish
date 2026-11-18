import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { extractRuntimeEntries, fetchRuntime } from '../plugins/kha-white-ocr/fetch-runtime.mjs';

const version = '1.31.1';
const windows = 'x86_64-pc-windows-msvc';
const macos = 'aarch64-apple-darwin';
const main = 'runtimes/win-x64/native/onnxruntime.dll';
const shared = 'runtimes/win-x64/native/onnxruntime_providers_shared.dll';
const dylib = 'runtimes/osx-arm64/native/libonnxruntime.dylib';
const archive = zipSync({
  [main]: strToU8('windows runtime'),
  [shared]: strToU8('shared provider'),
  'runtimes/win-x64/native/extra.dll': strToU8('extra dependency'),
  'runtimes/win-x64/native/onnxruntime.lib': strToU8('link library'),
  [dylib]: strToU8('macOS runtime'),
  'runtimes/linux-x64/native/libonnxruntime.so': strToU8('other platform'),
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bubblefish-ort-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { 'onnxruntime-web': version } }),
  );
  const env = { GITHUB_ENV: join(root, 'github-env') };
  return { root, env, sleep: async () => {} };
}

test('extracts only the requested native runtime and retains Windows dependency DLLs', () => {
  assert.deepEqual(Object.keys(extractRuntimeEntries(archive, windows, version)).sort(), [
    'extra.dll',
    'onnxruntime.dll',
    'onnxruntime_providers_shared.dll',
  ]);
  const mac = extractRuntimeEntries(archive, macos, version);
  assert.deepEqual(Object.keys(mac), ['libonnxruntime.1.31.1.dylib']);
  assert.equal(new TextDecoder().decode(mac['libonnxruntime.1.31.1.dylib']), 'macOS runtime');
});

test('rejects missing main/provider libraries and invalid archives', () => {
  assert.throws(
    () => extractRuntimeEntries(zipSync({ [main]: strToU8('runtime') }), windows, version),
    /missing.*onnxruntime_providers_shared\.dll/,
  );
  assert.throws(
    () => extractRuntimeEntries(zipSync({ [shared]: strToU8('provider') }), windows, version),
    /missing.*onnxruntime\.dll/,
  );
  assert.throws(
    () => extractRuntimeEntries(zipSync({ [main]: strToU8('runtime') }), macos, version),
    /missing.*libonnxruntime\.dylib/,
  );
  assert.throws(
    () => extractRuntimeEntries(strToU8('not a ZIP'), windows, version),
    /Invalid.*ZIP/,
  );
});

test('downloads, stages and exports the runtime; a second platform reuses the verified archive', async (t) => {
  const options = await fixture(t);
  let requests = 0;
  const fetchImpl = async (url, { signal }) => {
    requests++;
    assert.equal(
      url,
      `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${version}/microsoft.ml.onnxruntime.${version}.nupkg`,
    );
    assert(signal instanceof AbortSignal);
    return new Response(archive);
  };
  const runtime = await fetchRuntime({ ...options, target: windows, fetchImpl });
  assert.equal(runtime, join(options.root, '.cache/ort', version, windows, 'lib/onnxruntime.dll'));
  assert.equal(await readFile(runtime, 'utf8'), 'windows runtime');
  assert.equal(
    await readFile(join(runtime, '..', 'onnxruntime_providers_shared.dll'), 'utf8'),
    'shared provider',
  );
  assert.equal(
    await readFile(options.env.GITHUB_ENV, 'utf8'),
    `BUBBLEFISH_ORT_RUNTIME=${runtime}\n`,
  );
  const macRuntime = await fetchRuntime({ ...options, target: macos, fetchImpl });
  assert.equal(await readFile(macRuntime, 'utf8'), 'macOS runtime');
  assert.equal(requests, 1);
});

test('rejects unsupported targets and unpinned versions before downloading', async (t) => {
  const options = await fixture(t);
  const fetchImpl = async () => assert.fail('Unexpected download');
  await assert.rejects(
    fetchRuntime({ ...options, target: 'x86_64-unknown-linux-gnu', fetchImpl }),
    /Unsupported.*target/,
  );
  await writeFile(
    join(options.root, 'package.json'),
    JSON.stringify({ dependencies: { 'onnxruntime-web': '^1.31.1' } }),
  );
  await assert.rejects(
    fetchRuntime({ ...options, target: macos, fetchImpl }),
    /exact onnxruntime-web version/,
  );
});

test('reports HTTP 404 without retrying or exporting a runtime', async (t) => {
  const options = await fixture(t);
  let requests = 0;
  await assert.rejects(
    fetchRuntime({
      ...options,
      target: macos,
      fetchImpl: async () => {
        requests++;
        return new Response('Not Found', { status: 404 });
      },
    }),
    /HTTP 404/,
  );
  assert.equal(requests, 1);
  await assert.rejects(readFile(options.env.GITHUB_ENV), { code: 'ENOENT' });
});

test('retries network errors and transient HTTP errors before succeeding', async (t) => {
  const options = await fixture(t);
  let requests = 0;
  const pauses = [];
  const runtime = await fetchRuntime({
    ...options,
    target: windows,
    sleep: async (ms) => pauses.push(ms),
    fetchImpl: async () => {
      requests++;
      if (requests === 1) throw new TypeError('fetch failed');
      if (requests === 2) return new Response('', { status: 503 });
      if (requests === 3) return new Response('', { status: 429 });
      return new Response(archive);
    },
  });
  assert.equal(requests, 4);
  assert.deepEqual(pauses, [500, 1000, 2000]);
  assert.equal(await readFile(runtime, 'utf8'), 'windows runtime');
});

test('bounds retries and leaves neither a partial archive nor an environment export', async (t) => {
  const options = await fixture(t);
  let requests = 0;
  await assert.rejects(
    fetchRuntime({
      ...options,
      target: windows,
      fetchImpl: async () => {
        requests++;
        throw new TypeError('offline');
      },
    }),
    /offline/,
  );
  assert.equal(requests, 4);
  assert.deepEqual(await readdir(join(options.root, '.cache/ort', version)), []);
  await assert.rejects(readFile(options.env.GITHUB_ENV), { code: 'ENOENT' });
});

test('retries an interrupted response without reusing a partial download', async (t) => {
  const options = await fixture(t);
  let requests = 0;
  const runtime = await fetchRuntime({
    ...options,
    target: macos,
    fetchImpl: async () => {
      requests++;
      if (requests === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(archive.subarray(0, 100));
              queueMicrotask(() => controller.error(new TypeError('connection reset')));
            },
          }),
        );
      assert.deepEqual(await readdir(join(options.root, '.cache/ort', version)), []);
      return new Response(archive);
    },
  });
  assert.equal(requests, 2);
  assert.equal(await readFile(runtime, 'utf8'), 'macOS runtime');
  assert(
    !(await readdir(join(options.root, '.cache/ort', version))).some((name) =>
      name.endsWith('.partial'),
    ),
  );
});

test('does not cache or export corrupt downloads or packages missing dependencies', async (t) => {
  for (const bytes of [strToU8('broken ZIP'), zipSync({ [main]: strToU8('runtime') })]) {
    const options = await fixture(t);
    let requests = 0;
    await assert.rejects(
      fetchRuntime({
        ...options,
        target: windows,
        fetchImpl: async () => {
          requests++;
          return new Response(bytes);
        },
      }),
      /ZIP|missing/,
    );
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(join(options.root, '.cache/ort', version)), []);
    await assert.rejects(readFile(options.env.GITHUB_ENV), { code: 'ENOENT' });
  }
});

test('discards a corrupt cache and replaces stale extracted DLLs', async (t) => {
  const options = await fixture(t);
  const fetchImpl = async () => new Response(archive);
  const runtime = await fetchRuntime({ ...options, target: windows, fetchImpl });
  await writeFile(join(runtime, '..', 'obsolete.dll'), 'stale');
  await writeFile(
    join(options.root, '.cache/ort', version, `microsoft.ml.onnxruntime.${version}.nupkg`),
    'broken cache',
  );
  await fetchRuntime({ ...options, target: windows, fetchImpl });
  await assert.rejects(readFile(join(runtime, '..', 'obsolete.dll')), { code: 'ENOENT' });
  assert.equal(await readFile(runtime, 'utf8'), 'windows runtime');
});
