import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from '../src/runtime/plugins/manager';
import { RpcPeer, RpcError } from '../src/runtime/plugins/rpc';
import { createPluginContext, type PluginContext } from '../src/plugin-sdk';
import type { BackendFactory } from '../src/runtime/plugins/backend';
import type {
  PluginHostAdapter,
  PluginStorage,
  InstalledPlugin,
  PluginFiles,
} from '../src/runtime/plugins/types';
import type { JsonValue, PluginManifest, PluginMutationProposal } from '../src/generated/plugins';

const manifest = (id = 'test.plugin', overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id,
  name: id,
  version: '1',
  apiVersion: 1,
  entrypoints: { web: 'index.js' },
  permissions: [
    'document.read',
    'document.write',
    'images.read',
    'images.write',
    'history.read',
    'history.control',
    'document.intercept',
  ],
  contributes: {
    translation: [{ id: 'translation', name: 'Translation' }],
    commands: [{ id: 'run', title: 'Run' }],
    beforeCommitHooks: [{ id: 'guard' }],
  },
  ...overrides,
});
class Storage implements PluginStorage {
  entries: InstalledPlugin[];
  constructor(manifests: PluginManifest[]) {
    this.entries = manifests.map((manifest) => ({ manifest, enabled: false, config: {} }));
  }
  async list() {
    return structuredClone(this.entries);
  }
  async install(pkg: PluginFiles) {
    const entry = { manifest: pkg.manifest, enabled: false, config: {} };
    this.entries.push(entry);
    return entry;
  }
  async remove(id: string) {
    this.entries = this.entries.filter((entry) => entry.manifest.id !== id);
  }
  async read() {
    return new ArrayBuffer(0);
  }
  async update(id: string, patch: { enabled?: boolean; config?: Record<string, JsonValue> }) {
    Object.assign(
      this.entries.find((entry) => entry.manifest.id === id)!,
      patch,
    );
  }
}
function setup(
  manifests: PluginManifest[],
  activate: (ctx: PluginContext) => unknown | Promise<unknown>,
  hostPatch: Partial<PluginHostAdapter> = {},
) {
  const roles: string[] = [],
    terminated: string[] = [];
  const backendFactory: BackendFactory = async (
    plugin,
    _generation,
    _kind,
    receive,
    fail,
    _signal,
    role = 'main',
  ) => {
    roles.push(`${plugin.manifest.id}:${role}`);
    let sdk: ReturnType<typeof createPluginContext>;
    const peer = new RpcPeer(
      (packet) => queueMicrotask(() => receive(structuredClone(packet))),
      async (method, params, binary, id) => {
        if (method === 'handshake')
          return {
            result: { apiVersion: 1, pluginId: plugin.manifest.id, features: ['runtime.roles'] },
          };
        if (method === 'activate') {
          sdk = createPluginContext(peer, plugin.manifest, role);
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
        terminated.push(`${plugin.manifest.id}:${role}`);
        peer.close();
      },
    };
  };
  const host: PluginHostAdapter = {
    async readDocument() {
      return null;
    },
    async applyDocument() {
      return null;
    },
    async validateOperations() {},
    ...hostPatch,
  };
  const manager = new PluginManager(host, {
    storage: new Storage(manifests),
    backendFactory,
    desktop: false,
  });
  return { manager, roles, terminated };
}
const proposal = (): PluginMutationProposal => ({
  projectId: 'p',
  transactionId: crypto.randomUUID(),
  baseStateId: 's',
  origin: { kind: 'user' },
  operations: [{ type: 'translation.set', imageId: 'i', markerId: 'm', value: 'text' }],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('plugin document SDK and hook runtimes', () => {
  it('keeps provider and hook instances separate and deterministically chains rewrites', async () => {
    const order: string[] = [];
    const { manager, roles, terminated } = setup(
      [
        manifest('b.plugin', {
          contributes: { beforeCommitHooks: [{ id: 'guard', priority: 0 }] },
        }),
        manifest('a.plugin'),
      ],
      (ctx) => {
        ctx.translation.register(
          { id: 'translation', name: 'Translation' },
          async () => 'translated',
        );
        ctx.hooks.beforeCommit.register('guard', (input) => {
          order.push(ctx.pluginId);
          return {
            action: 'replace',
            operations: [...input.operations, { type: 'project.update', name: ctx.pluginId }],
          };
        });
      },
    );
    // Only a.plugin declares a provider; registration is deliberately omitted for b.plugin's main role.
    await manager.initialize();
    await manager.enable('a.plugin');
    await manager.enable('b.plugin');
    expect(roles).toEqual(['a.plugin:hooks', 'b.plugin:hooks']);
    const result = await manager.intercept(proposal());
    expect(order).toEqual(['a.plugin', 'b.plugin']);
    expect(result).toHaveLength(3);
    expect(await manager.translate('a.plugin/translation', {})).toBe('translated');
    expect(roles).toContain('a.plugin:main');
    await manager.disable('a.plugin');
    expect(terminated).toEqual(expect.arrayContaining(['a.plugin:main', 'a.plugin:hooks']));
    await manager.dispose();
  });
  it('passes the fixed proposal to reads and rejects nested document/history writes in hooks', async () => {
    const calls: string[] = [],
      denied: string[] = [];
    const { manager } = setup(
      [manifest()],
      (ctx) => {
        ctx.hooks.beforeCommit.register('guard', async (input) => {
          expect(await ctx.document.read()).toEqual({ state: input.baseStateId });
          for (const work of [
            () => ctx.document.transaction({ projectId: 'p', label: 'nested', operations: [] }),
            () => ctx.history.undo({ projectId: 'p' }),
            () => ctx.config.update({}),
            () => ctx.resources.fetch('https://example.com/model'),
          ]) {
            try {
              await work();
            } catch (error) {
              denied.push(String(error));
            }
          }
          return { action: 'continue' };
        });
      },
      {
        async call(_id, method, _params, _binary, context) {
          calls.push(method);
          expect(context?.runtimeRole).toBe('hooks');
          return { result: { state: context?.proposal?.baseStateId ?? null } };
        },
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await manager.intercept(proposal());
    expect(calls).toEqual(['document.read']);
    expect(denied).toHaveLength(4);
    expect(manager.value.plugins[0].hooksState).toBe('ready');
    await manager.dispose();
  });
  it('keeps earlier valid rewrites when a later hook fails, and resumes without replacing main', async () => {
    let failure = true;
    const { manager, roles } = setup([manifest('a.plugin'), manifest('b.plugin')], (ctx) => {
      ctx.translation.register({ id: 'translation', name: 'Translation' }, async () => 'ok');
      ctx.hooks.beforeCommit.register('guard', (input) => {
        if (ctx.pluginId === 'b.plugin' && failure) throw new Error('bad hook');
        return {
          action: 'replace',
          operations: [...input.operations, { type: 'project.update', name: ctx.pluginId }],
        };
      });
    });
    await manager.initialize();
    await manager.enable('a.plugin');
    await manager.enable('b.plugin');
    expect(await manager.intercept(proposal())).toHaveLength(2);
    expect(manager.value.plugins.find((p) => p.manifest.id === 'b.plugin')?.hooksState).toBe(
      'paused',
    );
    expect(await manager.translate('b.plugin/translation', {})).toBe('ok');
    failure = false;
    await manager.resumeHooks('b.plugin');
    expect(await manager.intercept(proposal())).toHaveLength(3);
    expect(roles.filter((role) => role === 'b.plugin:main')).toHaveLength(1);
    await manager.dispose();
  });
  it('treats rejection as a business result and lets subsequent proposals run', async () => {
    let rejected = true;
    const { manager } = setup([manifest()], (ctx) =>
      ctx.hooks.beforeCommit.register('guard', () =>
        rejected ? { action: 'reject', reason: 'rule' } : { action: 'continue' },
      ),
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.intercept(proposal())).rejects.toMatchObject({
      code: 'rejected',
      message: 'rule',
    });
    expect(manager.value.plugins[0].hooksState).toBe('ready');
    rejected = false;
    expect(await manager.intercept(proposal())).toHaveLength(1);
    await manager.dispose();
  });
  it('fails open for a thrown rejection error instead of treating it as a rule rejection', async () => {
    const { manager } = setup([manifest()], (ctx) =>
      ctx.hooks.beforeCommit.register('guard', () => {
        throw new RpcError('rejected', 'handler crashed');
      }),
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    expect(await manager.intercept(proposal())).toHaveLength(1);
    expect(manager.value.plugins[0].hooksState).toBe('paused');
    await manager.dispose();
  });
  it('times out hooks, ignores late rewrites, and keeps the provider usable', async () => {
    let late: ((value: { action: 'replace'; operations: [] }) => void) | undefined;
    const { manager } = setup([manifest()], (ctx) => {
      ctx.translation.register({ id: 'translation', name: 'Translation' }, async () => 'ok');
      ctx.hooks.beforeCommit.register(
        'guard',
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      );
    });
    await manager.initialize();
    await manager.enable('test.plugin');
    const result = await manager.intercept(proposal());
    expect(result).toHaveLength(1);
    expect(manager.value.plugins[0].hooksState).toBe('paused');
    late?.({ action: 'replace', operations: [] });
    await tick();
    expect(result).toHaveLength(1);
    expect(await manager.translate('test.plugin/translation', {})).toBe('ok');
    await manager.dispose();
  });
  it('binds legacy document.apply requests to the current main instance', async () => {
    let bound = '';
    const released: string[] = [];
    const { manager } = setup(
      [manifest('test.plugin', { contributes: { commands: [{ id: 'run', title: 'run' }] } })],
      (ctx) =>
        ctx.commands.register('run', async () =>
          ctx.document.apply({
            type: 'setTranslation',
            projectId: 'p',
            imageId: 'i',
            markerId: 'm',
            text: 'legacy',
          }),
        ),
      {
        async call(_id, method, _params, _binary, context) {
          expect(method).toBe('document.apply');
          expect(context?.runtimeRole).toBe('main');
          bound = context!.instanceId;
          return { result: null };
        },
        releaseInstance(_id, instanceId) {
          released.push(instanceId);
        },
        async applyDocument() {
          throw new Error('unbound adapter must not be called');
        },
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await manager.executeCommand('test.plugin/run');
    await manager.disable('test.plugin');
    expect(bound).toBeTruthy();
    expect(released).toContain(bound);
    await manager.dispose();
  });
  it('ignores responses and validation that finish after the deadline before timer dispatch', async () => {
    for (const validation of [false, true]) {
      let now = 0;
      const { manager } = setup(
        [manifest()],
        (ctx) =>
          ctx.hooks.beforeCommit.register('guard', () => {
            if (!validation) {
              now = 300;
              return { action: 'reject', reason: 'late rejection' };
            }
            return { action: 'replace', operations: [] };
          }),
        {
          async validateOperations() {
            now = 300;
          },
        },
      );
      await manager.initialize();
      await manager.enable('test.plugin');
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      try {
        expect(await manager.intercept(proposal())).toHaveLength(1);
        expect(manager.value.plugins[0]).toMatchObject({ hooksState: 'paused' });
        expect(manager.value.plugins[0].hooksError).toContain('deadline');
      } finally {
        clock.mockRestore();
        await manager.dispose();
      }
    }
  });
  it('requires document metadata permission together with image bytes permission', async () => {
    const call = vi.fn(async () => ({ result: null }));
    const { manager } = setup(
      [
        manifest('test.plugin', {
          permissions: ['images.read'],
          contributes: { commands: [{ id: 'run', title: 'run' }] },
        }),
      ],
      (ctx) =>
        ctx.commands.register('run', async () => {
          await ctx.document.images.read({ projectId: 'p', imageId: 'i' });
          return null;
        }),
      { call },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.executeCommand('test.plugin/run')).rejects.toThrow('document.read');
    expect(call).not.toHaveBeenCalled();
    await manager.dispose();
  });
  it('limits the whole hook chain and skips hooks after its deadline', async () => {
    const called: string[] = [];
    const values = Array.from({ length: 6 }, (_, index) => manifest(`p${index}.plugin`));
    const { manager } = setup(values, (ctx) =>
      ctx.hooks.beforeCommit.register('guard', () => {
        called.push(ctx.pluginId);
        return new Promise(() => {});
      }),
    );
    await manager.initialize();
    for (const value of values) await manager.enable(value.id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const pending = manager.intercept(proposal());
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toHaveLength(1);
      expect(called).toEqual(['p0.plugin', 'p1.plugin', 'p2.plugin', 'p3.plugin']);
      expect(manager.value.plugins.filter((plugin) => plugin.hooksState === 'paused')).toHaveLength(
        4,
      );
      expect(manager.value.plugins.filter((plugin) => plugin.hooksState === 'ready')).toHaveLength(
        2,
      );
    } finally {
      vi.useRealTimers();
      await manager.dispose();
    }
  });
  it('pauses an invalid rewrite and keeps the valid proposal', async () => {
    const { manager } = setup(
      [manifest()],
      (ctx) =>
        ctx.hooks.beforeCommit.register('guard', () => ({ action: 'replace', operations: [] })),
      {
        async validateOperations() {
          throw new Error('rewrite denied');
        },
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    expect(await manager.intercept(proposal())).toHaveLength(1);
    expect(manager.value.plugins[0]).toMatchObject({
      hooksState: 'paused',
      hooksError: 'rewrite denied',
    });
    await manager.dispose();
  });
  it('releases resources returned by an in-flight stage after the instance stops', async () => {
    let finish: ((value: { result: JsonValue }) => void) | undefined;
    const released: string[] = [];
    const { manager } = setup(
      [manifest('test.plugin', { contributes: { commands: [{ id: 'run', title: 'run' }] } })],
      (ctx) =>
        ctx.commands.register('run', async () => {
          await ctx.document.images.stage({ projectId: 'p' }, new ArrayBuffer(1));
          return null;
        }),
      {
        async call() {
          return await new Promise((resolve) => {
            finish = resolve;
          });
        },
        releaseInstance(_id, instanceId) {
          released.push(instanceId);
        },
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    const command = manager.executeCommand('test.plugin/run').catch(() => null);
    await tick();
    expect(finish).toBeDefined();
    await manager.disable('test.plugin');
    await command;
    expect(released).toHaveLength(1);
    finish!({ result: { stagedResource: 'late' } });
    await tick();
    expect(released).toEqual([released[0], released[0]]);
    await manager.dispose();
  });
  it('transfers staged binary separately and submits stable IDs through transactions', async () => {
    const calls: Array<{ method: string; params: JsonValue; bytes?: number[] }> = [];
    const { manager } = setup(
      [manifest('test.plugin', { contributes: { commands: [{ id: 'run', title: 'run' }] } })],
      (ctx) =>
        ctx.commands.register('run', async () => {
          const staged = await ctx.document.images.stage(
            { projectId: 'p', filename: 'x.png' },
            new Uint8Array([1, 2, 3]).buffer,
          );
          const id = ctx.document.createId();
          await ctx.history.push({
            projectId: 'p',
            label: 'atomic',
            operations: [
              { type: 'image.create', id, stagedResource: staged.stagedResource },
              { type: 'image.update', imageId: id, filename: 'new.png' },
            ],
          });
          await ctx.history.pop({
            projectId: 'p',
            stack: 'undo',
            expectedEntryId: 'entry',
            expectedHistoryRevision: 3,
          });
          return id;
        }),
      {
        async call(_id, method, params, binary) {
          calls.push({ method, params, ...(binary ? { bytes: [...new Uint8Array(binary)] } : {}) });
          return {
            result: method === 'document.images.stage' ? { stagedResource: 'stage' } : null,
          };
        },
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    const id = await manager.executeCommand('test.plugin/run');
    expect(calls[0]).toMatchObject({ method: 'document.images.stage', bytes: [1, 2, 3] });
    expect(calls[1]).toMatchObject({
      method: 'document.transaction',
      params: {
        operations: [
          { type: 'image.create', id },
          { type: 'image.update', imageId: id },
        ],
      },
    });
    expect(calls[2]).toMatchObject({
      method: 'history.pop',
      params: { expectedEntryId: 'entry', expectedHistoryRevision: 3 },
    });
    await manager.dispose();
  });
});

describe('confirmed plugin events', () => {
  it('filters own and other-project mutations, supports includeSelf, and never replays mutations', async () => {
    const filtered: JsonValue[] = [],
      all: JsonValue[] = [];
    let context: PluginContext;
    const { manager } = setup(
      [manifest('test.plugin', { contributes: { commands: [{ id: 'run', title: 'run' }] } })],
      (ctx) => {
        context = ctx;
        ctx.commands.register('run', () => null);
        ctx.events.subscribe('translation.changed', (data) => filtered.push(data), {
          projectId: 'p',
        });
        ctx.events.subscribe('translation.changed', (data) => all.push(data), {
          includeSelf: true,
        });
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await manager.executeCommand('test.plugin/run');
    const emit = (projectId: string, pluginId?: string) =>
      manager.emit('translation.changed', {
        projectId,
        origin: { kind: 'plugin', ...(pluginId ? { pluginId } : {}) },
      });
    emit('p', 'test.plugin');
    emit('other', 'external');
    emit('p', 'external');
    await tick();
    expect(filtered).toHaveLength(1);
    expect(all).toHaveLength(3);
    const late: JsonValue[] = [];
    context!.events.subscribe('translation.changed', (value) => late.push(value));
    await tick();
    expect(late).toHaveLength(0);
    await manager.dispose();
  });
  it('does not expose document changes through subscriptions without read permission', async () => {
    const { manager } = setup(
      [
        manifest('test.plugin', {
          permissions: [],
          contributes: { commands: [{ id: 'run', title: 'run' }] },
        }),
      ],
      (ctx) => {
        ctx.commands.register('run', () => null);
        ctx.events.subscribe('document.changed', () => {});
      },
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    await expect(manager.executeCommand('test.plugin/run')).rejects.toThrow('document.read');
    await manager.dispose();
  });
  it('delivers the mutation that activates an event-only plugin once', async () => {
    const seen: JsonValue[] = [];
    const { manager } = setup(
      [
        manifest('test.plugin', {
          contributes: {},
          activationEvents: ['event:translation.changed'],
        }),
      ],
      (ctx) => ctx.events.subscribe('translation.changed', (data) => seen.push(data)),
    );
    await manager.initialize();
    await manager.enable('test.plugin');
    manager.emit('translation.changed', {
      projectId: 'p',
      transactionId: 'tx',
      origin: { kind: 'user' },
    });
    await tick();
    await tick();
    expect(seen).toHaveLength(1);
    await manager.dispose();
  });
});
