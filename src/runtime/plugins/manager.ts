import { writable, get } from 'svelte/store';
import { APP_VERSION } from '../app-identity';
import type {
  JsonValue,
  CommandInfo,
  PluginMutationProposal,
  PluginOperation,
  BeforeCommitHookInfo,
} from '../../generated/plugins';
import { BrowserPluginStorage, NativePluginStorage } from './storage';
import { readPluginPackage, validateConfig, validateManifest, resourcePath } from './package';
import { RpcPeer, RpcError, type RpcResult, type ControlledRequest } from './rpc';
import { createBackendFactory, type BackendFactory, type PluginBackend } from './backend';
import {
  BrowserLocalResourceStorage,
  NativeLocalResourceStorage,
  type LocalResourceStorage,
} from './local-resources';
import type { PluginLocalResourceImport } from '../../generated/plugins';
import {
  errorMessage,
  newId,
  object,
  type PluginHostAdapter,
  type PluginStorage,
  type PluginView,
  type ProviderEntry,
  type ManagerView,
  type TaskOptions,
  type PluginRuntimeRole,
  type EventSubscriptionOptions,
  type PluginCommandRun,
} from './types';

class HookRejected extends RpcError {
  constructor(reason: string) {
    super('rejected', reason);
  }
}
const compareIds = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
interface EventListener {
  event: string;
  options: EventSubscriptionOptions;
}
interface Instance {
  runtimeRole: PluginRuntimeRole;
  instanceId: string;
  hooks: Map<string, BeforeCommitHookInfo & { operations?: string[] }>;
  proposal?: PluginMutationProposal;
  generation: number;
  peer: RpcPeer;
  backend?: PluginBackend;
  providers: Map<string, ProviderEntry>;
  commands: Map<string, CommandInfo>;
  events: Map<string, EventListener>;
  activationController: AbortController;
}
interface CommandExecution {
  id: string;
  pluginId: string;
  epoch: number;
  controller: AbortController;
  runId?: string;
  instance?: Instance;
  request?: ControlledRequest;
  summary?: string;
  interrupted: boolean;
  interruption?: Error;
}
const commandPending = (run: PluginCommandRun) =>
  ['queued', 'activating', 'running', 'cancelling'].includes(run.state);
