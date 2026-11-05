import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { PluginManager } from '../src/runtime/plugins';
import { readPluginPackage, validateManifest } from '../src/runtime/plugins/package';
import { RpcPeer, decodeFrame, encodeFrame, type Packet } from '../src/runtime/plugins/rpc';
import { createPluginContext, type PluginContext } from '../src/plugin-sdk';
import type { BackendFactory } from '../src/runtime/plugins/backend';
import type {
  PluginFiles,
  PluginManifest,
  PluginStorage,
  InstalledPlugin,
  JsonValue,
} from '../src/runtime/plugins/types';

const manifest = (patch: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'test.plugin',
  name: 'Test plugin',
  version: '1.0.0',
  apiVersion: 1,
  entrypoints: { web: 'index.js' },
  contributes: {
    ocr: [{ id: 'ocr', name: 'OCR' }],
    translation: [{ id: 'translate', name: 'Translate' }],
    commands: [{ id: 'command', title: 'Command' }],
    configuration: [{ key: 'prefix', label: 'Prefix', type: 'string', default: 'hello' }],
  },
  ...patch,
});
class MemoryStorage implements PluginStorage {
  plugins: InstalledPlugin[];
  constructor(value = manifest()) {
    this.plugins = [{ manifest: value, enabled: false, config: { prefix: 'hello' } }];
  }
  async list() {
    return structuredClone(this.plugins);
  }
  async install(pkg: PluginFiles) {
    const installed = { manifest: pkg.manifest, enabled: false, config: {} };
    this.plugins.push(installed);
    return installed;
  }
  async remove(id: string) {
    this.plugins = this.plugins.filter((entry) => entry.manifest.id !== id);
  }
  async read(_id: string, path: string) {
    if (path !== 'index.js') throw new Error('Missing resource');
    return strToU8('export function activate() {}').buffer as ArrayBuffer;
  }
  async update(id: string, patch: { enabled?: boolean; config?: Record<string, JsonValue> }) {
    Object.assign(
      this.plugins.find((entry) => entry.manifest.id === id)!,
      structuredClone(patch),
    );
  }
}
function factory(
  activate: (ctx: PluginContext) => void | Promise<void>,
  observations: { kinds?: string[]; terminated?: number } = {},
): BackendFactory {
  return async (plugin, _generation, kind, receive, fail) => {
    observations.kinds?.push(kind);
    let sdk: ReturnType<typeof createPluginContext>;
    const peer = new RpcPeer(
      (packet) => queueMicrotask(() => receive(structuredClone(packet))),
      async (method, params, binary, id) => {
        if (method === 'handshake')
          return { result: { apiVersion: 1, pluginId: plugin.manifest.id, features: [] } };
        if (method === 'activate') {
          sdk = createPluginContext(peer, plugin.manifest);
          await activate(sdk.context);
          await sdk.ready();
          return { result: null };
        }
        if (method === 'deactivate') {
          await sdk.dispose();
          return { result: null };
        }
        return sdk.invoke(method, params, binary, id);
      },
      (event, data) => sdk?.event(event, data),
    );
    return {
      send(packet) {
        queueMicrotask(() => {
          void peer.receive(structuredClone(packet)).catch(fail);
        });
      },
      async terminate() {
        observations.terminated = (observations.terminated ?? 0) + 1;
        peer.close();
      },
    };
  };
}
const host = {
  async readDocument() {
    return { id: 'project' };
  },
  async applyDocument() {
    return null;
  },
};

