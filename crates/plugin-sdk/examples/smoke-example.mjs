// Run after build-example.mjs. Both adapters execute the compiled Rust plugin.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(root, '.cache/plugin-sdk-example');
const wasm = new Uint8Array(await readFile(resolve(output, 'pkg/wasm_echo_bg.wasm')));
const { createPlugin } = await import(pathToFileURL(resolve(output, 'entry.js')).href);
const imageBytes = new Uint8Array([0, 255, 128, 7]);
const image = {
  id: 'image',
  assetId: 'asset',
  filename: 'source.png',
  width: 2,
  height: 3,
  markers: [],
};
const history = { undo: [], redo: [], undoTotal: 0, redoTotal: 0, historyRevision: 7 };

function frame(kind, data, binary) {
  const message = { kind, apiVersion: 1, ...data };
  if (binary?.length) message.binary = { byteLength: binary.length };
  return { message, ...(binary?.length ? { binary } : {}) };
}
function fixtureHost(trace, events, onEvent) {
  return async (request) => {
    const { message, binary } = request;
    if (message.kind === 'event') {
      events.push({ event: message.event, data: message.data });
      onEvent?.(message);
      return;
    }
    trace.push({ method: message.method, params: message.params, binary: [...(binary ?? [])] });
    let result = null;
    let bytes;
    switch (message.method) {
      case 'resources.read':
        bytes = wasm;
        break;
      case 'document.read':
        result = { projectId: 'project', images: [image] };
        break;
      case 'document.images.list':
        result = [image];
        break;
      case 'document.images.read':
        result = { image, mimeType: 'image/png', byteLength: imageBytes.length };
        bytes = imageBytes;
        break;
      case 'document.images.stage':
        assert.deepEqual([...binary], [...imageBytes]);
        result = {
          stagedResource: 'lease',
          assetId: 'new-asset',
          filename: 'source.png',
          width: 2,
          height: 3,
          checksum: 'checksum',
          mimeType: 'image/png',
        };
        break;
      case 'document.transaction':
        assert.equal(message.params.operations.length, 1);
        assert.equal(message.params.operations[0].type, 'image.create');
        assert.equal(message.params.operations[0].stagedResource, 'lease');
        result = { applied: true };
        break;
      case 'history.list':
        result = history;
        break;
      case 'providers.register':
      case 'commands.register':
      case 'events.subscribe':
      case 'hooks.register':
      case 'log':
        break;
      default:
        throw new Error(`Unexpected host call ${message.method}`);
    }
    return frame('response', { id: message.id, result }, bytes);
  };
}
function wire(packet) {
  const json = Buffer.from(JSON.stringify(packet.message));
  const binary = Buffer.from(packet.binary ?? []);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(json.length, 0);
  header.writeUInt32LE(binary.length, 4);
  return Buffer.concat([header, json, binary]);
}
async function nativeAdapter(host) {
  const child = spawn(
    resolve(root, `target/debug/examples/echo${process.platform === 'win32' ? '.exe' : ''}`),
    [],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const jsonLength = buffer.readUInt32LE(0);
      const binaryLength = buffer.readUInt32LE(4);
      const total = 8 + jsonLength + binaryLength;
      if (buffer.length < total) break;
      const packet = { message: JSON.parse(buffer.subarray(8, 8 + jsonLength).toString()) };
      if (binaryLength) packet.binary = new Uint8Array(buffer.subarray(8 + jsonLength, total));
      buffer = buffer.subarray(total);
      if (packet.message.kind === 'response') {
        const waiter = pending.get(packet.message.id);
        pending.delete(packet.message.id);
        if (packet.message.error)
          waiter.reject(
            Object.assign(new Error(packet.message.error.message), packet.message.error),
          );
        else waiter.resolve(packet);
      } else {
        Promise.resolve(host(packet))
          .then((response) => {
            if (response) child.stdin.write(wire(response));
          })
          .catch((error) => {
            for (const waiter of pending.values()) waiter.reject(error);
            child.kill();
          });
      }
    }
  });
  child.on('exit', () => {
    for (const waiter of pending.values())
      waiter.reject(new Error('Native plugin exited before replying'));
  });
  return {
    dispatch(packet) {
      if (packet.message.kind === 'event') {
        child.stdin.write(wire(packet));
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        pending.set(packet.message.id, { resolve, reject });
        child.stdin.write(wire(packet));
      });
    },
    close() {
      child.kill();
    },
  };
}
async function wasmAdapter(host) {
  const plugin = await createPlugin(host);
  const control = plugin.cancellation_handle();
  let tail = Promise.resolve();
  return {
    dispatch(packet) {
      const message = packet.message;
      if (message.kind === 'event' && message.event === '$cancel') {
        control.cancel(message.data.requestId);
        return Promise.resolve();
      }
      if (message.kind === 'request') control.register(message.id);
      const operation = tail
        .catch(() => {})
        .then(async () => {
          const response = await plugin.dispatch(packet, host);
          if (response?.message.error)
            throw Object.assign(new Error(response.message.error.message), response.message.error);
          return response;
        });
      tail = operation;
      return operation.finally(() => {
        if (message.kind === 'request') control.release(message.id);
      });
    },
    close() {
      control.free();
      plugin.free();
    },
  };
}
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === 'subscriptionId' ||
        (key === 'id' && typeof entry === 'string' && entry.startsWith('example.echo-'))
          ? '<generated>'
          : normalized(entry),
      ]),
    );
  return value;
}
async function exercise(adapterFactory, runtimeRole) {
  const trace = [];
  const events = [];
  let adapter;
  let cancelId;
  let queuedId;
  let cancellationSent = false;
  adapter = await adapterFactory(
    fixtureHost(trace, events, (message) => {
      if (
        message.event === 'task.progress' &&
        message.data.taskId === 'cancel-task' &&
        !cancellationSent
      ) {
        cancellationSent = true;
        setTimeout(() => {
          adapter.dispatch(frame('event', { event: '$cancel', data: { requestId: queuedId } }));
          adapter.dispatch(frame('event', { event: '$cancel', data: { requestId: cancelId } }));
        }, 0);
      }
    }),
  );
  trace.length = 0;
  let nextId = 0;
  const call = async (method, params = null, binary) => {
    const response = await adapter.dispatch(
      frame('request', { id: String(++nextId), method, params }, binary),
    );
    assert.equal(response.message.error, undefined);
    return response;
  };
  try {
    const hello = await call('handshake', {
      apiVersion: 1,
      pluginId: 'example.echo',
      hostVersion: '1',
      platform: adapterFactory === nativeAdapter ? 'native' : 'web',
      permissions: [],
      runtimeRole,
    });
    assert(hello.message.result.features.includes('runtime.roles'));
    assert(hello.message.result.features.includes('commands.tasks'));
    await call('activate', { config: {}, runtimeRole });
    if (runtimeRole === 'main') {
      const completed = await call('commands.execute', {
        commandId: 'task-demo',
        taskId: 'success-task',
        params: { steps: 3 },
      });
      assert.deepEqual(completed.message.result, { completed: 3 });
      assert.deepEqual(
        events.filter((event) => event.data.taskId === 'success-task'),
        [
          ...[0, 1, 2].map((completed) => ({
            event: 'task.progress',
            data: {
              taskId: 'success-task',
              progress: { phase: 'working', message: 'Rust command step', completed, total: 3 },
            },
          })),
          {
            event: 'task.summary',
            data: { taskId: 'success-task', message: 'Rust command completed' },
          },
        ],
      );
      cancelId = String(++nextId);
      const cancelled = adapter.dispatch(
        frame('request', {
          id: cancelId,
          method: 'commands.execute',
          params: { commandId: 'task-demo', taskId: 'cancel-task', params: { steps: 200 } },
        }),
      );
      queuedId = String(++nextId);
      const queued = adapter.dispatch(
        frame('request', {
          id: queuedId,
          method: 'commands.execute',
          params: { commandId: 'task-demo', taskId: 'queued-task', params: { steps: 1 } },
        }),
      );
      await Promise.all([
        assert.rejects(cancelled, { code: 'cancelled' }),
        assert.rejects(queued, { code: 'cancelled' }),
      ]);
      assert(cancellationSent);
      assert(
        !events.some(
          (event) => event.event === 'task.summary' && event.data.taskId === 'cancel-task',
        ),
      );
      assert(!events.some((event) => event.data.taskId === 'queued-task'));
      const retry = await call('commands.execute', {
        commandId: 'task-demo',
        taskId: 'retry-task',
        params: { steps: 1 },
      });
      assert.deepEqual(retry.message.result, { completed: 1 });
    }
    if (runtimeRole === 'hooks') {
      assert.deepEqual(
        trace.map((item) => item.method),
        ['hooks.register'],
      );
      const checked = await call('hooks.beforeCommit', {
        hookId: 'normalize-text',
        proposal: {
          projectId: 'project',
          transactionId: 'tx',
          baseStateId: 'state',
          origin: { kind: 'user' },
          operations: [
            {
              type: 'translation.set',
              imageId: 'image',
              markerId: 'marker',
              value: '  hello\r\nworld  ',
            },
          ],
        },
      });
      assert.equal(checked.message.result.action, 'replace');
      assert.equal(checked.message.result.operations[0].value, 'hello\nworld');
    } else {
      await call('commands.execute', { commandId: 'inspect-document', params: null });
      const created = await call('commands.execute', {
        commandId: 'duplicate-image',
        params: null,
      });
      assert.equal(created.message.result.result.applied, true);
      await adapter.dispatch(
        frame('event', { event: 'document.changed', data: { projectId: 'project' } }),
      );
      const echo = await call('echo', { complete: true }, imageBytes);
      assert.deepEqual([...echo.binary], [...imageBytes]);
      assert.equal(trace.filter((item) => item.method === 'history.list').length, 3);
      assert.deepEqual(trace.find((item) => item.method === 'document.images.stage').binary, [
        ...imageBytes,
      ]);
    }
    await call('deactivate');
    return normalized(trace);
  } finally {
    adapter.close();
  }
}

for (const role of ['main', 'hooks']) {
  const nativeTrace = await exercise(nativeAdapter, role);
  const wasmTrace = await exercise(wasmAdapter, role);
  assert.deepEqual(wasmTrace, nativeTrace);
  process.stdout.write(
    `Rust native/WASM ${role} golden trace: ${nativeTrace.length} host calls passed\n`,
  );
}
