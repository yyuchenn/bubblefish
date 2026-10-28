import { invoke } from '@tauri-apps/api/core';
import type { CoreTransport } from './types';

export function createTransport(): CoreTransport {
  let disposed = false;
  const run = <T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    headers?: Record<string, string>,
  ) => {
    if (disposed) return Promise.reject<T>(new Error('Core transport is disposed'));
    return invoke<T>(command, args, headers ? { headers } : undefined).catch((error: unknown) => {
      if (error instanceof Error) throw error;
      if (error && typeof error === 'object' && 'message' in error) {
        const location = 'path' in error && error.path ? ` (${String(error.path)})` : '';
        throw new Error(`${String(error.message)}${location}`);
      }
      throw new Error(String(error));
    });
  };
  return {
    ready: () => run<void>('core_ready'),
    dispatch: (envelope) => run('core_dispatch', { envelope }),
    importProject: (bytes, format, projectId) =>
      run('core_import', bytes, { 'x-bf-format': format, 'x-bf-project': projectId }),
    exportProject: async (projectId, format) =>
      new Uint8Array(await run<ArrayBuffer>('core_export', { projectId, format })),
    probeImage: (bytes) => run('core_probe_image', bytes),
    dispose: () => {
      disposed = true;
    },
  };
}
