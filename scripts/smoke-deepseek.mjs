// Opt-in live check of the same request client bundled into the plugin.
// No credentials or source/translated text are written to stdout or reports.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey?.trim()) {
  console.log('SKIP：未设置 DEEPSEEK_API_KEY，未调用真实 API。');
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  async function moduleFrom(entry) {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2022',
        minify: false,
        lib: {
          entry: resolve(root, 'plugins/deepseek-translation', entry),
          formats: ['es'],
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    const chunks = (Array.isArray(result) ? result[0] : result).output.filter(
      (item) => item.type === 'chunk',
    );
    assert.equal(chunks.length, 1, 'Expected one standalone DeepSeek module');
    return import(`data:text/javascript;base64,${Buffer.from(chunks[0].code).toString('base64')}`);
  }
  const [{ DeepSeekClient }, { resolveConfig }] = await Promise.all(
    ['client.ts', 'config.ts'].map(moduleFrom),
  );
  const client = new DeepSeekClient();
  try {
    const output = await client.translate(
      resolveConfig({
        apiKey: apiKey.trim(),
        endpoint: process.env.DEEPSEEK_API_ENDPOINT,
        model: process.env.DEEPSEEK_MODEL,
        requestMode: process.env.DEEPSEEK_REQUEST_MODE,
      }),
      {
        text: '今日はいい天気ですね。',
        sourceLanguage: 'japanese',
        targetLanguage: 'simplifiedChinese',
      },
      { signal: new AbortController().signal, progress() {} },
    );
    assert.equal(typeof output.text, 'string', 'Missing translation');
    assert(output.text.trim().length > 0, 'Empty translation');
    console.log('PASS：真实 API 返回了正常完成的非空译文。');
  } finally {
    client.dispose();
  }
} catch (error) {
  // The client deliberately maps network/upstream failures to messages without request data.
  const message = error instanceof Error ? error.message : 'DeepSeek 冒烟检查失败';
  console.error(message.split(apiKey).join('[已隐藏]'));
  process.exitCode = 1;
}
