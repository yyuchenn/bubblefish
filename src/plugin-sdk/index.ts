import type { JsonValue, PluginManifest, ProviderInfo, CommandInfo } from '../generated/plugins';
import { RpcPeer, RpcError, type RpcResult } from '../runtime/plugins/rpc';
import { createDocumentApi, createHistoryApi } from './document';
import { createLocalResourceApi, type LocalResourceApi } from './local-resources';
export type { LocalResourceApi } from './local-resources';
import type { PluginEvents } from './events';
export type { PluginEventMap, PluginEvents } from './events';
import type {
  BeforeCommitHookInfo,
  BeforeCommitHookResult,
  PluginMutationProposal,
} from '../generated/plugins';
import type { EventSubscriptionOptions, PluginRuntimeRole } from '../runtime/plugins/types';
import { object, newId } from '../runtime/plugins/types';
export type {
  JsonValue,
  ProviderInfo,
  CommandInfo,
  PluginCommandInvocation,
  PluginTaskProgress,
  PluginTaskSummary,
  PluginPanelAppearance,
  PluginPanelThemeTokens,
  PluginPanelColorScheme,
  PluginOperation,
  PluginTransaction,
  PluginMutationProposal,
  BeforeCommitHookInfo,
  BeforeCommitHookResult,
  PluginGeometry,
  PluginMarker,
  PluginMarkerStyle,
  PluginImage,
  PluginImageRegion,
  PluginImageRead,
  PluginStagedImage,
  PluginDocument,
  PluginRichText,
  PluginTranslation,
  PluginMutationOrigin,
  PluginHistoryEntry,
  PluginHistoryPage,
  PluginDocumentChangeEvent,
  PluginEventOptions,
  PluginRuntimeRole,
  PluginLocalResourceFile,
  PluginLocalResourceImport,
  PluginLocalResourceImportToken,
  PluginLocalResourceSet,
} from '../generated/plugins';
export interface Disposable {
  dispose(): void | Promise<void>;
}
export class Subscriptions extends Array<Disposable> {
  add<T extends Disposable>(disposable: T): T {
    if (!this.includes(disposable)) this.push(disposable);
    return disposable;
  }
}
export interface ProviderContext {
  signal: AbortSignal;
  progress(value: JsonValue): void;
}
export interface CommandContext extends ProviderContext {
  /** Human-readable completion summary; the original return value remains unchanged. */
  summary(message: string): void;
}
export type OcrHandler = (
  input: JsonValue,
  image: ArrayBuffer,
  context: ProviderContext,
) => Promise<JsonValue> | JsonValue;
export type TranslationHandler = (
  input: JsonValue,
  context: ProviderContext,
) => Promise<JsonValue> | JsonValue;
export type CommandHandler = (
  params: JsonValue,
  task: CommandContext,
) => Promise<JsonValue> | JsonValue;
export interface PluginContext {
  pluginId: string;
  runtimeRole: PluginRuntimeRole;
  subscriptions: Subscriptions;
  ocr: { register(info: ProviderInfo, handler: OcrHandler): Disposable };
  translation: { register(info: ProviderInfo, handler: TranslationHandler): Disposable };
  commands: { register(info: CommandInfo | string, handler: CommandHandler): Disposable };
  panels: { open(panelId: string): Promise<void> };
  events: PluginEvents;
  hooks: {
    beforeCommit: {
      register(
        info: BeforeCommitHookInfo | string,
        handler: (
          proposal: PluginMutationProposal,
          context: ProviderContext,
        ) => BeforeCommitHookResult | Promise<BeforeCommitHookResult>,
      ): Disposable;
    };
  };
  history: ReturnType<typeof createHistoryApi>;
  config: {
    get(): Promise<Record<string, JsonValue>>;
    update(patch: Record<string, JsonValue>): Promise<void>;
  };
  document: ReturnType<typeof createDocumentApi>;
  resources: {
    local: LocalResourceApi;
    read(path: string): Promise<ArrayBuffer>;
    url(path: string, mimeType?: string): Promise<string>;
    fetch(url: string, sha256?: string): Promise<ArrayBuffer>;
  };
  log(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
}
export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export function createPluginContext(
  peer: RpcPeer,
  manifest: PluginManifest,
  runtimeRole: PluginRuntimeRole = 'main',
) {
  const pending: Promise<unknown>[] = [];
  const track = (promise: Promise<unknown>) => {
    pending.push(promise);
    void promise.catch(() => {});
  };
  const ocr = new Map<string, OcrHandler>();
  const translation = new Map<string, TranslationHandler>();
  const commands = new Map<string, CommandHandler>();
  const listeners = new Map<
    string,
    {
      event: string;
      callback: (data: JsonValue) => unknown;
      options: EventSubscriptionOptions;
    }
  >();
  const hooks = new Map<
    string,
    (
      proposal: PluginMutationProposal,
      context: ProviderContext,
    ) => BeforeCommitHookResult | Promise<BeforeCommitHookResult>
  >();
  const requests = new Map<string, AbortController>();
  const subscriptions = new Subscriptions();
  const host = async (method: string, params: JsonValue = null) =>
    (await peer.request(method, params)).result;
  function register<T>(
    kind: 'ocr' | 'translation' | 'commands',
    info: ProviderInfo | CommandInfo,
    handler: T,
    map: Map<string, T>,
  ): Disposable {
    if (runtimeRole === 'hooks') return { dispose() {} };
    if (map.has(info.id)) throw new Error(`Duplicate ${kind} registration: ${info.id}`);
    map.set(info.id, handler);
    track(
      host(kind === 'commands' ? 'commands.register' : 'providers.register', {
        kind,
        info: info as unknown as JsonValue,
      }),
    );
    const disposable = {
      dispose() {
        if (map.delete(info.id))
          return host(kind === 'commands' ? 'commands.unregister' : 'providers.unregister', {
            kind,
            id: info.id,
          }).then(() => {});
      },
    };
    subscriptions.push(disposable);
    return disposable;
  }
  const context: PluginContext = {
    pluginId: manifest.id,
    runtimeRole,
    subscriptions,
    ocr: { register: (info, handler) => register('ocr', info, handler, ocr) },
    translation: {
      register: (info, handler) => register('translation', info, handler, translation),
    },
    commands: {
      register: (info, handler) => {
        const declaration =
          typeof info === 'string'
            ? manifest.contributes.commands?.find((entry) => entry.id === info)
            : info;
        if (!declaration) throw new Error(`Command is not declared: ${String(info)}`);
        return register('commands', declaration, handler, commands);
      },
    },
    panels: {
      open: async (panelId) => {
        await host('panels.open', { panelId });
      },
    },
    events: {
      subscribe(event, callback, options = {}) {
        if (runtimeRole === 'hooks') return { dispose() {} };
        const subscriptionId = newId();
        listeners.set(subscriptionId, {
          event,
          callback: callback as (data: JsonValue) => unknown,
          options,
        });
        track(host('events.subscribe', { event, subscriptionId, options: options as JsonValue }));
        const disposable = {
          dispose() {
            if (listeners.delete(subscriptionId))
              return host('events.unsubscribe', { event, subscriptionId }).then(() => {});
          },
        };
        subscriptions.push(disposable);
        return disposable;
      },
    },
    hooks: {
      beforeCommit: {
        register(info, handler) {
          const declaration =
            typeof info === 'string'
              ? manifest.contributes.beforeCommitHooks?.find((entry) => entry.id === info)
              : info;
          if (!declaration) throw new Error(`Hook is not declared: ${String(info)}`);
          if (runtimeRole !== 'hooks') return { dispose() {} };
          if (hooks.has(declaration.id)) throw new Error('Duplicate beforeCommit hook');
          hooks.set(declaration.id, handler);
          track(host('hooks.register', { info: declaration as JsonValue }));
          const disposable = {
            dispose() {
              if (hooks.delete(declaration.id))
                return host('hooks.unregister', { id: declaration.id }).then(() => {});
            },
          };
          subscriptions.push(disposable);
          return disposable;
        },
      },
    },
    history: createHistoryApi(peer),
    config: {
      get: async () => object(await host('config.get')),
      update: async (patch) => {
        await host('config.update', patch);
      },
    },
    document: createDocumentApi(peer),
    resources: {
      local: createLocalResourceApi(peer),
      async read(path) {
        const result = await peer.request('resources.read', { path });
        if (!result.binary) throw new Error('Missing resource data');
        return result.binary;
      },
      async url(path, mimeType = 'application/octet-stream') {
        const bytes = await context.resources.read(path);
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        subscriptions.push({ dispose: () => URL.revokeObjectURL(url) });
        return url;
      },
      async fetch(url, sha256) {
        const result = await peer.request(
          'resources.fetch',
          { url, ...(sha256 ? { sha256 } : {}) },
          { timeout: 0 },
        );
        if (!result.binary) throw new Error('Missing model data');
        return result.binary;
      },
    },
    log: async (message, level = 'info') => {
      await host('log', { message, level });
    },
  };
  return {
    context,
    async ready() {
      await Promise.all(pending.splice(0));
    },
    async dispose() {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      for (const disposable of subscriptions.splice(0).reverse()) await disposable.dispose();
    },
    event(name: string, data: JsonValue) {
      if (name === '$subscription') {
        const args = object(data);
        const listener = listeners.get(String(args.subscriptionId));
        if (listener && listener.event === args.event)
          void Promise.resolve()
            .then(() => listener.callback(args.data ?? null))
            .catch((error) => context.log(String(error), 'error').catch(() => {}));
      } else if (name === '$cancel') requests.get(String(object(data).requestId))?.abort();
      else
        for (const listener of listeners.values()) {
          if (listener.event !== name || !eventMatches(manifest.id, data, listener.options))
            continue;
          void Promise.resolve()
            .then(() => listener.callback(data))
            .catch((error) => context.log(String(error), 'error').catch(() => {}));
        }
    },
    async invoke(
      method: string,
      params: JsonValue,
      binary: ArrayBuffer | undefined,
      id: string,
    ): Promise<RpcResult> {
      const args = object(params);
      const controller = new AbortController();
      requests.set(id, controller);
      const taskContext = {
        signal: controller.signal,
        progress: (value: JsonValue) =>
          peer.emit('task.progress', { taskId: args.taskId ?? '', progress: value }),
      };
      try {
        if (method === 'hooks.beforeCommit') {
          const handler = hooks.get(String(args.hookId));
          if (!handler) throw new RpcError('missing_hook', 'Before commit hook is not registered');
          return {
            result: (await handler(
              args.proposal as unknown as PluginMutationProposal,
              taskContext,
            )) as JsonValue,
          };
        }
        if (method === 'ocr.recognize') {
          const handler = ocr.get(String(args.providerId));
          if (!handler) throw new RpcError('missing_provider', 'OCR provider is not registered');
          if (!binary) throw new RpcError('missing_image', 'OCR requires image bytes');
          return { result: await handler(args.input ?? null, binary, taskContext) };
        }
        if (method === 'translation.translate') {
          const handler = translation.get(String(args.providerId));
          if (!handler)
            throw new RpcError('missing_provider', 'Translation provider is not registered');
          return { result: await handler(args.input ?? null, taskContext) };
        }
        if (method === 'commands.execute') {
          const handler = commands.get(String(args.commandId));
          if (!handler) throw new RpcError('missing_command', 'Command is not registered');
          controller.signal.throwIfAborted();
          const result = await handler(args.params ?? null, {
            ...taskContext,
            summary(message) {
              if (!controller.signal.aborted && typeof args.taskId === 'string')
                peer.emit('task.summary', { taskId: args.taskId, message });
            },
          });
          controller.signal.throwIfAborted();
          return { result };
        }
        throw new RpcError('unknown_method', `Unknown plugin method: ${method}`);
      } finally {
        requests.delete(id);
      }
    },
  };
}

/** Connect a standalone panel after its parent sends {type:'bubblefish-panel', port}. */
export function connectPanel(port: MessagePort) {
  const listeners = new Map<string, { event: string; callback: (data: JsonValue) => unknown }>();
  const peer = new RpcPeer(
    (packet) => port.postMessage(packet, packet.binary ? [packet.binary] : []),
    async () => {
      throw new Error('Panel does not expose host methods');
    },
    (event, data) => {
      if (event === '$subscription') {
        const args = object(data);
        const listener = listeners.get(String(args.subscriptionId));
        if (listener && listener.event === args.event)
          void Promise.resolve()
            .then(() => listener.callback(args.data ?? null))
            .catch(() => {});
      } else
        for (const listener of listeners.values())
          if (listener.event === event)
            void Promise.resolve()
              .then(() => listener.callback(data))
              .catch(() => {});
    },
  );
  port.onmessage = (event) => {
    void peer.receive(event.data);
  };
  port.start();
  const call = async (method: string, params: JsonValue = null) =>
    (await peer.request(method, params)).result;
  return {
    call,
    document: createDocumentApi(peer),
    history: createHistoryApi(peer),
    config: {
      get: () => call('config.get'),
      update: (patch: Record<string, JsonValue>) => call('config.update', patch),
    },
    commands: {
      execute: (commandId: string, params: JsonValue = null) =>
        peer
          .request('commands.execute', { commandId, params }, { timeout: 0 })
          .then((value) => value.result),
    },
    resources: {
      local: createLocalResourceApi(peer),
      read: async (path: string) => (await peer.request('resources.read', { path })).binary,
    },
    events: {
      subscribe<Name extends string>(
        event: Name,
        callback: (
          data: Name extends keyof import('./events').PluginEventMap
            ? import('./events').PluginEventMap[Name]
            : JsonValue,
        ) => unknown,
        options: EventSubscriptionOptions = {},
      ): Disposable {
        const subscriptionId = newId();
        listeners.set(subscriptionId, {
          event,
          callback: callback as (data: JsonValue) => unknown,
        });
        void call('events.subscribe', {
          event,
          subscriptionId,
          options: options as JsonValue,
        }).catch(() => {});
        return {
          dispose() {
            if (listeners.delete(subscriptionId))
              return call('events.unsubscribe', { event, subscriptionId }).then(() => {});
          },
        };
      },
    },
    dispose() {
      peer.emit('$panel.close', null);
      peer.close();
      port.close();
      listeners.clear();
    },
  };
}

export function eventMatches(
  pluginId: string,
  data: JsonValue,
  options: EventSubscriptionOptions = {},
) {
  const value = object(data);
  if (options.projectId && value.projectId !== options.projectId) return false;
  const origin = object(value.origin ?? value.source ?? null);
  return (
    options.includeSelf === true || (origin.pluginId !== pluginId && value.pluginId !== pluginId)
  );
}