describe('plugin packages', () => {
  it('accepts legacy, modal and bottom panels and rejects invalid locations', () => {
    const panel = { id: 'settings', title: 'Settings', entry: 'panel.html' };
    for (const location of [undefined, 'modal', 'bottom']) {
      const value = { ...panel, ...(location ? { location } : {}) };
      expect(validateManifest({ ...manifest(), contributes: { panels: [value] } })).toMatchObject({
        contributes: { panels: [value] },
      });
    }
    for (const location of ['sidebar', '', null, ['bottom'], 1])
      expect(() =>
        validateManifest({ ...manifest(), contributes: { panels: [{ ...panel, location }] } }),
      ).toThrow('Invalid plugin panel location');
  });
  it('loads a standalone bundle and rejects incompatible or missing entrypoints', async () => {
    const pack = (value: unknown, files: Record<string, Uint8Array> = {}) =>
      new Blob([
        new Uint8Array(zipSync({ 'plugin.json': strToU8(JSON.stringify(value)), ...files })),
      ]);
    const pkg = await readPluginPackage(
      pack(manifest(), { 'index.js': strToU8('export function activate(){}') }),
    );
    expect(pkg.manifest.id).toBe('test.plugin');
    await expect(
      readPluginPackage(pack(manifest({ apiVersion: 2 }), { 'index.js': new Uint8Array() })),
    ).rejects.toThrow('API version');
    await expect(readPluginPackage(pack(manifest()))).rejects.toThrow('Missing plugin resource');
  });
  it('rejects traversal paths before they reach persistent storage', async () => {
    const archive = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest())),
      'index.js': strToU8(''),
      '../escape': strToU8('outside'),
    });
    await expect(readPluginPackage(new Blob([new Uint8Array(archive)]))).rejects.toThrow(
      'Invalid plugin resource path',
    );
  });
});

describe('plugin RPC', () => {
  it('roundtrips binary frames and refuses inconsistent binary attachments', async () => {
    const packet: Packet = {
      message: {
        kind: 'event',
        apiVersion: 1,
        event: 'image',
        data: null,
        binary: { byteLength: 3 },
      },
      binary: new Uint8Array([1, 2, 255]).buffer,
    };
    expect(decodeFrame(encodeFrame(packet))).toEqual(packet);
    expect(() => decodeFrame(encodeFrame(packet).slice(0, -1))).toThrow('frame size');
    const peer = new RpcPeer(
      () => {},
      async () => ({ result: null }),
    );
    const request = peer.request('wait');
    await expect(
      peer.receive({
        message: {
          kind: 'event',
          apiVersion: 1,
          event: 'bad',
          data: null,
          binary: { byteLength: 4 },
        },
      }),
    ).rejects.toThrow('binary length');
    await expect(request).rejects.toThrow('binary length');
  });
  it('cancels pending requests immediately and discards a late response', async () => {
    const packets: Packet[] = [];
    const peer = new RpcPeer(
      (packet) => packets.push(packet),
      async () => ({ result: null }),
    );
    const controller = new AbortController();
    const request = peer.request('slow', null, { signal: controller.signal, timeout: 0 });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(packets[1].message).toMatchObject({ kind: 'event', event: '$cancel' });
    const first = packets[0].message;
    if (first.kind !== 'request') throw new Error('Expected request');
    await peer.receive({
      message: { kind: 'response', apiVersion: 1, id: first.id, result: 'late' },
    });
    peer.close();
  });
});

