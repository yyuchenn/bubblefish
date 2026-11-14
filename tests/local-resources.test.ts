import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ValidatedLocalResourceStorage,
  validateLocalResourceImport,
  LOCAL_RESOURCE_CHUNK_BYTES,
  type LocalResourcePersistence,
  type PendingLocalResource,
} from '../src/runtime/plugins/local-resources';
import type { PluginLocalResourceSet } from '../src/generated/plugins';
import type { PluginManifest } from '../src/generated/plugins';
import { PluginManager } from '../src/runtime/plugins/manager';
import { createPluginContext, connectPanel, type PluginContext } from '../src/plugin-sdk';
import { RpcPeer } from '../src/runtime/plugins/rpc';
import type { BackendFactory } from '../src/runtime/plugins/backend';
import type { PluginStorage } from '../src/runtime/plugins/types';

const data = (text: string) => new TextEncoder().encode(text).buffer;
const digest = (bytes: ArrayBuffer) =>
  createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const descriptor = (id = 'model', bytes = data('correct model')) => ({
  id,
  files: [{ path: 'model.onnx', byteLength: bytes.byteLength, sha256: digest(bytes) }],
});
export class MemoryLocalResources implements LocalResourcePersistence {
  pending = new Map<string, PendingLocalResource>();
  chunks = new Map<string, Map<string, ArrayBuffer[]>>();
  ready = new Map<string, { token: string; set: PluginLocalResourceSet }>();
  failWrites = false;
  beforeBegin?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  async begin(value: PendingLocalResource) {
    await this.beforeBegin?.();
    this.pending.set(value.token, value);
    this.chunks.set(value.token, new Map());
  }
  async write(token: string, path: string, _offset: number, bytes: ArrayBuffer) {
    if (this.failWrites) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    const files = this.chunks.get(token)!,
      chunks = files.get(path) ?? [];
    chunks.push(bytes.slice(0));
    files.set(path, chunks);
  }
  async commit(value: PendingLocalResource, alive: () => boolean) {
    await this.beforeCommit?.();
    if (!alive()) throw new Error('Commit cancelled');
    const key = `${value.pluginId}/${value.set.id}`,
      previous = this.ready.get(key);
    this.ready.set(key, { token: value.token, set: structuredClone(value.set) });
    this.pending.delete(value.token);
    if (previous) this.chunks.delete(previous.token);
  }
  async abort(token: string) {
    this.pending.delete(token);
    this.chunks.delete(token);
  }
  async list(pluginId: string) {
    return [...this.ready]
      .filter(([key]) => key.startsWith(`${pluginId}/`))
      .map(([, value]) => value.set);
  }
  async read(pluginId: string, id: string, path: string) {
    const ready = this.ready.get(`${pluginId}/${id}`),
      chunks = ready && this.chunks.get(ready.token)?.get(path);
    if (!chunks) throw new Error('Resource not found');
    return new Blob(chunks).arrayBuffer();
  }
  async remove(pluginId: string, id: string) {
    const key = `${pluginId}/${id}`,
      previous = this.ready.get(key);
    if (previous) this.chunks.delete(previous.token);
    this.ready.delete(key);
  }
  async removePlugin(pluginId: string) {
    for (const set of await this.list(pluginId)) await this.remove(pluginId, set.id);
  }
  async cleanupExpired() {}
}
function setup() {
  const persistence = new MemoryLocalResources(),
    store = new ValidatedLocalResourceStorage(persistence);
  return { persistence, store };
}
async function upload(
  store: ValidatedLocalResourceStorage,
  owner = 'instance',
  id = 'model',
  bytes = data('correct model'),
) {
  const { token } = await store.beginImport('plugin', owner, descriptor(id, bytes));
  const middle = Math.floor(bytes.byteLength / 2);
  await store.writeChunk('plugin', owner, token, 'model.onnx', 0, bytes.slice(0, middle));
  await store.writeChunk('plugin', owner, token, 'model.onnx', middle, bytes.slice(middle));
  return store.commitImport('plugin', owner, token);
}
describe('validated local resource imports', () => {
  it('hashes independent chunks and atomically replaces the catalog only after full validation', async () => {
    const { store, persistence } = setup();
    await upload(store);
    const replacement = data('replacement model'),
      { token } = await store.beginImport('plugin', 'instance', descriptor('model', replacement));
    await store.writeChunk('plugin', 'instance', token, 'model.onnx', 0, replacement);
    expect(await store.read('plugin', 'model', 'model.onnx')).toEqual(data('correct model'));
    await store.commitImport('plugin', 'instance', token);
    expect(await store.read('plugin', 'model', 'model.onnx')).toEqual(replacement);
    expect(persistence.pending.size).toBe(0);
    expect(persistence.chunks.size).toBe(1);
  });
  it('keeps the previous model and removes every staged chunk on a SHA mismatch or quota failure', async () => {
    const { store, persistence } = setup();
    await upload(store);
    const { token } = await store.beginImport('plugin', 'instance', descriptor());
    await store.writeChunk('plugin', 'instance', token, 'model.onnx', 0, data('invalid model'));
    await expect(store.commitImport('plugin', 'instance', token)).rejects.toThrow('SHA-256');
    expect(await store.read('plugin', 'model', 'model.onnx')).toEqual(data('correct model'));
    const next = await store.beginImport('plugin', 'instance', descriptor());
    persistence.failWrites = true;
    await expect(
      store.writeChunk('plugin', 'instance', next.token, 'model.onnx', 0, data('correct model')),
    ).rejects.toThrow('quota');
    expect(persistence.pending.size).toBe(0);
    expect(persistence.chunks.size).toBe(1);
  });
  it('binds upload tokens to both plugin identity and connection without destroying someone else’s import', async () => {
    const { store, persistence } = setup();
    const { token } = await store.beginImport('plugin', 'panel-one', descriptor());
    expect(() =>
      store.writeChunk('other-plugin', 'panel-one', token, 'model.onnx', 0, data('correct model')),
    ).toThrow('connection');
    expect(() =>
      store.writeChunk('plugin', 'panel-two', token, 'model.onnx', 0, data('correct model')),
    ).toThrow('connection');
    expect(persistence.pending.size).toBe(1);
    await store.releaseOwner('plugin', 'panel-two');
    expect(persistence.pending.size).toBe(1);
    await store.releaseOwner('plugin', 'panel-one');
    expect(persistence.pending.size).toBe(0);
    await expect(store.beginImport('plugin', 'panel-one', descriptor())).rejects.toThrow('closed');
  });
  it('cancels imports still awaiting persistence and cannot publish them after the connection closes', async () => {
    const { store, persistence } = setup();
    let finish!: () => void;
    persistence.beforeBegin = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const importing = store.beginImport('plugin', 'panel', descriptor());
    const rejection = expect(importing).rejects.toThrow('closed');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const closing = store.releaseOwner('plugin', 'panel');
    finish();
    await Promise.all([rejection, closing]);
    expect(persistence.chunks.size).toBe(0);
    expect(await store.list('plugin')).toEqual([]);
  });
  it('does not publish a catalog commit whose owner closes while persistence is still preparing', async () => {
    const { store, persistence } = setup();
    await upload(store);
    const next = data('replacement model'),
      { token } = await store.beginImport('plugin', 'panel', descriptor('model', next));
    await store.writeChunk('plugin', 'panel', token, 'model.onnx', 0, next);
    let finish!: () => void;
    persistence.beforeCommit = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const committing = store.commitImport('plugin', 'panel', token);
    const rejected = expect(committing).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const closing = store.releaseOwner('plugin', 'panel');
    finish();
    await Promise.all([rejected, closing]);
    expect(await store.read('plugin', 'model', 'model.onnx')).toEqual(data('correct model'));
    expect(persistence.pending.size).toBe(0);
  });
  it('rejects incomplete and out-of-order files and cleans them without publishing', async () => {
    const { store, persistence } = setup();
    const first = await store.beginImport('plugin', 'panel', descriptor());
    await expect(store.commitImport('plugin', 'panel', first.token)).rejects.toThrow('Incomplete');
    const second = await store.beginImport('plugin', 'panel', descriptor());
    await expect(
      store.writeChunk('plugin', 'panel', second.token, 'model.onnx', 1, data('x')),
    ).rejects.toThrow('sequential');
    expect(persistence.pending.size).toBe(0);
    expect(await store.list('plugin')).toEqual([]);
  });
  it('removes ready and pending resources on uninstall, while ordinary instance release preserves ready sets', async () => {
    const { store, persistence } = setup();
    await upload(store);
    await store.releaseOwner('plugin', 'instance');
    expect(await store.list('plugin')).toHaveLength(1);
    await store.beginImport('plugin', 'new-instance', descriptor('next'));
    await store.removePlugin('plugin');
    expect(persistence.chunks.size).toBe(0);
    expect(await store.list('plugin')).toEqual([]);
  });
  it('enforces bounded binary chunks, path and size limits before catalog changes', async () => {
    expect(() => validateLocalResourceImport({ ...descriptor(), id: '../escape' })).toThrow();
    expect(() => validateLocalResourceImport({ ...descriptor(), id: 'MODEL' })).toThrow();
    expect(() => validateLocalResourceImport({ ...descriptor(), id: 'con' })).toThrow();
    expect(() => validateLocalResourceImport({ ...descriptor(), id: 'model.' })).toThrow();
    expect(() =>
      validateLocalResourceImport({
        id: 'model',
        files: [
          { ...descriptor().files[0], path: 'model.onnx' },
          { ...descriptor().files[0], path: 'MODEL.onnx' },
        ],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      validateLocalResourceImport({
        id: 'model',
        files: [
          { ...descriptor().files[0], path: 'file' },
          { ...descriptor().files[0], path: 'file/child' },
        ],
      }),
    ).toThrow('parents');
    expect(() =>
      validateLocalResourceImport({
        id: 'model',
        files: [{ ...descriptor().files[0], path: 'NUL.txt' }],
      }),
    ).toThrow('portable');
    expect(() =>
      validateLocalResourceImport({
        id: 'model',
        files: [{ ...descriptor().files[0], path: '../model' }],
      }),
    ).toThrow();
    expect(() =>
      validateLocalResourceImport({
        id: 'model',
        files: [{ ...descriptor().files[0], byteLength: 513 * 1024 * 1024 }],
      }),
    ).toThrow();
    const { store } = setup(),
      bytes = new ArrayBuffer(LOCAL_RESOURCE_CHUNK_BYTES + 1);
    const { token } = await store.beginImport('plugin', 'instance', descriptor('model', bytes));
    await expect(
      store.writeChunk('plugin', 'instance', token, 'model.onnx', 0, bytes),
    ).rejects.toThrow('chunk size');
  });
});

async function bridge(permissions = ['resources.local.read', 'resources.local.write']) {
  const contexts = new Map<string, PluginContext>(),
    { store, persistence } = setup();
  const manifest: PluginManifest = {
    id: 'test.local',
    name: 'Local resources',
    version: '1',
    apiVersion: 1,
    entrypoints: { web: 'web.js' },
    permissions,
    contributes: {
      commands: [{ id: 'run', title: 'Run' }],
      ...(permissions.includes('document.intercept')
        ? { beforeCommitHooks: [{ id: 'guard' }] }
        : {}),
    },
  };
  let installed = { manifest, config: {}, enabled: false };
  const storage: PluginStorage = {
    async list() {
      return [installed];
    },
    async install(pkg) {
      return (installed = { ...installed, manifest: pkg.manifest });
    },
    async remove() {},
    async read() {
      return new ArrayBuffer(0);
    },
    async update(_id, patch) {
      installed = { ...installed, ...patch };
    },
  };
  const factory: BackendFactory = async (
    plugin,
    _generation,
    _kind,
    receive,
    fail,
    _signal,
    role = 'main',
  ) => {
    let sdk: ReturnType<typeof createPluginContext>;
    const peer = new RpcPeer(
      (packet) => queueMicrotask(() => receive(structuredClone(packet))),
      async (method, params, binary, id) => {
        if (method === 'handshake')
          return {
            result: { apiVersion: 1, pluginId: plugin.manifest.id, features: ['resources.local'] },
          };
        if (method === 'activate') {
          sdk = createPluginContext(peer, plugin.manifest, role);
          contexts.set(role, sdk.context);
          if (role === 'main') sdk.context.commands.register('run', () => null);
          else sdk.context.hooks.beforeCommit.register('guard', () => ({ action: 'continue' }));
          await sdk.ready();
          return { result: null };
        }
        if (method === 'deactivate') {
          await sdk.dispose();
          return { result: null };
        }
        return sdk.invoke(method, params, binary, id);
      },
      (event, value) => sdk?.event(event, value),
    );
    return {
      send(packet) {
        queueMicrotask(() => {
          void peer.receive(structuredClone(packet)).catch(fail);
        });
      },
      async terminate() {
        peer.close();
      },
    };
  };
  const manager = new PluginManager(
    {
      async readDocument() {
        return null;
      },
      async applyDocument() {
        return null;
      },
    },
    { storage, backendFactory: factory, localResources: store, desktop: false },
  );
  await manager.initialize();
  await manager.enable(manifest.id);
  await manager.executeCommand(`${manifest.id}/run`);
  return { manager, contexts, store, persistence };
}
describe('local resource SDK connection boundary', () => {
  it('round-trips actual binary chunks through the SDK and preserves imported resources across disable', async () => {
    const { manager, contexts, persistence } = await bridge();
    try {
      const api = contexts.get('main')!.resources.local,
        bytes = data('correct model');
      const { token } = await api.beginImport(descriptor());
      await api.writeChunk({ token, path: 'model.onnx', offset: 0 }, bytes);
      const imported = await api.commitImport({ token });
      expect(imported.id).toBe('model');
      expect(await api.read({ id: 'model', path: 'model.onnx' })).toEqual(bytes);
      await manager.disable('test.local');
      expect(persistence.ready.size).toBe(1);
    } finally {
      await manager.dispose();
    }
  });
  it('denies undeclared access and every local resource method from hook runtimes', async () => {
    const denied = await bridge([]);
    try {
      await expect(denied.contexts.get('main')!.resources.local.list()).rejects.toThrow(
        'resources.local.read',
      );
    } finally {
      await denied.manager.dispose();
    }
    const allowed = await bridge([
      'resources.local.read',
      'resources.local.write',
      'document.intercept',
    ]);
    try {
      await expect(allowed.contexts.get('hooks')!.resources.local.list()).rejects.toThrow(
        'Hook runtimes',
      );
    } finally {
      await allowed.manager.dispose();
    }
  });
  it('binds imports to each panel connection and closes only that panel’s temporary imports', async () => {
    const { manager, contexts, persistence } = await bridge();
    const channel = new MessageChannel(),
      disconnect = manager.connectPanel('test.local', channel.port1),
      panel = connectPanel(channel.port2);
    try {
      const main = contexts.get('main')!.resources.local,
        own = await main.beginImport(descriptor('main-model'));
      const temporary = await panel.resources.local.beginImport(descriptor('panel-model'));
      await expect(
        main.writeChunk(
          { token: temporary.token, path: 'model.onnx', offset: 0 },
          data('correct model'),
        ),
      ).rejects.toThrow('connection');
      panel.dispose();
      await vi.waitFor(() => expect(persistence.pending.has(temporary.token)).toBe(false));
      expect(persistence.pending.has(own.token)).toBe(true);
      await main.writeChunk(
        { token: own.token, path: 'model.onnx', offset: 0 },
        data('correct model'),
      );
      await main.commitImport({ token: own.token });
      expect(await main.list()).toHaveLength(1);
    } finally {
      disconnect();
      panel.dispose();
      await manager.dispose();
    }
  });
});
