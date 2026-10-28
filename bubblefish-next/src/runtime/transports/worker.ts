/// <reference lib="webworker" />
import init, { CoreHost } from '../../wasm/bubblefish_wasm';

const host = init().then(() => new CoreHost());
// Promise chaining makes the single writer guarantee explicit, even for startup.
let tail: Promise<void> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ id: number; method: string; args: unknown[] }>) => {
  tail = tail.then(async () => {
    try {
      const core = await host;
      const [a, b, c] = data.args;
      let result: unknown;
      switch (data.method) {
        case 'ready':
          break;
        case 'dispatch':
          result = core.dispatch(a);
          break;
        case 'importProject':
          result = core.importProject(a as Uint8Array, b as string, c as string);
          break;
        case 'exportProject':
          result = core.exportProject(a as string, b as string);
          break;
        case 'probeImage':
          result = core.probeImage(a as Uint8Array);
          break;
        default:
          throw new Error(`Unknown core method: ${data.method}`);
      }
      if (result instanceof Uint8Array) {
        self.postMessage({ id: data.id, result }, { transfer: [result.buffer] });
      } else self.postMessage({ id: data.id, result });
    } catch (error) {
      self.postMessage({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
