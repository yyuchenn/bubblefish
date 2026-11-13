import type { InstalledPlugin, PluginStorage, PluginRuntimeRole } from './types';
import { decodeFrame, encodeFrame, type Packet } from './rpc';
export interface PluginBackend {
  send(packet: Packet): void;
  terminate(): Promise<void>;
}
export type BackendFactory = (
  plugin: InstalledPlugin,
  generation: number,
  kind: 'web' | 'native',
  receive: (packet: Packet) => void,
  fail: (error: Error) => void,
  signal?: AbortSignal,
  runtimeRole?: PluginRuntimeRole,
) => Promise<PluginBackend>;
const rendererSession = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
export function createBackendFactory(storage: PluginStorage): BackendFactory {
  return async (plugin, generation, kind, receive, fail, signal, runtimeRole = 'main') => {
    if (kind === 'native') {
      const nativeGeneration = `${rendererSession}:${generation}`;
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const onMessage = new Channel<ArrayBuffer>();
      const onEvent = new Channel<{
        type?: string;
        kind?: string;
        message?: string;
        code?: number;
      }>();
      let stopped = false;
      onMessage.onmessage = (frame) => {
        try {
          receive(decodeFrame(frame));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      onEvent.onmessage = (event) => {
        const kind = event.type ?? event.kind;
        if (!stopped && (kind === 'exit' || kind === 'error'))
          fail(new Error(event.message ?? `Plugin process exited (${event.code ?? 'unknown'})`));
        if (kind === 'stderr')
          receive({
            message: {
              kind: 'event',
              apiVersion: 1,
              event: 'log',
              data: { level: 'warn', message: event.message ?? '' },
            },
          });
      };
      const stopPending = () => {
        void invoke('plugin_native_stop', {
          pluginId: plugin.manifest.id,
          generation: nativeGeneration,
          runtimeRole,
        }).catch(() => {});
      };
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      signal?.addEventListener('abort', stopPending, { once: true });
      try {
        await invoke('plugin_native_start', {
          pluginId: plugin.manifest.id,
          generation: nativeGeneration,
          runtimeRole,
          onMessage,
          onEvent,
        });
      } finally {
        signal?.removeEventListener('abort', stopPending);
      }
      return {
        send(packet) {
          void invoke('plugin_native_send', encodeFrame(packet), {
            headers: {
              'x-bf-options': encodeURIComponent(
                JSON.stringify({
                  pluginId: plugin.manifest.id,
                  generation: nativeGeneration,
                  runtimeRole,
                }),
              ),
            },
          }).catch((error) => {
            if (!stopped) fail(error instanceof Error ? error : new Error(String(error)));
          });
        },
        async terminate() {
          if (stopped) return;
          stopped = true;
          await invoke('plugin_native_stop', {
            pluginId: plugin.manifest.id,
            generation: nativeGeneration,
            runtimeRole,
          });
        },
      };
    }
    const entry = plugin.manifest.entrypoints.web;
    if (!entry) throw new Error('This plugin has no browser entrypoint');
    const bytes = await storage.read(plugin.manifest.id, entry);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: `plugin:${plugin.manifest.id}:${runtimeRole}`,
    });
    worker.onmessage = (event: MessageEvent<Packet>) => receive(event.data);
    worker.onerror = (event) => fail(new Error(event.message || 'Plugin worker failed'));
    worker.onmessageerror = () => fail(new Error('Plugin worker sent an invalid message'));
    worker.postMessage({ load: { url, manifest: plugin.manifest, runtimeRole } });
    let stopped = false;
    return {
      send(packet) {
        if (!stopped) worker.postMessage(packet, packet.binary ? [packet.binary] : []);
      },
      async terminate() {
        if (!stopped) {
          stopped = true;
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      },
    };
  };
}
