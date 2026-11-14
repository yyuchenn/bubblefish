// Exercise a real packaged native executable, with binary host callbacks and no
// dependency on an installed desktop app or the developer's runtime search path.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const target = option(
  '--target',
  execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1],
);
assert(target, 'rustc did not identify its native target');
const packagePath = resolve(
  option('--package', join(root, 'dist/plugins', `kha-white-ocr-plugin-${target}.bfplugin`)),
);
const modelDirectory = resolve(
  option('--models', join(root, 'legacy/plugins/kha-white-ocr-plugin/onnx_model')),
);
const reportPath = resolve(option('--report', join(root, '.cache/kha-native-stdio-release.json')));
const expected = '今日はいい天気ですね。';
const expectedTokens = [2, 2, 1109, 2719, 897, 854, 854, 1847, 3139, 889, 875, 895, 829, 3];
const files = unzipSync(new Uint8Array(await readFile(packagePath)));
const manifest = JSON.parse(new TextDecoder().decode(files['plugin.json']));
const model = JSON.parse(new TextDecoder().decode(files['model-manifest.json']));
const entry = manifest.entrypoints.native?.[target];
assert(entry, `Package has no native executable for ${target}`);
assert.equal(manifest.id, 'kha-white-ocr-plugin');
assert.equal(manifest.version, '0.1.0');
const expectedCommands = ['model-status', 'reset-model', 'self-test'];
assert.deepEqual(
  manifest.contributes.commands.map((command) => command.id).sort(),
  expectedCommands,
);
assert.deepEqual(
  manifest.contributes.panels.map((panel) => panel.id),
  ['models'],
);
const temporary = await mkdtemp(join(tmpdir(), 'bubblefish-kha-installed-'));
const installDirectory = join(temporary, 'plugin');
const unrelatedCwd = join(temporary, 'unrelated-cwd');
await mkdir(unrelatedCwd, { recursive: true });
let child;
let timeout;
let exitPromise;
try {
  for (const [path, bytes] of Object.entries(files)) {
    const destination = resolve(installDirectory, path);
    assert(destination.startsWith(`${installDirectory}${sep}`), `Unsafe package path: ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const executable = join(installDirectory, entry);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ORT_|DYLD_)/.test(key)),
  );
  child = spawn(executable, [], {
    cwd: unrelatedCwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    input = Buffer.alloc(0),
    sequence = 0,
    installed = false;
  let writes = Promise.resolve();
  const pending = new Map(),
    trace = [];
  let observeEvent = () => {};
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const error = new Error(`Native plugin closed (${code ?? signal}): ${stderr}`);
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      resolveExit({ code, signal });
    });
  });
  exitPromise = exited;
  // A spawn failure can precede the first pending RPC settling.
  void exited.catch(() => {});
  child.stderr.on('data', (data) => {
    stderr = `${stderr}${data}`.slice(-16_384);
  });
  const fail = (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    child.kill();
  };
  const write = (bytes) =>
    new Promise((resolveWrite, reject) =>
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolveWrite())),
    );
  const send = (message, binary = new Uint8Array()) => {
    const operation = writes.then(async () => {
      const value = {
        ...message,
        apiVersion: 1,
        ...(binary.byteLength ? { binary: { byteLength: binary.byteLength } } : {}),
      };
      const json = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(8);
      header.writeUInt32LE(json.byteLength, 0);
      header.writeUInt32LE(binary.byteLength, 4);
      await write(header);
      await write(json);
      if (binary.byteLength) await write(binary);
    });
    writes = operation.catch(fail);
    return operation;
  };
  async function receive(message, binary) {
    if (message.kind === 'event') {
      trace.push({ event: message.event, data: message.data });
      observeEvent(message);
      return;
    }
    if (message.kind === 'response') {
      const item = pending.get(message.id);
      assert(item, `Unrelated native response: ${message.id}`);
      pending.delete(message.id);
      if (message.error)
        item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else item.resolve(message.result);
      return;
    }
    assert.equal(message.kind, 'request');
    trace.push({ method: message.method, params: message.params, byteLength: binary.byteLength });
    let result = null,
      bytes = new Uint8Array();
    if (message.method === 'resources.local.list')
      result = installed ? [{ id: model.id, files: model.files, createdAt: 1 }] : [];
    else if (message.method === 'resources.local.read') {
      assert(installed);
      assert.equal(message.params.id, model.id);
      assert(model.files.some((file) => file.path === message.params.path));
      bytes = await readFile(join(modelDirectory, message.params.path));
    } else if (message.method === 'resources.read') {
      assert.equal(message.params.path, 'japanese-smoke.png');
      bytes = files['japanese-smoke.png'];
    } else
      assert(
        ['providers.register', 'commands.register', 'log'].includes(message.method),
        `Unexpected native host call ${message.method}`,
      );
    await send({ kind: 'response', id: message.id, result }, bytes);
  }
  child.stdout.on('data', (data) => {
    input = Buffer.concat([input, data]);
    try {
      while (input.byteLength >= 8) {
        const jsonLength = input.readUInt32LE(0),
          binaryLength = input.readUInt32LE(4),
          size = 8 + jsonLength + binaryLength;
        assert(
          jsonLength > 0 && jsonLength <= 8 * 1024 * 1024 && binaryLength <= 512 * 1024 * 1024,
          'Invalid native frame',
        );
        if (input.byteLength < size) break;
        const message = JSON.parse(input.subarray(8, 8 + jsonLength).toString());
        const binary = input.subarray(8 + jsonLength, size);
        input = input.subarray(size);
        void receive(message, binary).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });
  const startRequest = (method, params = null, binary) => {
    const id = `smoke:${++sequence}`;
    const response = new Promise((resolveResponse, reject) =>
      pending.set(id, { resolve: resolveResponse, reject }),
    );
    void send({ kind: 'request', id, method, params }, binary).catch(fail);
    return { id, response };
  };
  const request = (method, params = null, binary) => startRequest(method, params, binary).response;
  timeout = setTimeout(() => fail(new Error('Native OCR smoke exceeded 120 seconds')), 120_000);
  const handshake = await request('handshake', {
    apiVersion: 1,
    pluginId: manifest.id,
    hostVersion: appVersion,
    platform: 'native',
    permissions: manifest.permissions,
  });
  assert.equal(handshake.apiVersion, 1);
  assert.equal(handshake.pluginId, manifest.id);
  assert(handshake.features.includes('commands.tasks'));
  await request('activate');
  assert(
    !trace.some((item) => item.method?.startsWith('resources.')),
    'Activation must not load models',
  );
  assert.equal(trace.filter((item) => item.method === 'providers.register').length, 1);
  assert.deepEqual(
    trace
      .filter((item) => item.method === 'commands.register')
      .map((item) => item.params.info.id)
      .sort(),
    expectedCommands,
  );
  const commands = (commandId, taskId = `command:${sequence + 1}`) =>
    request('commands.execute', { commandId, taskId });
  assert.equal((await commands('model-status')).modelInstalled, false);
  await assert.rejects(
    request(
      'ocr.recognize',
      { providerId: 'kha-white-ocr', taskId: 'missing' },
      files['japanese-smoke.png'],
    ),
    { code: 'modelMissing' },
  );
  installed = true;
  assert.deepEqual(await commands('model-status'), {
    backend: 'native',
    ready: false,
    modelInstalled: true,
    modelId: model.id,
    busy: false,
    runtimeVersion: '1.22.0',
  });
  const started = performance.now();
  const first = await commands('self-test', 'self-test:cold');
  assert.equal(first.text, expected);
  assert.equal(first.passed, true);
  assert.deepEqual(first.tokenIds, expectedTokens);
  assert(
    trace.some(
      (event) =>
        event.event === 'task.summary' &&
        event.data.taskId === 'self-test:cold' &&
        event.data.message.includes('自检通过'),
    ),
    'Self-test should report an explicit success summary',
  );
  const coldMs = performance.now() - started;
  const countReads = () => trace.filter((item) => item.method === 'resources.local.read').length;
  assert.equal(countReads(), 4);
  const warm = await commands('self-test');
  assert.equal(warm.text, expected);
  assert.deepEqual(warm.tokenIds, expectedTokens);
  assert.equal(countReads(), 4, 'Warm recognition must reuse sessions');
  const decodingProgress = trace.filter(
    (event) => event.event === 'task.progress' && event.data.progress.phase === 'decoding',
  );
  assert(decodingProgress.length > 0, 'Real self-tests must report decoding progress');
  assert(
    decodingProgress.every((event) => !Object.hasOwn(event.data.progress, 'total')),
    'The decoding token limit is not a known completion total',
  );
  // Cancel through the real stdio control path while synchronous decoder runs
  // are active; the plugin must stop at a checkpoint and remain usable.
  const cancelledTaskId = 'self-test:cancelled';
  let cancelSent = false;
  let cancelRequestId;
  observeEvent = (message) => {
    if (
      !cancelSent &&
      message.event === 'task.progress' &&
      message.data.taskId === cancelledTaskId &&
      message.data.progress.phase === 'decoding'
    ) {
      cancelSent = true;
      void send({
        kind: 'event',
        event: '$cancel',
        data: { requestId: cancelRequestId },
      }).catch(fail);
    }
  };
  const cancelled = startRequest('commands.execute', {
    commandId: 'self-test',
    taskId: cancelledTaskId,
  });
  cancelRequestId = cancelled.id;
  await assert.rejects(cancelled.response, { code: 'cancelled' });
  observeEvent = () => {};
  assert(cancelSent, 'Cancellation must be sent after real decoder progress');
  assert(
    !trace.some((event) => event.event === 'task.summary' && event.data.taskId === cancelledTaskId),
    'A cancelled command must not report success',
  );
  assert.equal((await commands('model-status')).ready, true);
  const retried = await commands('self-test', 'self-test:retry');
  assert.equal(retried.passed, true);
  assert.equal(retried.text, expected);
  assert.deepEqual(retried.tokenIds, expectedTokens);
  assert.equal(countReads(), 4, 'Cancelled inference must keep the valid sessions reusable');
  const ocr = await request(
    'ocr.recognize',
    {
      providerId: 'kha-white-ocr',
      taskId: 'actual-ocr',
      input: { mimeType: 'image/png', sourceLanguage: 'japanese' },
    },
    files['japanese-smoke.png'],
  );
  assert.equal(ocr.text, expected);
  assert.deepEqual(ocr.tokenIds, expectedTokens);
  await commands('reset-model');
  assert.equal((await commands('model-status')).ready, false);
  assert.equal((await commands('self-test')).text, expected);
  assert.equal(countReads(), 8);
  await request('deactivate');
  await writes;
  child.stdin.end();
  const exit = await exited;
  assert.equal(exit.code, 0, stderr);
  assert.equal(exit.signal, null);
  assert.equal(input.length, 0);
  const report = {
    passed: true,
    target,
    package: packagePath,
    text: ocr.text,
    tokenIds: ocr.tokenIds,
    coldMs: Math.round(coldMs),
    warmTimings: warm.timings,
    modelReadsAcrossTwoSelfTests: 4,
    modelReadsAfterReset: 8,
    activationIsLazy: true,
    missingModelRejected: true,
    commandProgress: true,
    commandSummary: true,
    commandCancellationDuringDecoding: cancelSent,
    sameProcessRetryAfterCancellation: true,
    detachedPackage: true,
    withoutOrtEnvironment: true,
    unrelatedCwd: true,
    exitCode: exit.code,
    stderr,
    handshake,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(timeout);
  if (child?.exitCode === null && child?.signalCode === null) child.kill();
  await exitPromise?.catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
