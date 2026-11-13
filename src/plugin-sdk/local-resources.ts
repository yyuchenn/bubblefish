import type {
  PluginLocalResourceImport,
  PluginLocalResourceImportToken,
  PluginLocalResourceSet,
  JsonValue,
} from '../generated/plugins';
import type { RpcPeer } from '../runtime/plugins/rpc';

export function createLocalResourceApi(peer: RpcPeer) {
  const call = async <T>(method: string, params: unknown = {}) =>
    (await peer.request(`resources.local.${method}`, params as JsonValue, { timeout: 0 }))
      .result as T;
  return {
    beginImport: (input: PluginLocalResourceImport) =>
      call<PluginLocalResourceImportToken>('beginImport', input),
    writeChunk: async (
      input: { token: string; path: string; offset: number },
      binary: ArrayBuffer,
    ) => {
      await peer.request('resources.local.writeChunk', input, { binary, timeout: 0 });
    },
    commitImport: (input: { token: string }) => call<PluginLocalResourceSet>('commitImport', input),
    abortImport: async (input: { token: string }) => {
      await call('abortImport', input);
    },
    list: () => call<PluginLocalResourceSet[]>('list'),
    read: async (input: { id: string; path: string }) => {
      const result = await peer.request('resources.local.read', input, { timeout: 0 });
      if (!result.binary) throw new Error('Missing local resource bytes');
      return result.binary;
    },
    remove: async (input: { id: string }) => {
      await call('remove', input);
    },
  };
}
export type LocalResourceApi = ReturnType<typeof createLocalResourceApi>;