describe('plugin manager and SDK', () => {
  it('reveals every bottom open request without activating or creating a modal', async () => {
    const opened = vi.fn();
    const activated = vi.fn();
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(
        manifest({
          contributes: {
            panels: [{ id: 'tools', title: 'Tools', entry: 'panel.html', location: 'bottom' }],
          },
        }),
      ),
      backendFactory: factory(activated),
      onBottomPanelOpen: opened,
    });
    await manager.initialize();
    await expect(manager.openPanel('test.plugin', 'tools')).rejects.toThrow('not available');
    await manager.enable('test.plugin');
    await manager.openPanel('test.plugin', 'tools');
    await manager.openPanel('test.plugin', 'tools');
    expect(opened.mock.calls).toEqual([
      [{ pluginId: 'test.plugin', panelId: 'tools' }],
      [{ pluginId: 'test.plugin', panelId: 'tools' }],
    ]);
    expect(activated).not.toHaveBeenCalled();
    expect(manager.value.activePanel).toBeNull();
    await expect(manager.openPanel('test.plugin', 'missing')).rejects.toThrow('not available');
    await manager.disable('test.plugin');
    await expect(manager.preparePanel('test.plugin', 'tools')).rejects.toThrow('not available');
    await manager.dispose();
  });

  it('allows activation to open its bottom tab and explicitly retries a failed enabled panel', async () => {
    let fail = true;
    const opened = vi.fn();
    const activated = vi.fn(async (ctx: PluginContext) => {
      await ctx.panels.open('tools');
      if (fail) throw new Error('Panel runtime failed');
    });
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(
        manifest({
          contributes: {
            panels: [{ id: 'tools', title: 'Tools', entry: 'panel.html', location: 'bottom' }],
          },
        }),
      ),
      backendFactory: factory(activated),
      onBottomPanelOpen: opened,
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.preparePanel('test.plugin', 'tools')).rejects.toThrow(
      'Panel runtime failed',
    );
    expect(manager.value.plugins[0]).toMatchObject({ enabled: true, state: 'failed' });
    expect(manager.value.panels).toHaveLength(1);
    expect(opened).toHaveBeenCalledTimes(1);
    await manager.openPanel('test.plugin', 'tools');
    expect(activated).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(2);
    fail = false;
    await manager.preparePanel('test.plugin', 'tools');
    expect(manager.value.plugins[0].state).toBe('active');
    expect(opened).toHaveBeenCalledTimes(3);
    expect(manager.value.activePanel).toBeNull();
    await manager.remove('test.plugin');
    expect(manager.value.panels).toHaveLength(0);
    await manager.dispose();
  });

  it('keeps omitted and explicit modal locations on the existing activated dialog path', async () => {
    const opened = vi.fn();
    const activated = vi.fn();
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(
        manifest({
          contributes: {
            panels: [
              { id: 'legacy', title: 'Legacy', entry: 'panel.html' },
              { id: 'settings', title: 'Settings', entry: 'panel.html', location: 'modal' },
            ],
          },
        }),
      ),
      backendFactory: factory(activated),
      onBottomPanelOpen: opened,
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    for (const panelId of ['legacy', 'settings']) {
      await manager.openPanel('test.plugin', panelId);
      expect(manager.value.activePanel).toEqual({ pluginId: 'test.plugin', panelId });
      manager.closePanel();
    }
    expect(activated).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    await manager.disable('test.plugin');
    expect(manager.value.activePanel).toBeNull();
    expect(manager.value.panels).toHaveLength(0);
    await manager.dispose();
  });

  it('keeps deactivating visible until the disabled preference is durably acknowledged', async () => {
    const storage = new MemoryStorage();
    const manager = new PluginManager(host, { storage, backendFactory: factory(() => {}) });
    await manager.initialize();
    await manager.enable('test.plugin');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const update = storage.update.bind(storage);
    storage.update = async (id, patch) => {
      if (patch.enabled === false) {
        started();
        await gate;
      }
      await update(id, patch);
    };
    const stopping = manager.disable('test.plugin');
    await writeStarted;
    expect(manager.value.plugins[0].state).toBe('deactivating');
    expect(storage.plugins[0].enabled).toBe(true);
    release();
    await stopping;
    expect(storage.plugins[0].enabled).toBe(false);
    expect(manager.value.plugins[0].state).toBe('inactive');
    await manager.dispose();
  });

  it('interrupts activation on disable and ignores its late completion after reactivation', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const observed = { terminated: 0 };
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(),
      backendFactory: factory(async (ctx) => {
        ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => ({ text: 'current' }));
        if (first) {
          first = false;
          entered();
          await gate;
        }
      }, observed),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    const pending = manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    await manager.disable('test.plugin');
    await rejected;
    expect(manager.value.plugins[0].state).toBe('inactive');
    expect(observed.terminated).toBe(1);
    await manager.enable('test.plugin');
    await expect(manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1))).resolves.toEqual({
      text: 'current',
    });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.value.plugins[0].state).toBe('active');
    expect(manager.value.plugins[0].error).toBeUndefined();
    await manager.dispose();
  });

  it('terminates a backend that does not acknowledge deactivation after five seconds', async () => {
    const observed = { terminated: 0 };
    const base = factory((ctx) => {
      ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => 'ok');
    }, observed);
    const hanging: BackendFactory = async (...args) => {
      const backend = await base(...args);
      return {
        ...backend,
        send(packet) {
          if (packet.message.kind === 'request' && packet.message.method === 'deactivate') return;
          backend.send(packet);
        },
      };
    };
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(),
      backendFactory: hanging,
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    await manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1));
    vi.useFakeTimers();
    try {
      const stopping = manager.disable('test.plugin');
      await vi.advanceTimersByTimeAsync(4999);
      expect(observed.terminated).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(observed.terminated).toBe(1);
      expect(manager.value.plugins[0].state).toBe('inactive');
    } finally {
      vi.useRealTimers();
      await manager.dispose();
    }
  });

  it('cancels one caller during shared activation without cancelling another caller', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const observed = { kinds: [] as string[] };
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(),
      backendFactory: factory(async (ctx) => {
        ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => ({ text: 'ready' }));
        await gate;
      }, observed),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(
      manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1), {
        signal: alreadyCancelled.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.kinds).toEqual([]);
    const controller = new AbortController();
    const first = manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1), {
      signal: controller.signal,
    });
    const second = manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    finish();
    await expect(second).resolves.toEqual({ text: 'ready' });
    expect(observed.kinds).toEqual(['web']);
    await manager.dispose();
  });

  it('serializes OCR across providers belonging to the same plugin', async () => {
    const value = manifest();
    value.contributes.ocr!.push({ id: 'other', name: 'Other OCR' });
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let running = 0;
    let maximum = 0;
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(value),
      backendFactory: factory((ctx) => {
        ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => {
          running++;
          maximum = Math.max(maximum, running);
          started();
          await gate;
          running--;
          return { text: 'one' };
        });
        ctx.ocr.register({ id: 'other', name: 'Other OCR' }, async () => {
          running++;
          maximum = Math.max(maximum, running);
          running--;
          return { text: 'two' };
        });
      }),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    const first = manager.runOcr('test.plugin/ocr', {}, new ArrayBuffer(1));
    await firstStarted;
    const second = manager.runOcr('test.plugin/other', {}, new ArrayBuffer(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(1);
    finish();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    await manager.dispose();
  });

  it('activates event-only plugins lazily and replays the triggering event', async () => {
    const value = manifest({ contributes: {}, activationEvents: ['event:context.changed'] });
    const storage = new MemoryStorage(value);
    storage.plugins[0].enabled = true;
    const seen: JsonValue[] = [];
    const observed = { kinds: [] as string[] };
    const manager = new PluginManager(host, {
      storage,
      backendFactory: factory((ctx) => {
        ctx.events.subscribe('context.changed', (value) => seen.push(value));
      }, observed),
    });
    await manager.initialize();
    expect(observed.kinds).toEqual([]);
    manager.emit('context.changed', { projectId: 'project' });
    while (manager.value.plugins[0].state !== 'active')
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ projectId: 'project' }]);
    expect(observed.kinds).toEqual(['web']);
    await manager.dispose();
  });

  it('supports subscriptions.add and merges concurrent configuration writes', async () => {
    const value = manifest();
    value.contributes.configuration!.push({ key: 'suffix', label: 'Suffix', type: 'string' });
    let disposed = 0;
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(value),
      backendFactory: factory((ctx) => {
        ctx.subscriptions.add({
          dispose() {
            disposed++;
          },
        });
        ctx.subscriptions.add(ctx.commands.register('command', async () => 'ok'));
      }),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.executeCommand('test.plugin/command')).resolves.toBe('ok');
    await Promise.all([
      manager.updateConfig('test.plugin', { prefix: 'first' }),
      manager.updateConfig('test.plugin', { suffix: 'second' }),
    ]);
    expect(manager.value.plugins[0].config).toEqual({ prefix: 'first', suffix: 'second' });
    await manager.disable('test.plugin');
    expect(disposed).toBe(1);
    await manager.dispose();
  });

  it('registers providers transactionally, persists configuration, and cleans up on disable', async () => {
    const storage = new MemoryStorage();
    const observed = { terminated: 0 };
    const manager = new PluginManager(host, {
      storage,
      backendFactory: factory((ctx) => {
        ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async (_input, image, task) => {
          task.progress({ done: 1 });
          return { text: `pixels:${image.byteLength}` };
        });
        ctx.translation.register({ id: 'translate', name: 'Translate' }, async (input) => ({
          text: String(input),
        }));
      }, observed),
    });
    await manager.initialize();
    expect(manager.providers('ocr')).toHaveLength(0);
    await manager.enable('test.plugin');
    expect(manager.providers('ocr')).toHaveLength(1);
    expect(manager.value.plugins[0].state).toBe('inactive');
    const progress: JsonValue[] = [];
    await expect(
      manager.runOcr('test.plugin/ocr', {}, new Uint8Array([1, 2]).buffer, {
        onProgress: (value) => progress.push(value),
      }),
    ).resolves.toEqual({ text: 'pixels:2' });
    expect(progress).toEqual([{ done: 1 }]);
    await manager.updateConfig('test.plugin', { prefix: 'updated' });
    expect(storage.plugins[0].config.prefix).toBe('updated');
    await expect(manager.updateConfig('test.plugin', { prefix: 2 })).rejects.toThrow(
      'Invalid value',
    );
    await manager.disable('test.plugin');
    expect(manager.providers('ocr')).toHaveLength(0);
    expect(manager.value.plugins[0].state).toBe('inactive');
    expect(observed.terminated).toBe(1);
    expect(storage.plugins[0].enabled).toBe(false);
    await manager.dispose();
  });
  it('rolls back registrations when activation fails', async () => {
    const storage = new MemoryStorage();
    const manager = new PluginManager(host, {
      storage,
      backendFactory: factory(async (ctx) => {
        ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => 'unused');
        await ctx.config.get();
        throw new Error('Model setup failed');
      }),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.runOcr('test.plugin/ocr', {}, new Uint8Array([1]).buffer)).rejects.toThrow(
      'Model setup failed',
    );
    expect(manager.value.plugins[0].state).toBe('failed');
    expect(manager.providers('ocr')).toHaveLength(1);
    await manager.dispose();
  });
  it('selects a matching native target and otherwise falls back to web', async () => {
    const observed = { kinds: [] as string[] };
    const storage = new MemoryStorage(
      manifest({ entrypoints: { web: 'index.js', native: { 'test-target': 'native/plugin' } } }),
    );
    const register = (ctx: PluginContext) => {
      ctx.ocr.register({ id: 'ocr', name: 'OCR' }, async () => ({ text: 'ok' }));
    };
    const native = new PluginManager(host, {
      storage,
      desktop: true,
      target: 'test-target',
      backendFactory: factory(register, observed),
    });
    await native.initialize();
    await native.enable('test.plugin');
    expect(observed.kinds).toEqual([]);
    await native.runOcr('test.plugin/ocr', {}, new Uint8Array([1]).buffer);
    await native.dispose();
    const web = new PluginManager(host, {
      storage,
      desktop: true,
      target: 'other-target',
      backendFactory: factory(register, observed),
    });
    await web.initialize();
    await web.runOcr('test.plugin/ocr', {}, new Uint8Array([1]).buffer);
    await web.dispose();
    expect(observed.kinds).toEqual(['native', 'web']);
  });
  it('binds host permissions to the instance and cancels in-flight OCR before shutdown', async () => {
    const manager = new PluginManager(host, {
      storage: new MemoryStorage(),
      backendFactory: factory((ctx) => {
        ctx.commands.register({ id: 'command', title: 'Read' }, () => ctx.document.read());
        ctx.ocr.register(
          { id: 'ocr', name: 'OCR' },
          (_input, _image, context) =>
            new Promise((resolve) => {
              context.signal.addEventListener('abort', () => resolve({ text: 'late result' }), {
                once: true,
              });
            }),
        );
      }),
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.executeCommand('test.plugin/command')).rejects.toThrow('document.read');
    const running = manager.runOcr('test.plugin/ocr', {}, new Uint8Array([1]).buffer);
    const cancelled = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    while (!manager.value.tasks.length) await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.disable('test.plugin');
    await cancelled;
    expect(manager.value.tasks[0].state).toBe('cancelled');
    expect(manager.providers('ocr')).toEqual([]);
    await manager.dispose();
  });
});
