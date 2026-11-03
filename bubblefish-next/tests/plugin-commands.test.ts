import { describe, expect, it } from 'vitest';
import { PluginManager } from '../src/runtime/plugins/manager';
import { RpcPeer, type Packet } from '../src/runtime/plugins/rpc';
import { createPluginContext, type CommandHandler, type PluginContext } from '../src/plugin-sdk';
import type { BackendFactory } from '../src/runtime/plugins/backend';
import type { LocalResourceStorage } from '../src/runtime/plugins/local-resources';
import type { InstalledPlugin, PluginFiles, PluginStorage } from '../src/runtime/plugins/types';
import type { JsonValue } from '../src/generated/plugins';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
class Storage implements PluginStorage {
  entries: InstalledPlugin[];
  constructor(ids: string[]) {
    this.entries = ids.map((id) => ({
      manifest: {
        id,
        name: id,
        version: '1',
        apiVersion: 1,
        entrypoints: { web: 'index.js' },
        contributes: {
          commands: [
            { id: 'work', title: 'Work' },
            { id: 'quick', title: 'Quick' },
          ],
          translation: [{ id: 'translation', name: 'Translate' }],
        },
      },
      enabled: false,
      config: {},
    }));
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
async function setup(
  handler: (ctx: PluginContext) => CommandHandler,
  options: { ids?: string[]; activating?: ReturnType<typeof deferred>; legacy?: boolean } = {},
) {
  const storage = new Storage(options.ids ?? ['test.commands']);
  const terminated: string[] = [],
    packets: Packet[] = [];
  const failures = new Map<string, (error: Error) => void>();
  const contexts = new Map<string, PluginContext>();
  const backendFactory: BackendFactory = async (plugin, _generation, _kind, receive, fail) => {
    failures.set(plugin.manifest.id, fail);
    let sdk: ReturnType<typeof createPluginContext>;
    const peer = new RpcPeer(
      (packet) => queueMicrotask(() => receive(structuredClone(packet))),
      async (method, params, binary, id) => {
        if (method === 'handshake')
          return {
            result: {
              apiVersion: 1,
              pluginId: plugin.manifest.id,
              features: options.legacy ? [] : ['commands.tasks'],
            },
          };
        if (method === 'activate') {
          sdk = createPluginContext(peer, plugin.manifest);
          contexts.set(plugin.manifest.id, sdk.context);
          sdk.context.commands.register('work', handler(sdk.context));
          sdk.context.commands.register('quick', () => 'quick result');
          sdk.context.translation.register({ id: 'translation', name: 'Translate' }, () => ({
            text: '译文',
          }));
          await sdk.ready();
          await options.activating?.promise;
          return { result: null };
        }
        if (method === 'deactivate') {
          await sdk.dispose();
          return { result: null };
        }
        return sdk.invoke(method, params, binary, id);
      },
      (event, data) => {
        if (!options.legacy) sdk?.event(event, data);
      },
    );
    return {
      send(packet) {
        packets.push(structuredClone(packet));
        queueMicrotask(() => {
          void peer.receive(structuredClone(packet)).catch(fail);
        });
      },
      async terminate() {
        terminated.push(plugin.manifest.id);
        peer.close();
      },
    };
  };
  const localResources = {
    releaseOwner: async () => {},
    removePlugin: async () => {},
  } as unknown as LocalResourceStorage;
  const manager = new PluginManager(
    { readDocument: async () => null, applyDocument: async () => null },
    { storage, backendFactory, desktop: false, localResources },
  );
  await manager.initialize();
  for (const id of options.ids ?? ['test.commands']) await manager.enable(id);
  return { manager, storage, terminated, packets, failures, contexts };
}
const run = (manager: PluginManager) => manager.value.commandRuns[0];

describe('controlled RPC boundary', () => {
  it('keeps a cancelled request pending until the actual reply and drops its late result', async () => {
    const packets: Packet[] = [];
    const peer = new RpcPeer(
      (packet) => packets.push(packet),
      async () => ({ result: null }),
    );
    const request = peer.requestControlled('commands.execute');
    let settled = false;
    const result = request.result.catch((error) => {
      settled = true;
      return error;
    });
    request.cancel();
    request.cancel();
    await tick();
    expect(settled).toBe(false);
    expect(packets.filter((packet) => packet.message.kind === 'event')).toHaveLength(1);
    await peer.receive({
      message: { kind: 'response', apiVersion: 1, id: request.id, result: 'late' },
    });
    expect((await result).name).toBe('AbortError');
    expect(settled).toBe(true);
    peer.close();
  });
  it('settles retained requests on disconnect', async () => {
    const peer = new RpcPeer(
      () => {},
      async () => ({ result: null }),
    );
    const request = peer.requestControlled('commands.execute');
    const pending = expect(request.result).rejects.toThrow('Cancelled');
    request.cancel();
    peer.close();
    await pending;
  });
});

describe('user command feedback', () => {
  it.each([null, false, 0, '', 'text', { passed: false }, [1, 'x']].map((value) => ({ value })))(
    'retains the exact return value $value',
    async ({ value }) => {
      const { manager } = await setup(() => () => value as JsonValue);
      await expect(manager.runUserCommand('test.commands/work')).resolves.toEqual(value);
      expect(run(manager)).toMatchObject({ state: 'completed', result: value });
      expect(run(manager).summary).toBeUndefined();
      expect(manager.value.commandNotice).toBeNull();
      await manager.dispose();
    },
  );
  it('keeps panel/internal calls silent and only publishes summaries after a successful user run', async () => {
    const finish = deferred();
    const { manager } = await setup(() => async (_params, task) => {
      task.summary('查询成功');
      task.progress({ message: '读取状态', completed: 1, total: 2 });
      await finish.promise;
      return { ready: true };
    });
    const internal = manager.executeCommand('test.commands/work');
    await tick();
    expect(manager.value.commandRuns).toEqual([]);
    expect(manager.value.commandNotice).toBeNull();
    finish.release();
    await internal;
    await manager.runUserCommand('test.commands/work', null, 'menu');
    expect(run(manager)).toMatchObject({
      state: 'completed',
      summary: '查询成功',
      result: { ready: true },
      progress: { message: '读取状态' },
    });
    expect(manager.value.commandNotice).toEqual({
      pluginId: 'test.commands',
      runId: run(manager).id,
    });
    manager.dismissCommandNotice();
    expect(manager.value.commandNotice).toBeNull();
    await manager.dispose();
    expect(manager.value.commandRuns).toEqual([]);
  });
  it('does not publish a success summary when the handler throws', async () => {
    const { manager } = await setup(() => (_params, task) => {
      task.summary('不能显示');
      throw new Error('检查失败');
    });
    await expect(manager.runUserCommand('test.commands/work')).rejects.toThrow('检查失败');
    expect(run(manager)).toMatchObject({ state: 'failed', error: '检查失败' });
    expect(run(manager).summary).toBeUndefined();
    await manager.dispose();
  });
  it('cancels cooperative work, holds the queue through cleanup and lets another plugin/provider run', async () => {
    const started = deferred(),
      cleanup = deferred(),
      cancelled = deferred();
    const seen: string[] = [];
    const { manager, terminated } = await setup(
      (ctx) => async (_params, task) => {
        seen.push(ctx.pluginId);
        if (ctx.pluginId === 'other.commands') return 'other';
        task.progress({ message: '处理中', completed: 1, total: 4 });
        started.release();
        await new Promise<void>((resolve) =>
          task.signal.addEventListener(
            'abort',
            () => {
              cancelled.release();
              resolve();
            },
            { once: true },
          ),
        );
        await cleanup.promise;
        return 'discard';
      },
      { ids: ['test.commands', 'other.commands'] },
    );
    const pending = manager.runUserCommand('test.commands/work');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    const id = run(manager).id;
    await expect(manager.runUserCommand('test.commands/work')).rejects.toThrow('已有命令');
    manager.cancelUserCommand(id);
    await cancelled.promise;
    expect(run(manager).state).toBe('cancelling');
    let quickFinished = false;
    const quick = manager.executeCommand('test.commands/quick').then(() => {
      quickFinished = true;
    });
    await expect(manager.runUserCommand('other.commands/work')).resolves.toBe('other');
    await expect(manager.translate('test.commands/translation', {})).resolves.toEqual({
      text: '译文',
    });
    expect(quickFinished).toBe(false);
    expect(terminated).toEqual([]);
    cleanup.release();
    await rejected;
    await quick;
    expect(manager.value.commandRuns.find((entry) => entry.id === id)?.state).toBe('cancelled');
    expect(manager.value.commandRuns.find((entry) => entry.id === id)?.result).toBeUndefined();
    await manager.dispose();
  });
  it('a cancelled queued run cannot let later calls overtake an earlier internal call', async () => {
    const started = deferred(),
      finish = deferred();
    let calls = 0;
    const { manager } = await setup(() => async () => {
      calls++;
      started.release();
      await finish.promise;
      return 'first';
    });
    const internal = manager.executeCommand('test.commands/work');
    await started.promise;
    const queued = manager.runUserCommand('test.commands/work');
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    manager.cancelUserCommand(run(manager).id);
    await cancelled;
    let quickFinished = false;
    const quick = manager.runUserCommand('test.commands/quick').then(() => {
      quickFinished = true;
    });
    await tick();
    expect(calls).toBe(1);
    expect(quickFinished).toBe(false);
    finish.release();
    await internal;
    await quick;
    expect(run(manager)).toMatchObject({ state: 'completed', result: 'quick result' });
    await manager.dispose();
  });
  it('cancels activation waiting without cancelling the shared activation', async () => {
    const activating = deferred();
    let calls = 0;
    const { manager } = await setup(
      () => () => {
        calls++;
        return 'ok';
      },
      { activating },
    );
    const pending = manager.runUserCommand('test.commands/work');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    while (run(manager).state !== 'activating') await tick();
    manager.cancelUserCommand(run(manager).id);
    await rejected;
    expect(run(manager).state).toBe('cancelled');
    activating.release();
    await manager.runUserCommand('test.commands/work');
    expect(calls).toBe(1);
    expect(run(manager).state).toBe('completed');
    await manager.dispose();
  });
  it('legacy work stays cancelling until its real completion and does not terminate its instance', async () => {
    const started = deferred(),
      finish = deferred();
    const { manager, terminated } = await setup(
      () => async () => {
        started.release();
        await finish.promise;
        return 'late';
      },
      { legacy: true },
    );
    const pending = manager.runUserCommand('test.commands/work');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    manager.cancelUserCommand(run(manager).id);
    await tick();
    expect(run(manager).state).toBe('cancelling');
    expect(terminated).toEqual([]);
    finish.release();
    await rejected;
    expect(run(manager)).toMatchObject({ state: 'cancelled' });
    expect(run(manager).result).toBeUndefined();
    await manager.runUserCommand('test.commands/quick');
    await manager.dispose();
  });
  it.each(['disable', 'crash', 'remove'] as const)(
    '%s invalidates pending work and discards old replies after a new activation',
    async (action) => {
      const started = deferred(),
        finish = deferred();
      let generation = 0;
      const { manager, failures } = await setup(() => {
        generation++;
        return async () => {
          if (generation > 1) return 'new';
          started.release();
          await finish.promise;
          return 'old';
        };
      });
      const pending = manager.runUserCommand('test.commands/work');
      const rejected = expect(pending).rejects.toThrow();
      await started.promise;
      if (action === 'disable') await manager.disable('test.commands');
      else if (action === 'remove') await manager.remove('test.commands');
      else {
        failures.get('test.commands')!(new Error('crash'));
        while (manager.value.plugins[0].state !== 'failed') await tick();
      }
      await rejected;
      if (action === 'remove') expect(manager.value.commandRuns).toEqual([]);
      else {
        expect(run(manager).state).toBe('interrupted');
        if (action === 'disable') await manager.enable('test.commands');
        await expect(manager.runUserCommand('test.commands/work')).resolves.toBe('new');
        expect(run(manager).result).toBe('new');
      }
      finish.release();
      await tick();
      if (action !== 'remove') expect(run(manager).result).toBe('new');
      await manager.dispose();
    },
  );
});
