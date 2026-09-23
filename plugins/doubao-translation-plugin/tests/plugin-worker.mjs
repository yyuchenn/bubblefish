import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

// Model the browser Worker global without supplying a Window. Request, Headers,
// Response, WebAssembly, and Atomics are Node's real implementations.
globalThis.self = globalThis;
globalThis.WorkerGlobalScope = class WorkerGlobalScope {
  static [Symbol.hasInstance](value) {
    return value === globalThis;
  }
};

globalThis.fetch = async (request) => {
  parentPort.postMessage({
    type: 'fetch',
    request: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: JSON.parse(await request.text()),
    },
  });
  if (workerData.http.networkError) {
    throw new TypeError(workerData.http.networkError);
  }
  return new Response(workerData.http.body, {
    status: workerData.http.status,
    headers: { 'content-type': workerData.http.contentType },
  });
};

try {
  const module = await import(pathToFileURL(workerData.modulePath).href);
  const wasm = await WebAssembly.compile(await readFile(workerData.wasmPath));
  module.initSync({ module: wasm });
  const plugin = new module.PluginWrapper();
  const exports = ['init_shared_buffer', 'init', 'on_message', 'get_metadata', 'activate'];
  for (const name of exports) {
    if (typeof plugin[name] !== 'function') throw new Error(`Missing plugin export: ${name}`);
  }
  plugin.init_shared_buffer(workerData.buffer);
  plugin.init(workerData.pluginId);
  plugin.activate();
  parentPort.postMessage({ type: 'ready', metadata: plugin.get_metadata(), exports });
  parentPort.on('message', (message) => {
    try {
      plugin.on_message('integration-test', message);
    } catch (error) {
      parentPort.postMessage({ type: 'failure', error: error?.stack ?? String(error) });
    }
  });
} catch (error) {
  parentPort.postMessage({ type: 'failure', error: error?.stack ?? String(error) });
}
