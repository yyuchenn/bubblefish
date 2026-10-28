import type { CoreTransport } from './types';
export type { CoreTransport, ImportResult, ImageProbe, ProjectFormat } from './types';

/** Compile-time branches keep WASM out of desktop builds and Tauri out of web bundles. */
export function createTransport(): CoreTransport {
  let disposed = false;
  const instance = (__DESKTOP__ ? import('./desktop') : import('./web')).then(
    ({ createTransport }) => {
      const transport = createTransport();
      if (disposed) transport.dispose();
      return transport;
    },
  );
  const use = async () => {
    if (disposed) throw new Error('Core transport is disposed');
    return instance;
  };
  return {
    ready: async () => (await use()).ready(),
    dispatch: async (e) => (await use()).dispatch(e),
    importProject: async (bytes, format, id) => (await use()).importProject(bytes, format, id),
    exportProject: async (id, format) => (await use()).exportProject(id, format),
    probeImage: async (bytes) => (await use()).probeImage(bytes),
    dispose: () => {
      disposed = true;
      void instance.then((t) => t.dispose()).catch(() => {});
    },
  };
}