export class PluginManager {
  private readonly store = writable<ManagerView>({
    ready: false,
    plugins: [],
    providers: [],
    commands: [],
    panels: [],
    activePanel: null,
    tasks: [],
    logs: [],
    commandRuns: [],
    commandNotice: null,
  });
  readonly subscribe = this.store.subscribe;
  private readonly storage: PluginStorage;
  private readonly localResources: LocalResourceStorage;
  private readonly factory: BackendFactory;
  private readonly desktop: boolean;
  private readonly resetNativeRuntime: boolean;
  private readonly onBottomPanelOpen?: (panel: { pluginId: string; panelId: string }) => void;
  private target = '';
  private instances = new Map<string, Instance>();
  private hookInstances = new Map<string, Instance>();
  private hookActivations = new Map<string, Promise<void>>();
  private hookCleanups = new Map<string, Promise<void>>();
  private pendingActivationEvents = new Map<string, Array<{ event: string; data: JsonValue }>>();
  private generations = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();
  private configTails = new Map<string, Promise<void>>();
  private activations = new Map<string, Promise<void>>();
  private stopping = new Set<string>();
  private desiredEnabled = new Map<string, boolean>();
  private providerTails = new Map<string, Promise<unknown>>();
  private taskControllers = new Map<string, AbortController>();
  private progressCallbacks = new Map<string, (progress: JsonValue) => void>();
  private panelConnections = new Map<
    string,
    Set<{ peer: RpcPeer; events: Map<string, EventListener>; close(): void }>
  >();
  private lastEvents = new Map<string, JsonValue>();
  private modelControllers = new Map<string, Set<AbortController>>();
  private disposed = false;
  private exitPaused = false;
  private commandExecutions = new Map<string, CommandExecution>();
  private commandTails = new Map<string, Promise<void>>();
  private commandEpochs = new Map<string, number>();
  private interceptionTail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly host: PluginHostAdapter,
    options: {
      storage?: PluginStorage;
      backendFactory?: BackendFactory;
      desktop?: boolean;
      target?: string;
      localResources?: LocalResourceStorage;
      onBottomPanelOpen?: (panel: { pluginId: string; panelId: string }) => void;
    } = {},
  ) {
    this.desktop = options.desktop ?? (typeof __DESKTOP__ !== 'undefined' && __DESKTOP__);
    this.resetNativeRuntime = this.desktop && !options.backendFactory;
    this.onBottomPanelOpen = options.onBottomPanelOpen;
    this.target = options.target ?? '';
    this.storage =
      options.storage ?? (this.desktop ? new NativePluginStorage() : new BrowserPluginStorage());
    this.localResources =
      options.localResources ??
      (this.desktop ? new NativeLocalResourceStorage() : new BrowserLocalResourceStorage());
    this.factory = options.backendFactory ?? createBackendFactory(this.storage);
  }
  get value() {
    return get(this.store);
  }
  private plugin(id: string) {
    const plugin = this.value.plugins.find((entry) => entry.manifest.id === id);
    if (!plugin) throw new Error(`Plugin not installed: ${id}`);
    return plugin;
  }
  private update(id: string, patch: Partial<PluginView>) {
    this.store.update((state) => ({
      ...state,
      plugins: state.plugins.map((entry) =>
        entry.manifest.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
    this.publish();
  }
  private publish() {
    this.store.update((state) => {
      const enabled = state.plugins.filter((entry) => entry.enabled);
      return {
        ...state,
        providers: enabled.flatMap((entry) =>
          (['ocr', 'translation'] as const).flatMap((kind) =>
            (entry.manifest.contributes[kind] ?? []).map((info) => ({
              id: `${entry.manifest.id}/${info.id}`,
              pluginId: entry.manifest.id,
              kind,
              info,
            })),
          ),
        ),
        commands: enabled.flatMap((entry) =>
          (entry.manifest.contributes.commands ?? []).map((info) => ({
            id: `${entry.manifest.id}/${info.id}`,
            pluginId: entry.manifest.id,
            info,
          })),
        ),
        panels: enabled.flatMap((entry) =>
          (entry.manifest.contributes.panels ?? []).map((info) => ({
            id: `${entry.manifest.id}/${info.id}`,
            pluginId: entry.manifest.id,
            info,
          })),
        ),
      };
    });
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.tails.set(id, current);
    void current
      .finally(() => {
        if (this.tails.get(id) === current) this.tails.delete(id);
      })
      .catch(() => {});
    return current;
  }
  async initialize() {
    if (this.value.ready) return;
    if (this.resetNativeRuntime)
      await (await import('@tauri-apps/api/core')).invoke('plugin_reset_runtime');
    if (this.desktop && !this.target)
      this.target = await (
        await import('@tauri-apps/api/core')
      ).invoke<string>('plugin_native_target');
    const plugins = await this.storage.list();
    for (const plugin of plugins) validateManifest(plugin.manifest);
    this.store.update((state) => ({
      ...state,
      plugins: plugins.map((entry) => ({ ...entry, state: 'inactive', backend: null })),
      ready: true,
    }));
    this.publish();
    await Promise.allSettled(
      plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => this.warmHooks(plugin.manifest.id)),
    );
    await Promise.allSettled(
      plugins
        .filter((plugin) => plugin.enabled && plugin.manifest.activationEvents?.includes('startup'))
        .map((plugin) => this.ensureActivated(plugin.manifest.id)),
    );
  }
  async install(file: Blob) {
    if (this.exitPaused) throw new RpcError('exit_preparing', '正在准备退出');
    const pkg = await readPluginPackage(file);
    if (this.value.plugins.some((entry) => entry.manifest.id === pkg.manifest.id))
      throw new Error('Plugin is already installed; remove it before installing another version');
    const installed = await this.storage.install(pkg);
    this.store.update((state) => ({
      ...state,
      plugins: [...state.plugins, { ...installed, state: 'inactive', backend: null }],
    }));
    return installed;
  }
  enable(id: string) {
    if (this.exitPaused) return Promise.reject(new RpcError('exit_preparing', '正在准备退出'));
    this.desiredEnabled.set(id, true);
    return this.serial(id, async () => {
      if (!this.desiredEnabled.get(id)) return;
      this.stopping.delete(id);
      const plugin = this.plugin(id);
      if (
        !plugin.manifest.entrypoints.web &&
        !(this.desktop && plugin.manifest.entrypoints.native?.[this.target])
      )
        throw new Error('Plugin has no entrypoint for this platform');
      await this.storage.update(id, { enabled: true });
      if (!this.desiredEnabled.get(id)) {
        this.update(id, { enabled: false });
        return;
      }
      this.update(id, {
        enabled: true,
        error: undefined,
        state: plugin.state === 'failed' ? 'inactive' : plugin.state,
      });
      await this.warmHooks(id);
      if (plugin.manifest.activationEvents?.includes('startup')) await this.activate(id);
    });
  }
  disable(id: string) {
    this.requestStop(id);
    return this.serial(id, async () => {
      this.plugin(id);
      await this.storage.update(id, { enabled: false });
      this.update(id, { enabled: false });
      await this.deactivate(id);
    });
  }
  remove(id: string) {
    this.requestStop(id);
    return this.serial(id, async () => {
      await this.deactivate(id);
      await this.localResources.removePlugin(id);
      await this.storage.remove(id);
      if (typeof caches !== 'undefined') await caches.delete(`bubblefish-plugin-models-${id}`);
      this.store.update((state) => ({
        ...state,
        plugins: state.plugins.filter((entry) => entry.manifest.id !== id),
        commandRuns: state.commandRuns.filter((entry) => entry.pluginId !== id),
        commandNotice: state.commandNotice?.pluginId === id ? null : state.commandNotice,
      }));
    });
  }
  private async activate(id: string, runtimeRole: PluginRuntimeRole = 'main') {
    const instances = runtimeRole === 'hooks' ? this.hookInstances : this.instances;
    if (this.disposed) throw new Error('Plugin manager is disposed');
    if (this.exitPaused) throw new RpcError('exit_preparing', '正在准备退出');
    if (this.stopping.has(id)) throw new Error('Plugin is stopping');
    const plugin = this.plugin(id);
    if (runtimeRole === 'main' ? plugin.state === 'active' : plugin.hooksState === 'ready') return;
    const kind =
      this.desktop && plugin.manifest.entrypoints.native?.[this.target] ? 'native' : 'web';
    const generationKey = `${id}:${runtimeRole}`;
    const generation = (this.generations.get(generationKey) ?? 0) + 1;
    this.generations.set(generationKey, generation);
    const instance: Instance = {
      runtimeRole,
      instanceId: `${runtimeRole}:${newId()}`,
      hooks: new Map(),
      generation,
      providers: new Map(),
      commands: new Map(),
      events: new Map(),
      activationController: new AbortController(),
      peer: new RpcPeer(
        (packet) => {
          if (!instance.backend) throw new Error('Plugin backend is not ready');
          instance.backend.send(packet);
        },
        (method, params, binary) => this.hostCall(id, instance, method, params, binary),
        (event, data) => this.onPluginEvent(id, instance, event, data),
      ),
    };
    instances.set(id, instance);
    if (runtimeRole === 'main')
      this.update(id, { state: 'activating', backend: kind, error: undefined });
    else this.update(id, { hooksState: 'warming', hooksError: undefined });
    try {
      const startup = this.factory(
        plugin,
        generation,
        kind,
        (packet) => {
          if (instances.get(id) === instance)
            void instance.peer.receive(packet).catch((error) => this.failed(id, instance, error));
        },
        (error) => {
          void this.failed(id, instance, error);
        },
        instance.activationController.signal,
        runtimeRole,
      );
      void startup.then(
        (backend) => {
          if (instance.activationController.signal.aborted || instances.get(id) !== instance)
            void backend.terminate().catch(() => {});
        },
        () => {},
      );
      instance.backend = await this.waitForActivation(
        startup,
        instance.activationController.signal,
      );
      if (instances.get(id) !== instance) {
        await instance.backend.terminate();
        throw new Error('Plugin backend failed during startup');
      }
      const handshake = object(
        (
          await instance.peer.request(
            'handshake',
            {
              apiVersion: 1,
              runtimeRole,
              features: [
                'document.transactions',
                'history',
                'hooks',
                'runtime.roles',
                'resources.local',
                'commands.tasks',
              ],
              pluginId: id,
              hostVersion: APP_VERSION,
              platform: kind,
              permissions: plugin.manifest.permissions ?? [],
            },
            { timeout: 5000, signal: instance.activationController.signal },
          )
        ).result,
      );
      if (handshake.apiVersion !== 1 || handshake.pluginId !== id)
        throw new Error('Plugin handshake returned an incompatible identity or API version');
      await instance.peer.request(
        'activate',
        { config: plugin.config, runtimeRole },
        { timeout: 15000, signal: instance.activationController.signal },
      );
      if (instances.get(id) !== instance) throw new Error('Plugin activation was superseded');
      if (runtimeRole === 'main') {
        this.update(id, { state: 'active' });
        for (const pending of this.pendingActivationEvents.get(id) ?? [])
          this.deliver(instance.peer, instance.events, id, pending.event, pending.data);
        this.pendingActivationEvents.delete(id);
      } else this.update(id, { hooksState: 'ready' });
    } catch (error) {
      await this.failed(id, instance, error);
      throw error;
    }
  }
  private ensureActivated(id: string) {
    if (this.exitPaused) return Promise.reject(new RpcError('exit_preparing', '正在准备退出'));
    if (this.stopping.has(id)) return Promise.reject(new Error('Plugin is stopping'));
    if (this.plugin(id).state === 'active') return Promise.resolve();
    const pending = this.activations.get(id);
    if (pending) return pending;
    const activation = this.serial(id, async () => {
      if (!this.plugin(id).enabled) throw new Error('Plugin is disabled');
      if (this.stopping.has(id)) throw new Error('Plugin is stopping');
      if (this.plugin(id).state !== 'active') await this.activate(id);
    });
    this.activations.set(id, activation);
    void activation
      .finally(() => {
        if (this.activations.get(id) === activation) this.activations.delete(id);
      })
      .catch(() => {});
    return activation;
  }
  private hookReadAllowed(method: string) {
    return [
      'hooks.register',
      'hooks.unregister',
      'config.get',
      'log',
      'resources.read',
      'document.read',
      'document.images.list',
      'document.images.get',
      'document.images.read',
      'document.markers.list',
      'document.markers.get',
      'document.translations.get',
      'document.assistance.get',
      'history.list',
      'events.unsubscribe',
    ].includes(method);
  }
  private checkEventPermission(id: string, event: string) {
    const permissions = this.plugin(id).manifest.permissions ?? [];
    const required =
      event === 'history.changed'
        ? ['document.read', 'history.read']
        : /^(image\.|images\.|marker\.|markers\.|translation\.|assistance\.|document\.|transaction\.|project\.)/.test(
              event,
            )
          ? ['document.read']
          : [];
    for (const permission of required)
      if (!permissions.includes(permission))
        throw new RpcError('permission', `Plugin has not declared ${permission}`);
  }
  private checkDomainPermission(id: string, method: string) {
    const permissions = this.plugin(id).manifest.permissions ?? [];
    if (method === 'document.images.read' && !permissions.includes('document.read'))
      throw new RpcError('permission', 'Plugin has not declared document.read');
    const required =
      method === 'history.push'
        ? 'document.write'
        : method === 'history.list'
          ? 'history.read'
          : method.startsWith('history.')
            ? 'history.control'
            : method.startsWith('document.images.')
              ? ['list', 'get'].includes(method.split('.').at(-1)!)
                ? 'document.read'
                : method.endsWith('.read')
                  ? 'images.read'
                  : 'images.write'
              : ['get', 'list'].includes(method.split('.').at(-1)!)
                ? 'document.read'
                : 'document.write';
    if (!permissions.includes(required))
      throw new RpcError('permission', `Plugin has not declared ${required}`);
  }
  private warmHooks(id: string): Promise<void> {
    if (this.exitPaused) return Promise.resolve();
    const plugin = this.plugin(id);
    if (
      !plugin.enabled ||
      !plugin.manifest.contributes.beforeCommitHooks?.length ||
      !plugin.manifest.permissions?.includes('document.intercept') ||
      plugin.hooksState === 'paused' ||
      plugin.hooksState === 'ready'
    )
      return Promise.resolve();
    const pending = this.hookActivations.get(id);
    if (pending) return pending;
    const activation = this.activate(id, 'hooks')
      .catch(() => {})
      .finally(() => {
        if (this.hookActivations.get(id) === activation) this.hookActivations.delete(id);
      });
    this.hookActivations.set(id, activation);
    return activation;
  }
  private async stopHooks(id: string) {
    await this.hookCleanups.get(id);
    const instance = this.hookInstances.get(id);
    if (!instance) {
      this.update(id, { hooksState: 'inactive', hooksError: undefined });
      return;
    }
    this.update(id, { hooksState: 'inactive' });
    instance.activationController.abort();
    try {
      await instance.peer.request('deactivate', null, { timeout: 1000 });
    } catch {
      /* Forced shutdown. */
    }
    if (this.hookInstances.get(id) === instance) this.hookInstances.delete(id);
    instance.peer.close();
    await instance.backend?.terminate().catch(() => {});
    await this.host.releaseInstance?.(id, instance.instanceId);
    await this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
    this.update(id, { hooksState: 'inactive', hooksError: undefined });
  }
  private async pauseHooks(id: string, instance: Instance, error: unknown) {
    if (this.hookInstances.get(id) !== instance) return;
    this.hookInstances.delete(id);
    instance.activationController.abort();
    void this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
    instance.peer.close(new RpcError('hooks_paused', errorMessage(error)));
    this.update(id, { hooksState: 'paused', hooksError: errorMessage(error) });
    this.log(id, 'warn', `Interception paused: ${errorMessage(error)}`);
    const cleanup = (async () => {
      await instance.backend?.terminate().catch(() => {});
      await this.host.releaseInstance?.(id, instance.instanceId);
      await this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
    })().catch(() => {});
    this.hookCleanups.set(id, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.hookCleanups.get(id) === cleanup) this.hookCleanups.delete(id);
    }
  }
  /** Resume interception without interrupting the provider instance. */
  resumeHooks(id: string) {
    return this.serial(id, async () => {
      if (!this.plugin(id).enabled || this.stopping.has(id)) throw new Error('Plugin is disabled');
      await this.stopHooks(id);
      await this.warmHooks(id);
    });
  }

  intercept(proposal: PluginMutationProposal): Promise<PluginOperation[]> {
    const captured = structuredClone(proposal);
    const run = this.interceptionTail.catch(() => {}).then(() => this.interceptNow(captured));
    this.interceptionTail = run;
    return run;
  }
  private async interceptNow(proposal: PluginMutationProposal): Promise<PluginOperation[]> {
    let operations = structuredClone(proposal.operations);
    const deadline = performance.now() + 1000;
    const hooks = this.value.plugins
      .filter((plugin) => plugin.enabled && plugin.hooksState === 'ready')
      .flatMap((plugin) =>
        [...(this.hookInstances.get(plugin.manifest.id)?.hooks.values() ?? [])].map((hook) => ({
          pluginId: plugin.manifest.id,
          hook,
        })),
      )
      .sort(
        (left, right) =>
          (left.hook.priority ?? 0) - (right.hook.priority ?? 0) ||
          compareIds(left.pluginId, right.pluginId) ||
          compareIds(left.hook.id, right.hook.id),
      );
    for (const { pluginId, hook } of hooks) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const instance = this.hookInstances.get(pluginId);
      if (
        !instance ||
        this.plugin(pluginId).hooksState !== 'ready' ||
        !this.plugin(pluginId).enabled
      )
        continue;
      if (
        hook.operations?.length &&
        !operations.some((operation) => hook.operations!.includes(operation.type))
      )
        continue;
      instance.proposal = { ...proposal, operations };
      const hookDeadline = performance.now() + Math.min(250, remaining);
      try {
        const response = object(
          (
            await instance.peer.request(
              'hooks.beforeCommit',
              {
                hookId: hook.id,
                proposal: instance.proposal as unknown as JsonValue,
              },
              {
                timeout: Math.max(1, Math.min(250, remaining)),
                signal: instance.activationController.signal,
              },
            )
          ).result,
        );
        if (this.hookInstances.get(pluginId) !== instance) continue;
        if (performance.now() > hookDeadline)
          throw new RpcError('timeout', 'Before commit hook exceeded its deadline');
        if (response.action === 'reject') {
          if (typeof response.reason !== 'string')
            throw new RpcError('invalid_hook', 'Reject requires a reason');
          throw new HookRejected(response.reason);
        }
        if (response.action === 'replace') {
          if (Object.keys(response).some((key) => !['action', 'operations'].includes(key)))
            throw new RpcError('invalid_hook', 'Hooks may only replace the operation array');
          if (!Array.isArray(response.operations))
            throw new RpcError('invalid_hook', 'Replacement requires operations');
          const replacement = response.operations as unknown as PluginOperation[];
          if (!this.host.validateOperations)
            throw new RpcError('unsupported', 'Host cannot validate hook rewrites');
          let validationTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.host.validateOperations(pluginId, instance.proposal, replacement),
              new Promise<never>((_resolve, reject) => {
                validationTimer = setTimeout(
                  () => reject(new RpcError('timeout', 'Hook rewrite validation timed out')),
                  Math.max(1, hookDeadline - performance.now()),
                );
              }),
            ]);
          } finally {
            clearTimeout(validationTimer);
          }
          if (this.hookInstances.get(pluginId) !== instance) continue;
          if (performance.now() > hookDeadline)
            throw new RpcError('timeout', 'Hook rewrite validation exceeded its deadline');
          operations = structuredClone(replacement);
        } else if (response.action !== 'continue')
          throw new RpcError('invalid_hook', 'Unknown beforeCommit result');
      } catch (error) {
        if (error instanceof HookRejected) throw error;
        void this.pauseHooks(pluginId, instance, error).catch(() => {});
      } finally {
        instance.proposal = undefined;
      }
    }
    return operations;
  }
  private async failed(id: string, instance: Instance, error: unknown) {
    if (instance.runtimeRole === 'hooks') {
      await this.pauseHooks(id, instance, error);
      return;
    }
    if (this.instances.get(id) !== instance) return;
    if (this.stopping.has(id)) return;
    this.instances.delete(id);
    this.pendingActivationEvents.delete(id);
    await this.host.releaseInstance?.(id, instance.instanceId);
    await this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
    instance.peer.close(new RpcError('plugin_failed', errorMessage(error)));
    this.interruptCommands(id, `插件连接已中断：${errorMessage(error)}`);
    this.cancelOwned(id);
    this.closeOwnedPanels(id);
    this.update(id, { state: 'failed', error: errorMessage(error) });
    this.log(id, 'error', errorMessage(error));
    await instance.backend?.terminate().catch(() => {});
  }
  private requestStop(id: string) {
    this.plugin(id);
    this.desiredEnabled.set(id, false);
    this.stopping.add(id);
    this.interruptCommands(id, '插件已停用');
    this.cancelOwned(id);
    this.closeOwnedPanels(id);
    const instance = this.instances.get(id);
    if (instance) void this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
    this.update(id, { enabled: false, state: 'deactivating' });
    instance?.activationController.abort();
    this.hookInstances.get(id)?.activationController.abort();
  }
  private async deactivate(id: string) {
    await this.stopHooks(id);
    this.pendingActivationEvents.delete(id);
    const instance = this.instances.get(id);
    this.cancelOwned(id);
    this.closeOwnedPanels(id);
    if (!instance) {
      this.update(id, { state: 'inactive', backend: null, error: undefined });
      return;
    }
    this.update(id, { state: 'deactivating' });
    try {
      await instance.peer.request('deactivate', null, { timeout: 5000 });
    } catch (error) {
      this.log(id, 'warn', `Forced plugin shutdown: ${errorMessage(error)}`);
    } finally {
      if (this.instances.get(id) === instance) this.instances.delete(id);
      instance.peer.close();
      await this.host.releaseInstance?.(id, instance.instanceId);
      await this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
      await instance.backend?.terminate().catch(() => {});
      this.update(id, { state: 'inactive', backend: null, error: undefined });
    }
  }
  private cancelOwned(id: string) {
    for (const task of this.value.tasks)
      if (task.pluginId === id && task.state === 'running')
        this.taskControllers.get(task.id)?.abort();
    for (const controller of this.modelControllers.get(id) ?? []) controller.abort();
    this.modelControllers.delete(id);
  }
  updateConfig(id: string, patch: Record<string, JsonValue>): Promise<void> {
    if (this.exitPaused) return Promise.reject(new RpcError('exit_preparing', '正在准备退出'));
    const write = (this.configTails.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const plugin = this.plugin(id);
        const config = { ...plugin.config, ...patch };
        validateConfig(plugin.manifest, config);
        await this.storage.update(id, { config });
        this.update(id, { config });
        this.instances.get(id)?.peer.emit('config.changed', config);
        this.hookInstances.get(id)?.peer.emit('config.changed', config);
        for (const connection of this.panelConnections.get(id) ?? [])
          connection.peer.emit('config.changed', config);
      });
    this.configTails.set(id, write);
    void write
      .finally(() => {
        if (this.configTails.get(id) === write) this.configTails.delete(id);
      })
      .catch(() => {});
    return write;
  }
  providers(kind: 'ocr' | 'translation') {
    return this.value.providers.filter((entry) => entry.kind === kind);
  }
  runOcr(
    providerId: string,
    input: Record<string, JsonValue>,
    image: ArrayBuffer,
    options: TaskOptions = {},
  ) {
    return this.run('ocr', providerId, input, options, image);
  }
  translate(providerId: string, input: Record<string, JsonValue>, options: TaskOptions = {}) {
    return this.run('translation', providerId, input, options);
  }
  private async run(
    kind: 'ocr' | 'translation',
    providerId: string,
    input: JsonValue,
    options: TaskOptions,
    binary?: ArrayBuffer,
  ): Promise<JsonValue> {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const provider = this.providers(kind).find((entry) => entry.id === providerId);
    if (!provider) throw new Error('Provider is not enabled');
    await this.waitForActivation(this.ensureActivated(provider.pluginId), options.signal);
    if (!this.instances.get(provider.pluginId)?.providers.has(`${kind}/${provider.info.id}`))
      throw new Error('Plugin did not register its declared provider');
    const instance = this.instances.get(provider.pluginId)!;
    const taskId = newId();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.taskControllers.set(taskId, controller);
    if (options.onProgress) this.progressCallbacks.set(taskId, options.onProgress);
    this.store.update((state) => ({
      ...state,
      tasks: [
        ...state.tasks
          .filter((task) => task.state === 'running')
          .concat(state.tasks.filter((task) => task.state !== 'running').slice(-49)),
        {
          id: taskId,
          pluginId: provider.pluginId,
          providerId,
          kind,
          state: 'running',
          progress: null,
        },
      ],
    }));
    const queueKey = kind === 'ocr' ? `ocr:${provider.pluginId}` : `translation:${providerId}`;
    const previous = this.providerTails.get(queueKey) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (
          this.instances.get(provider.pluginId) !== instance ||
          this.plugin(provider.pluginId).state !== 'active'
        )
          throw new Error('Plugin instance has changed');
        return (
          await instance.peer.request(
            kind === 'ocr' ? 'ocr.recognize' : 'translation.translate',
            { providerId: provider.info.id, input, taskId },
            { binary: binary?.slice(0), signal: controller.signal, timeout: 0 },
          )
        ).result;
      });
    this.providerTails.set(queueKey, task);
    try {
      const result = await task;
      if (controller.signal.aborted || this.instances.get(provider.pluginId) !== instance)
        throw new DOMException('Cancelled', 'AbortError');
      this.taskUpdate(taskId, { state: 'completed' });
      return result;
    } catch (error) {
      this.taskUpdate(taskId, {
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        error: errorMessage(error),
      });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.taskControllers.delete(taskId);
      this.progressCallbacks.delete(taskId);
      if (this.providerTails.get(queueKey) === task) this.providerTails.delete(queueKey);
    }
  }
  private waitForActivation<T>(activation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return activation;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      activation.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (!signal.aborted) resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  cancelTask(id: string) {
    this.taskControllers.get(id)?.abort();
  }
  private taskUpdate(id: string, patch: Partial<ManagerView['tasks'][number]>) {
    this.store.update((state) => ({
      ...state,
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    }));
  }
  executeCommand(qualifiedId: string, params: JsonValue = null) {
    return this.dispatchCommand(qualifiedId, params);
  }
  runUserCommand(
    qualifiedId: string,
    params: JsonValue = null,
    source: 'manager' | 'menu' = 'manager',
  ): Promise<JsonValue> {
    if (this.exitPaused) return Promise.reject(new RpcError('exit_preparing', '正在准备退出'));
    const command = this.value.commands.find((entry) => entry.id === qualifiedId);
    if (!command || this.disposed)
      return Promise.reject(new Error('Plugin command is not enabled'));
    if (
      this.value.commandRuns.some((run) => run.pluginId === command.pluginId && commandPending(run))
    )
      return Promise.reject(new Error('该插件已有命令正在执行'));
    const run: PluginCommandRun = {
      id: newId(),
      pluginId: command.pluginId,
      commandId: qualifiedId,
      title: command.info.title,
      source,
      state: 'queued',
      progress: null,
      startedAt: Date.now(),
    };
    this.store.update((state) => ({
      ...state,
      commandRuns: [...state.commandRuns.filter((entry) => entry.pluginId !== run.pluginId), run],
      commandNotice:
        source === 'menu' ? { runId: run.id, pluginId: run.pluginId } : state.commandNotice,
    }));
    return this.dispatchCommand(qualifiedId, params, run.id);
  }
  cancelUserCommand(runId: string) {
    const execution = this.commandExecutions.get(runId);
    const run = this.value.commandRuns.find((entry) => entry.id === runId);
    if (!execution || !run || !commandPending(run)) return;
    this.commandUpdate(runId, { state: 'cancelling' });
    execution.controller.abort();
  }
  dismissCommandNotice() {
    this.store.update((state) => ({ ...state, commandNotice: null }));
  }
  private commandUpdate(runId: string | undefined, patch: Partial<PluginCommandRun>) {
    if (!runId) return;
    this.store.update((state) => ({
      ...state,
      commandRuns: state.commandRuns.map((run) => (run.id === runId ? { ...run, ...patch } : run)),
    }));
  }
  private interruptCommands(pluginId: string, reason: string) {
    this.commandEpochs.set(pluginId, (this.commandEpochs.get(pluginId) ?? 0) + 1);
    for (const execution of this.commandExecutions.values()) {
      if (execution.pluginId !== pluginId) continue;
      execution.interrupted = true;
      execution.interruption = new RpcError('interrupted', reason);
      this.commandUpdate(execution.runId, {
        state: 'interrupted',
        error: reason,
        finishedAt: Date.now(),
      });
      execution.controller.abort();
    }
  }
  private dispatchCommand(
    qualifiedId: string,
    params: JsonValue,
    runId?: string,
  ): Promise<JsonValue> {
    const command = this.value.commands.find((entry) => entry.id === qualifiedId);
    if (!command || this.disposed)
      return Promise.reject(new Error('Plugin command is not enabled'));
    const execution: CommandExecution = {
      id: runId ?? newId(),
      pluginId: command.pluginId,
      runId,
      epoch: this.commandEpochs.get(command.pluginId) ?? 0,
      controller: new AbortController(),
      interrupted: false,
    };
    this.commandExecutions.set(execution.id, execution);
    const signal = execution.controller.signal;
    const previous = this.commandTails.get(command.pluginId) ?? Promise.resolve();
    const operation = (async () => {
      try {
        await this.waitForActivation(previous, signal);
        signal.throwIfAborted();
        if (execution.epoch !== (this.commandEpochs.get(command.pluginId) ?? 0))
          throw new RpcError('stale_instance', 'Plugin command belongs to an earlier activation');
        this.commandUpdate(runId, { state: 'activating' });
        await this.waitForActivation(this.ensureActivated(command.pluginId), signal);
        signal.throwIfAborted();
        const instance = this.instances.get(command.pluginId);
        if (!instance?.commands.has(command.info.id))
          throw new Error('Plugin did not register its declared command');
        execution.instance = instance;
        this.commandUpdate(runId, { state: 'running' });
        execution.request = instance.peer.requestControlled('commands.execute', {
          commandId: command.info.id,
          params,
          taskId: execution.id,
        });
        const cancel = () => execution.request?.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        let result: JsonValue;
        try {
          result = (await execution.request.result).result;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
        signal.throwIfAborted();
        if (this.instances.get(command.pluginId) !== instance || execution.interrupted)
          throw new RpcError('stale_instance', 'Plugin command instance has changed');
        this.commandUpdate(runId, {
          state: 'completed',
          result,
          summary: execution.summary,
          finishedAt: Date.now(),
        });
        return result;
      } catch (error) {
        if (execution.interrupted) {
          // Stop/failure already recorded the concrete interruption; do not turn it into a success/cancel.
        } else if (signal.aborted) {
          this.commandUpdate(runId, {
            state: 'cancelled',
            summary: undefined,
            finishedAt: Date.now(),
          });
        } else {
          this.commandUpdate(runId, {
            state: 'failed',
            summary: undefined,
            error: errorMessage(error),
            finishedAt: Date.now(),
          });
        }
        throw execution.interruption ?? error;
      } finally {
        this.commandExecutions.delete(execution.id);
      }
    })();
    // A cancelled queued call may finish early, but it must never let successors overtake the active call.
    const drained = Promise.allSettled([previous, operation]).then(() => {});
    this.commandTails.set(command.pluginId, drained);
    void drained.then(() => {
      if (this.commandTails.get(command.pluginId) === drained)
        this.commandTails.delete(command.pluginId);
    });
    return operation;
  }
  private availablePanel(pluginId: string, panelId: string) {
    const panel = this.value.panels.find(
      (panel) => panel.pluginId === pluginId && panel.info.id === panelId,
    );
    if (this.disposed || !panel) throw new Error('Plugin panel is not available');
    return panel;
  }
  async preparePanel(pluginId: string, panelId: string) {
    this.availablePanel(pluginId, panelId);
    await this.ensureActivated(pluginId);
    this.availablePanel(pluginId, panelId);
  }
  private revealPanel(pluginId: string, panelId: string) {
    const panel = this.availablePanel(pluginId, panelId);
    if (panel.info.location === 'bottom') this.onBottomPanelOpen?.({ pluginId, panelId });
    else this.store.update((state) => ({ ...state, activePanel: { pluginId, panelId } }));
  }
  async openPanel(pluginId: string, panelId: string) {
    if (this.availablePanel(pluginId, panelId).info.location === 'bottom') {
      // Reveal before activation so failures stay visible and activation may open its own tab.
      this.revealPanel(pluginId, panelId);
      return;
    }
    await this.preparePanel(pluginId, panelId);
    this.revealPanel(pluginId, panelId);
  }
  closePanel() {
    this.store.update((state) => ({ ...state, activePanel: null }));
  }
  async getPanelHtml(pluginId: string, panelId: string) {
    const panel = this.plugin(pluginId).manifest.contributes.panels?.find(
      (entry) => entry.id === panelId,
    );
    if (!panel) throw new Error('Unknown plugin panel');
    return new TextDecoder().decode(await this.storage.read(pluginId, panel.entry));
  }
  connectPanel(pluginId: string, port: MessagePort) {
    const instance = this.instances.get(pluginId);
    if (!instance || this.plugin(pluginId).state !== 'active')
      throw new Error('Plugin is not active');
    const events = new Map<string, EventListener>();
    const owner = `${instance.instanceId}:panel:${newId()}`;
    let closed = false;
    const peer = new RpcPeer(
      (packet) => port.postMessage(packet, packet.binary ? [packet.binary] : []),
      async (method, params, binary) => {
        if (
          closed ||
          this.instances.get(pluginId) !== instance ||
          this.plugin(pluginId).state !== 'active'
        )
          throw new Error('Plugin panel is no longer active');
        const args = object(params);
        if (method === 'events.subscribe') {
          const event = String(args.event);
          this.checkEventPermission(pluginId, event);
          events.set(String(args.subscriptionId ?? event), {
            event,
            options: object(args.options ?? null) as EventSubscriptionOptions,
          });
          if (
            this.lastEvents.has(event) &&
            this.accepts(events, pluginId, event, this.lastEvents.get(event)!)
          )
            queueMicrotask(() =>
              this.deliver(
                peer,
                events,
                pluginId,
                event,
                this.lastEvents.get(event)!,
                String(args.subscriptionId ?? event),
              ),
            );
          return { result: null };
        }
        if (method === 'events.unsubscribe') {
          events.delete(String(args.subscriptionId ?? args.event));
          return { result: null };
        }
        if (method === 'commands.execute')
          return {
            result: await this.executeCommand(
              `${pluginId}/${String(args.commandId)}`,
              args.params ?? null,
            ),
          };
        if (
          [
            'providers.register',
            'providers.unregister',
            'commands.register',
            'commands.unregister',
            'hooks.register',
            'hooks.unregister',
          ].includes(method)
        )
          throw new Error('Panels cannot register executable capabilities');
        return this.hostCall(pluginId, instance, method, params, binary, owner);
      },
      (event) => {
        if (event === '$panel.close') connection.close();
      },
    );
    const connection = {
      peer,
      events,
      close: () => {
        if (closed) return;
        closed = true;
        connections.delete(connection);
        void this.localResources.releaseOwner(pluginId, owner).catch(() => {});
        peer.close();
        port.close();
      },
    };
    const connections = this.panelConnections.get(pluginId) ?? new Set();
    connections.add(connection);
    this.panelConnections.set(pluginId, connections);
    port.onmessage = (event) => {
      void peer.receive(event.data).catch(() => connection.close());
    };
    port.onmessageerror = () => connection.close();
    port.start();
    return () => {
      connection.close();
      connections.delete(connection);
    };
  }
  private closeOwnedPanels(pluginId: string) {
    for (const connection of this.panelConnections.get(pluginId) ?? []) connection.close();
    this.panelConnections.delete(pluginId);
    if (this.value.activePanel?.pluginId === pluginId) this.closePanel();
  }
  private accepts(
    listeners: Map<string, EventListener>,
    pluginId: string,
    event: string,
    data: JsonValue,
  ) {
    const value = object(data);
    const origin = object(value.origin ?? value.source ?? null);
    return [...listeners.values()].some(
      (listener) =>
        listener.event === event &&
        (!listener.options.projectId || listener.options.projectId === value.projectId) &&
        (listener.options.includeSelf === true ||
          (origin.pluginId !== pluginId && value.pluginId !== pluginId)),
    );
  }
  private deliver(
    peer: RpcPeer,
    listeners: Map<string, EventListener>,
    pluginId: string,
    event: string,
    data: JsonValue,
    onlyId?: string,
  ) {
    for (const [subscriptionId, listener] of listeners) {
      if (onlyId !== undefined && subscriptionId !== onlyId) continue;
      if (!this.accepts(new Map([[subscriptionId, listener]]), pluginId, event, data)) continue;
      if (subscriptionId === event) peer.emit(event, data);
      else peer.emit('$subscription', { subscriptionId, event, data });
    }
  }
  emit(event: string, data: JsonValue) {
    // Only state notifications replay. Mutation events describe a specific confirmed transaction.
    const replay = ['context.changed', 'config.changed'].includes(event);
    if (replay) this.lastEvents.set(event, data);
    if (this.exitPaused) return;
    for (const plugin of this.value.plugins) {
      if (
        plugin.enabled &&
        !['active', 'failed', 'deactivating'].includes(plugin.state) &&
        plugin.manifest.activationEvents?.includes(`event:${event}`)
      ) {
        if (!replay) {
          const pending = this.pendingActivationEvents.get(plugin.manifest.id) ?? [];
          pending.push({ event, data });
          this.pendingActivationEvents.set(plugin.manifest.id, pending);
        }
        void this.ensureActivated(plugin.manifest.id).catch(() =>
          this.pendingActivationEvents.delete(plugin.manifest.id),
        );
      }
    }
    for (const [id, instance] of this.instances)
      if (this.plugin(id).state === 'active' && this.accepts(instance.events, id, event, data))
        this.deliver(instance.peer, instance.events, id, event, data);
    for (const [id, connections] of this.panelConnections)
      for (const connection of connections)
        this.deliver(connection.peer, connection.events, id, event, data);
  }
  private onPluginEvent(id: string, instance: Instance, event: string, data: JsonValue) {
    if (
      (instance.runtimeRole === 'hooks' ? this.hookInstances : this.instances).get(id) !== instance
    )
      return;
    const args = object(data);
    if (event === 'task.progress') {
      const taskId = String(args.taskId);
      const task = this.value.tasks.find(
        (entry) => entry.id === taskId && entry.pluginId === id && entry.state === 'running',
      );
      if (task && !this.taskControllers.get(taskId)?.signal.aborted) {
        this.taskUpdate(taskId, { progress: args.progress ?? null });
        this.progressCallbacks.get(taskId)?.(args.progress ?? null);
      }
      const execution = this.commandExecutions.get(taskId);
      if (
        execution?.pluginId === id &&
        execution.instance === instance &&
        !execution.controller.signal.aborted
      )
        this.commandUpdate(execution.runId, { progress: args.progress ?? null });
    } else if (event === 'task.summary') {
      const execution = this.commandExecutions.get(String(args.taskId));
      if (
        execution?.pluginId === id &&
        execution.instance === instance &&
        !execution.controller.signal.aborted &&
        typeof args.message === 'string'
      )
        execution.summary = args.message.slice(0, 8192);
    } else if (event === 'log')
      this.log(id, String(args.level ?? 'info'), String(args.message ?? ''));
  }
  private async hostCall(
    id: string,
    instance: Instance,
    method: string,
    params: JsonValue,
    binary?: ArrayBuffer,
    resourceOwner = instance.instanceId,
  ): Promise<RpcResult> {
    if (
      (instance.runtimeRole === 'hooks' ? this.hookInstances : this.instances).get(id) !== instance
    )
      throw new RpcError('stale_instance', 'Plugin instance is no longer current');
    const plugin = this.plugin(id);
    const args = object(params);
    if (
      this.exitPaused &&
      !this.hookReadAllowed(method) &&
      ![
        'providers.unregister',
        'commands.unregister',
        'resources.local.abortImport',
        'resources.local.list',
        'resources.local.read',
      ].includes(method)
    )
      throw new RpcError('exit_preparing', '正在准备退出，插件写入已暂停');
    if (
      plugin.state === 'deactivating' &&
      ![
        'providers.unregister',
        'commands.unregister',
        'hooks.unregister',
        'events.unsubscribe',
        'log',
      ].includes(method)
    )
      throw new RpcError('stopping', 'Plugin is stopping');
    if (instance.runtimeRole === 'hooks' && !this.hookReadAllowed(method))
      throw new RpcError(
        'hook_readonly',
        'Hook runtimes may only read committed state and return proposals',
      );
    if (method === 'hooks.register') {
      if (
        instance.runtimeRole !== 'hooks' ||
        !plugin.manifest.permissions?.includes('document.intercept')
      )
        throw new RpcError('permission', 'Hooks require document.intercept in a hooks runtime');
      const info = object(args.info ?? null);
      const declaration = plugin.manifest.contributes.beforeCommitHooks?.find(
        (hook) => hook.id === info.id,
      );
      if (!declaration || instance.hooks.has(declaration.id))
        throw new RpcError('invalid_hook', 'Hook is undeclared or already registered');
      instance.hooks.set(declaration.id, declaration);
      return { result: null };
    }
    if (method === 'hooks.unregister') {
      instance.hooks.delete(String(args.id));
      return { result: null };
    }
    if (method === 'providers.register') {
      if (plugin.state !== 'activating' && plugin.state !== 'active')
        throw new Error('Plugin is stopping');
      const kind = args.kind;
      if (kind !== 'ocr' && kind !== 'translation') throw new Error('Unsupported provider kind');
      const info = object(args.info ?? null);
      const declaration = plugin.manifest.contributes[kind]?.find((entry) => entry.id === info.id);
      if (!declaration) throw new Error('Provider was not declared in plugin.json');
      const key = `${kind}/${declaration.id}`;
      if (instance.providers.has(key)) throw new Error('Provider is already registered');
      instance.providers.set(key, {
        id: `${id}/${declaration.id}`,
        pluginId: id,
        kind,
        info: declaration,
      });
      this.publish();
      return { result: null };
    }
    if (method === 'providers.unregister') {
      instance.providers.delete(`${String(args.kind)}/${String(args.id)}`);
      this.publish();
      return { result: null };
    }
    if (method === 'commands.register') {
      if (plugin.state !== 'activating' && plugin.state !== 'active')
        throw new Error('Plugin is stopping');
      const info = object(args.info ?? null);
      const declaration = plugin.manifest.contributes.commands?.find(
        (entry) => entry.id === info.id,
      );
      if (!declaration || instance.commands.has(declaration.id))
        throw new Error('Command is undeclared or already registered');
      instance.commands.set(declaration.id, declaration);
      this.publish();
      return { result: null };
    }
    if (method === 'commands.unregister') {
      instance.commands.delete(String(args.id));
      this.publish();
      return { result: null };
    }
    if (method === 'config.get') return { result: plugin.config };
    if (method === 'config.update') {
      await this.updateConfig(id, args);
      return { result: null };
    }
    if (method === 'resources.read')
      return { result: null, binary: await this.storage.read(id, resourcePath(String(args.path))) };
    if (method.startsWith('resources.local.')) {
      const operation = method.slice('resources.local.'.length);
      const permission = ['list', 'read'].includes(operation)
        ? 'resources.local.read'
        : 'resources.local.write';
      if (!plugin.manifest.permissions?.includes(permission))
        throw new RpcError('permission', `Plugin has not declared ${permission}`);
      const text = (key: string) => {
        if (typeof args[key] !== 'string' || !args[key])
          throw new RpcError('invalid_params', `Missing ${key}`);
        return args[key] as string;
      };
      switch (operation) {
        case 'beginImport':
          return {
            result: await this.localResources.beginImport(
              id,
              resourceOwner,
              args as unknown as PluginLocalResourceImport,
            ),
          };
        case 'writeChunk': {
          const token = text('token');
          if (
            typeof args.offset !== 'number' ||
            !Number.isSafeInteger(args.offset) ||
            args.offset < 0 ||
            !binary
          ) {
            await this.localResources.abortImport(id, resourceOwner, token).catch(() => {});
            throw new RpcError('invalid_params', 'Invalid resource chunk');
          }
          await this.localResources.writeChunk(
            id,
            resourceOwner,
            token,
            text('path'),
            args.offset,
            binary,
          );
          return { result: null };
        }
        case 'commitImport':
          return {
            result: await this.localResources.commitImport(id, resourceOwner, text('token')),
          };
        case 'abortImport':
          await this.localResources.abortImport(id, resourceOwner, text('token'));
          return { result: null };
        case 'list':
          return { result: await this.localResources.list(id) };
        case 'read':
          return {
            result: null,
            binary: await this.localResources.read(id, text('id'), text('path')),
          };
        case 'remove':
          await this.localResources.remove(id, text('id'));
          return { result: null };
        default:
          throw new RpcError('unsupported', 'Unknown local resource operation');
      }
    }
    if (method === 'resources.fetch')
      return {
        result: null,
        binary: await this.fetchResource(
          id,
          String(args.url),
          typeof args.sha256 === 'string' ? args.sha256 : undefined,
        ),
      };
    if (
      (method.startsWith('document.') && !['document.read', 'document.apply'].includes(method)) ||
      method.startsWith('history.')
    ) {
      this.checkDomainPermission(id, method);
      if (!this.host.call)
        throw new RpcError('unsupported', 'Host does not support document operations');
      const result = await this.host.call(id, method, params, binary, {
        runtimeRole: instance.runtimeRole,
        instanceId: instance.instanceId,
        ...(instance.proposal ? { proposal: instance.proposal } : {}),
      });
      if (
        (instance.runtimeRole === 'hooks' ? this.hookInstances : this.instances).get(id) !==
        instance
      ) {
        await this.host.releaseInstance?.(id, instance.instanceId);
        throw new RpcError(
          'stale_instance',
          'Plugin instance stopped while the host request was pending',
        );
      }
      return result;
    }
    if (method === 'document.read' || method === 'document.apply') {
      const permission = method === 'document.read' ? 'document.read' : 'document.write';
      if (!plugin.manifest.permissions?.includes(permission))
        throw new RpcError('permission', `Plugin has not declared ${permission}`);
      if (this.host.call)
        return this.host.call(id, method, params, binary, {
          runtimeRole: instance.runtimeRole,
          instanceId: instance.instanceId,
          ...(instance.proposal ? { proposal: instance.proposal } : {}),
        });
      return {
        result:
          method === 'document.read'
            ? await this.host.readDocument(id, params)
            : await this.host.applyDocument(id, params),
      };
    }
    if (method === 'events.subscribe') {
      const name = String(args.event);
      this.checkEventPermission(id, name);
      instance.events.set(String(args.subscriptionId ?? name), {
        event: name,
        options: object(args.options ?? null) as EventSubscriptionOptions,
      });
      if (
        this.lastEvents.has(name) &&
        this.accepts(instance.events, id, name, this.lastEvents.get(name)!)
      )
        queueMicrotask(() =>
          this.deliver(
            instance.peer,
            instance.events,
            id,
            name,
            this.lastEvents.get(name)!,
            String(args.subscriptionId ?? name),
          ),
        );
      return { result: null };
    }
    if (method === 'events.unsubscribe') {
      instance.events.delete(String(args.subscriptionId ?? args.event));
      return { result: null };
    }
    if (method === 'panels.open') {
      const panelId = String(args.panelId);
      // The calling instance may still be inside activate(); never await its own activation here.
      this.revealPanel(id, panelId);
      return { result: null };
    }
    if (method === 'log') {
      this.log(id, String(args.level ?? 'info'), String(args.message ?? ''));
      return { result: null };
    }
    throw new RpcError('unknown_host_method', `Unknown host method: ${method}`);
  }
  private log(pluginId: string, level: string, message: string) {
    this.store.update((state) => ({
      ...state,
      logs: [
        ...state.logs.slice(-199),
        { pluginId, level, message: message.slice(0, 8192), time: Date.now() },
      ],
    }));
  }
  private async fetchResource(id: string, source: string, sha256?: string): Promise<ArrayBuffer> {
    const url = new URL(source);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error('Model URLs must use HTTPS');
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Invalid SHA-256 hash');
    const controller = new AbortController();
    const controllers = this.modelControllers.get(id) ?? new Set();
    controllers.add(controller);
    this.modelControllers.set(id, controllers);
    try {
      const cache =
        typeof caches !== 'undefined'
          ? await caches.open(`bubblefish-plugin-models-${id}`)
          : undefined;
      const cacheKey = new URL(url);
      if (sha256) cacheKey.searchParams.set('__bf_sha256', sha256.toLowerCase());
      const cached = await cache?.match(cacheKey);
      const response =
        cached ?? (await fetch(url, { signal: controller.signal, credentials: 'omit' }));
      if (!response.ok) throw new Error(`Model download failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      if (sha256) {
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (digest !== sha256.toLowerCase()) {
          await cache?.delete(cacheKey);
          throw new Error('Model SHA-256 verification failed');
        }
      }
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!cached) await cache?.put(cacheKey, new Response(bytes));
      return bytes;
    } finally {
      controllers.delete(controller);
    }
  }
  /** Stop new work without disabling plugins or destroying their panel drafts. */
  async pauseForExit() {
    this.exitPaused = true;
    for (const plugin of this.value.plugins) {
      this.interruptCommands(plugin.manifest.id, '正在准备退出');
      this.cancelOwned(plugin.manifest.id);
    }
    await Promise.all([...this.configTails.values()]);
  }
  /** Native installation may have stopped children; web panels survive a cancelled preflight. */
  async resumeAfterExitFailure(nativeStopped = false) {
    if (this.disposed) return;
    if (nativeStopped) {
      for (const plugin of this.value.plugins) {
        const id = plugin.manifest.id;
        if (!this.desktop || !plugin.manifest.entrypoints.native?.[this.target]) continue;
        this.closeOwnedPanels(id);
        for (const instances of [this.instances, this.hookInstances]) {
          const instance = instances.get(id);
          if (!instance) continue;
          instances.delete(id);
          instance.activationController.abort();
          instance.peer.close(new RpcError('interrupted', '更新安装未完成，正在恢复插件'));
          await instance.backend?.terminate().catch(() => {});
          await this.host.releaseInstance?.(id, instance.instanceId);
          await this.localResources.releaseOwner(id, instance.instanceId).catch(() => {});
        }
        this.update(id, {
          state: 'inactive',
          backend: null,
          error: undefined,
          hooksState: 'inactive',
          hooksError: undefined,
        });
      }
    }
    this.exitPaused = false;
    await Promise.allSettled(
      this.value.plugins
        .filter((plugin) => plugin.enabled)
        .map(async (plugin) => {
          const id = plugin.manifest.id;
          await this.warmHooks(id);
          if (plugin.manifest.activationEvents?.includes('startup')) await this.ensureActivated(id);
        }),
    );
    const context = this.lastEvents.get('context.changed');
    if (context !== undefined) this.emit('context.changed', context);
  }
  async dispose() {
    this.disposed = true;
    for (const plugin of this.value.plugins) this.requestStop(plugin.manifest.id);
    await Promise.allSettled(
      this.value.plugins.map((plugin) =>
        this.serial(plugin.manifest.id, () => this.deactivate(plugin.manifest.id)),
      ),
    );
    this.store.update((state) => ({ ...state, commandRuns: [], commandNotice: null }));
  }
}
