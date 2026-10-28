import type { CoreTransport } from './types';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export function createTransport(): CoreTransport {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'bubblefish-core',
  });
  const pending = new Map<number, Pending>();
  let sequence = 0;
  let failed: Error | undefined;
  const fail = (error: Error) => {
    failed = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new Error(event.message || 'Core worker crashed'));
  };
  worker.onmessageerror = () => fail(new Error('Core worker message could not be decoded'));
  function call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (failed) return Promise.reject(failed);
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  const ready = call<void>('ready');
  return {
    ready: () => ready,
    dispatch: async (envelope) => {
      await ready;
      return call('dispatch', [envelope]);
    },
    importProject: async (bytes, format, id) => {
      await ready;
      return call('importProject', [bytes, format, id]);
    },
    exportProject: async (id, format) => {
      await ready;
      return call('exportProject', [id, format]);
    },
    probeImage: async (bytes) => {
      await ready;
      return call('probeImage', [bytes]);
    },
    dispose: () => {
      fail(new Error('Core transport is disposed'));
      worker.terminate();
    },
  };
}
