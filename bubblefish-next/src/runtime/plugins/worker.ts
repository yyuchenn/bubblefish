import type { JsonValue, PluginManifest } from '../../generated/plugins';
import { createPluginContext, type PluginModule } from '../../plugin-sdk';
import { RpcPeer, RpcError, type Packet } from './rpc';
import { object } from './types';

const scope = globalThis as unknown as {
  postMessage(value: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
let manifest: PluginManifest;
let runtimeRole: 'main' | 'hooks' = 'main';
let module: PluginModule;
let sdk: ReturnType<typeof createPluginContext>;
let loaded: Promise<void> | undefined;
let active = false;
type WasmFrame = { message: Packet['message']; binary?: Uint8Array };
interface RawCancellation {
  register(requestId: string): void;
  cancel(requestId: string): void;
  release(requestId: string): void;
}
let rawPlugin:
  | {
      dispatch(
        frame: WasmFrame,
        host: (frame: WasmFrame) => Promise<WasmFrame | undefined>,
      ): Promise<WasmFrame | undefined>;
      cancellation_handle?(): RawCancellation;
    }
  | undefined;
let rawCancellation: RawCancellation | undefined;
let rawTail: Promise<unknown> = Promise.resolve();
function dispatchRaw(frame: WasmFrame) {
  const requestId = frame.message.kind === 'request' ? frame.message.id : undefined;
  if (requestId) rawCancellation?.register(requestId);
  const request = rawTail.catch(() => {}).then(() => rawPlugin!.dispatch(frame, rawHost));
  rawTail = request;
  return request.finally(() => {
    if (requestId) rawCancellation?.release(requestId);
  });
}
async function rawHost(frame: WasmFrame): Promise<WasmFrame | undefined> {
  const message = frame.message;
  if (message.kind === 'event') {
    peer.emit(
      message.event,
      message.data,
      frame.binary ? new Uint8Array(frame.binary).buffer : undefined,
    );
    return;
  }
  if (message.kind !== 'request') return;
  try {
    const result = await peer.request(message.method, message.params, {
      binary: frame.binary ? new Uint8Array(frame.binary).buffer : undefined,
      timeout: message.method === 'resources.fetch' ? 0 : 30000,
    });
    return {
      message: {
        kind: 'response',
        apiVersion: 1,
        id: message.id,
        result: result.result,
        ...(result.binary ? { binary: { byteLength: result.binary.byteLength } } : {}),
      },
      ...(result.binary ? { binary: new Uint8Array(result.binary) } : {}),
    };
  } catch (error) {
    return {
      message: {
        kind: 'response',
        apiVersion: 1,
        id: message.id,
        error: {
          code: error instanceof RpcError ? error.code : 'host_error',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}
const peer = new RpcPeer(
  (packet) => scope.postMessage(packet, packet.binary ? [packet.binary] : []),
  async (method, params, binary, id) => {
    await loaded;
    if (rawPlugin) {
      const response = await dispatchRaw({
        message: {
          kind: 'request',
          apiVersion: 1,
          id,
          method,
          params,
          ...(binary ? { binary: { byteLength: binary.byteLength } } : {}),
        },
        ...(binary ? { binary: new Uint8Array(binary) } : {}),
      });
      if (!response || response.message.kind !== 'response')
        throw new RpcError('protocol', 'WASM plugin did not return a response');
      if (response.message.error)
        throw new RpcError(response.message.error.code, response.message.error.message);
      return {
        result: response.message.result ?? null,
        ...(response.binary ? { binary: new Uint8Array(response.binary).buffer } : {}),
      };
    }
    if (!manifest || !module) throw new RpcError('not_loaded', 'Plugin module was not loaded');
    if (method === 'handshake') {
      const args = object(params);
      if (args.apiVersion !== 1 || args.pluginId !== manifest.id)
        throw new RpcError('api_version', 'Plugin handshake mismatch');
      return {
        result: {
          apiVersion: 1,
          pluginId: manifest.id,
          features: [
            'async',
            'binary',
            'cancel',
            'document.transactions',
            'history',
            'hooks',
            'runtime.roles',
            'resources.local',
            'commands.tasks',
          ],
        },
      };
    }
    if (method === 'activate') {
      if (active) throw new RpcError('state', 'Plugin is already active');
      sdk = createPluginContext(peer, manifest, runtimeRole);
      try {
        await module.activate(sdk.context);
        await sdk.ready();
        active = true;
      } catch (error) {
        await sdk.dispose().catch(() => {});
        throw error;
      }
      return { result: null };
    }
    if (method === 'deactivate') {
      active = false;
      try {
        await module.deactivate?.();
      } finally {
        await sdk?.dispose();
      }
      return { result: null };
    }
    if (!active) throw new RpcError('inactive', 'Plugin is not active');
    return sdk.invoke(method, params, binary, id);
  },
  (event: string, data: JsonValue) => {
    if (rawPlugin && rawCancellation && event === '$cancel')
      rawCancellation.cancel(String(object(data).requestId));
    else if (rawPlugin)
      void dispatchRaw({ message: { kind: 'event', apiVersion: 1, event, data } }).catch(() => {});
    else sdk?.event(event, data);
  },
);
scope.onmessage = (
  event: MessageEvent<
    Packet | { load: { url: string; manifest: PluginManifest; runtimeRole?: 'main' | 'hooks' } }
  >,
) => {
  if ('load' in event.data) {
    const load = event.data.load;
    if (loaded) return;
    manifest = load.manifest;
    runtimeRole = load.runtimeRole ?? 'main';
    loaded = import(/* @vite-ignore */ load.url).then(async (exports) => {
      if (typeof exports.createPlugin === 'function') {
        rawPlugin = await exports.createPlugin(rawHost);
        if (!rawPlugin || typeof rawPlugin.dispatch !== 'function')
          throw new Error('createPlugin(host) must return a dispatch-capable plugin');
        rawCancellation = rawPlugin.cancellation_handle?.();
        return;
      }
      module = (exports.activate ? exports : exports.default) as PluginModule;
      if (!module || typeof module.activate !== 'function')
        throw new Error('Plugin entry must export activate(context)');
    });
    // The handshake receives and reports import errors.
    void loaded.catch(() => {});
  } else void peer.receive(event.data);
};
