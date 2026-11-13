// Bundled with wasm-bindgen's generated glue by build-example.mjs.
import init, { PluginWrapper } from './pkg/wasm_echo.js';

export async function createPlugin(host) {
  const response = await host({
    message: {
      kind: 'request',
      apiVersion: 1,
      id: 'wasm:initialize',
      method: 'resources.read',
      params: { path: 'wasm_echo_bg.wasm' },
    },
  });
  if (!response || response.message.kind !== 'response' || response.message.error) {
    throw new Error(response?.message?.error?.message ?? 'Cannot load plugin WASM');
  }
  if (!response.binary) throw new Error('Host did not return plugin WASM bytes');
  await init({ module_or_path: response.binary });
  return new PluginWrapper();
}
