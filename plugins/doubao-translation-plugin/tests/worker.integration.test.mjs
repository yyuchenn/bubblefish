import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const PLUGIN_ID = 'doubao-translation-plugin';
const DEFAULT_MODEL = 'doubao-seed-2-1-pro-260915';
const MODEL_IDS = [DEFAULT_MODEL, 'doubao-seed-2-1-lite-260915',
  'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-1-pro-260628'];
const LEGACY_IDS = ['doubao-seed-1-6-250615', 'doubao-seed-1-6-flash-250828',
  'doubao-1-5-pro-32k-250115'];
const API_KEY = 'integration-test-key-never-a-real-credential';
const PROMPT = '自定义提示：{source_lang} → {target_lang}。只返回译文。';
const pkg = process.env.DOUBAO_WASM_PKG
  ? resolve(process.env.DOUBAO_WASM_PKG)
  : fileURLToPath(new URL('../pkg/', import.meta.url));
const artifactVersions = ['manifest.json', 'package.json', 'version.json']
  .map((name) => join(pkg, name))
  .filter(existsSync)
  .map((path) => JSON.parse(readFileSync(path, 'utf8')).version)
  .filter((version) => typeof version === 'string' && /^[\w.+-]+$/.test(version));
const artifacts = [...new Set(artifactVersions), null].map((version) => ({
  modulePath: join(pkg, `doubao_translation_plugin${version ? `.${version}` : ''}.js`),
  wasmPath: join(pkg, `doubao_translation_plugin_bg${version ? `.${version}` : ''}.wasm`),
})).find(({ modulePath, wasmPath }) => existsSync(modulePath) && existsSync(wasmPath));

assert.ok(artifacts,
  `No web WASM bindings found in ${pkg}; build first (see tests/README.md or set DOUBAO_WASM_PKG).`);
const { modulePath, wasmPath } = artifacts;

function completed(content, extra = {}) {
  return { status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content },
  ], ...extra };
}

class PluginHost {
  constructor(options = {}) {
    this.config = {
      api_key: API_KEY, model: DEFAULT_MODEL, system_prompt: PROMPT,
      ...options.config,
    };
    this.failConfigSet = options.failConfigSet ?? false;
    this.malformedModelReadOnce = options.malformedModelReadOnce ?? false;
    this.calls = [];
    this.requests = [];
    this.events = [];
    this.notifications = [];
    this.buffer = new SharedArrayBuffer(1024 * 1024);
    this.header = new Int32Array(this.buffer, 0, 8);
    this.data = new Uint8Array(this.buffer, 32);
    this.worker = new Worker(new URL('./plugin-worker.mjs', import.meta.url), {
      workerData: {
        buffer: this.buffer, modulePath, wasmPath, pluginId: PLUGIN_ID,
        http: {
          status: options.status ?? 200,
          body: typeof options.response === 'string' ? options.response
            : JSON.stringify(options.response ?? completed([
              { type: 'output_text', text: '你好，世界！' },
            ])),
          contentType: options.contentType ?? 'application/json',
          networkError: options.networkError,
        },
      },
      stdout: true,
      stderr: true,
    });
    this.logs = [];
    this.worker.stdout.on('data', (data) => this.logs.push(data.toString()));
    this.worker.stderr.on('data', (data) => this.logs.push(data.toString()));
    this.worker.on('error', (error) => { this.failure = error; });
    this.worker.on('message', (message) => {
      if (message.type === 'ready') {
        this.metadata = message.metadata;
        this.exports = message.exports;
      } else if (message.type === 'fetch') {
        this.requests.push(message.request);
      } else if (message.type === 'failure') {
        this.failure = new Error(message.error);
      }
    });
    // Keep the host outside the Worker: plugin config/events calls use blocking
    // Atomics.wait and must be answered by a different thread, just as in the app.
    this.poll = setInterval(() => this.handleCall(), 1);
  }

  handleCall() {
    if (Atomics.load(this.header, 0) !== 1) return;
    try {
      const size = Atomics.load(this.header, 4);
      const reader = Atomics.load(this.header, 3);
      const writer = Atomics.load(this.header, 2);
      const available = (writer - reader + this.data.length) % this.data.length;
      assert.equal(available, size, 'Test service messages must fit in the shared buffer');
      const bytes = Uint8Array.from({ length: size }, (_, i) =>
        this.data[(reader + i) % this.data.length]);
      const call = JSON.parse(new TextDecoder().decode(bytes));
      this.calls.push(call);
      const { service, method, params } = call;
      let response = null;
      let rawResponse;
      if (service === 'config') {
        assert.equal(params.plugin_id, PLUGIN_ID);
        if (method === 'get') {
          response = this.config[params.key] ?? null;
          if (params.key === 'model' && this.malformedModelReadOnce) {
            rawResponse = '{invalid host JSON';
            this.malformedModelReadOnce = false;
          }
        }
        else if (method === 'set') {
          if (this.failConfigSet) {
            // This is the real SDK service-error protocol, not a success-shaped
            // JSON error. The next call must still be able to use this channel.
            Atomics.store(this.header, 6, 1);
            Atomics.store(this.header, 0, 3);
            Atomics.notify(this.header, 0);
            return;
          }
          this.config[params.key] = params.value;
          response = true;
        } else throw new Error(`Unexpected config method: ${method}`);
      } else if (service === 'events' && method === 'emit_business_event') {
        this.events.push(params);
      } else if (service === 'notifications' && method === 'push') {
        this.notifications.push(params);
        response = { id: 'test-notification' };
      } else if (service !== 'bunny' || method !== 'register_translation_service') {
        throw new Error(`Unexpected service call: ${service}.${method}`);
      }
      const output = new TextEncoder().encode(rawResponse ?? JSON.stringify(response));
      assert.ok(output.length < this.data.length);
      Atomics.store(this.header, 2, 0);
      Atomics.store(this.header, 3, 0);
      this.data.set(output);
      Atomics.store(this.header, 4, output.length);
      Atomics.store(this.header, 2, output.length);
      Atomics.store(this.header, 0, 2);
      Atomics.notify(this.header, 0);
    } catch (error) {
      this.failure = error;
    }
  }

  async until(predicate, description) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (this.failure) throw this.failure;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${description}\n${this.logs.join('')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async translate(overrides = {}) {
    const count = this.events.length;
    this.worker.postMessage({
      type: 'translation_request', task_id: 'task-42', text: 'Hello, world!',
      options: { source_language: 'english', target_language: 'simplifiedChinese' },
      ...overrides,
    });
    await this.until(() => this.events.length > count, 'translation result/error');
    return this.events[count];
  }

  async close() {
    clearInterval(this.poll);
    await this.worker.terminate();
  }
}

async function load(t, options) {
  const host = new PluginHost(options);
  t.after(() => host.close());
  await host.until(() => host.metadata, 'plugin initialization');
  return host;
}

function configFields(metadata) {
  return metadata.config_schema.sections.flatMap((section) => section.fields);
}

test('real WASM Worker exports, metadata, authenticated request, context and success event', async (t) => {
  const host = await load(t);
  assert.ok(host.exports.includes('init_shared_buffer'));
  const fields = configFields(host.metadata);
  const model = fields.find((field) => field.key === 'model');
  assert.deepEqual(model.options.map((option) => option.value).sort(), [...MODEL_IDS].sort());
  assert.equal(model.default_value, DEFAULT_MODEL);
  assert.equal(fields.find((field) => field.key === 'api_key').field_type, 'password');
  const event = await host.translate();
  assert.deepEqual(event, {
    event_name: 'plugin:translation_result',
    data: { task_id: 'task-42', translated_text: '你好，世界！', service: 'doubao-translate' },
  });
  assert.equal(host.requests.length, 1);
  const request = host.requests[0];
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.deepEqual(request.body.input, [
    { role: 'system', content: '自定义提示：英语 → 简体中文。只返回译文。' },
    { role: 'user', content: 'Hello, world!' },
  ]);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.stream, false);
  assert.equal(request.body.store, false);
  assert.equal(request.body.messages, undefined);
  assert.equal(host.events.length, 1);
  assert.equal(host.calls.filter((call) => call.service === 'config' && call.method === 'set').length, 0);
});

test('all old bundled model choices migrate while preserving API key and prompt', async (t) => {
  for (const model of LEGACY_IDS) {
    await t.test(model, async (t) => {
      const host = await load(t, { config: { model } });
      assert.deepEqual(host.config, { api_key: API_KEY, model: DEFAULT_MODEL, system_prompt: PROMPT });
      const writes = host.calls.filter((call) => call.service === 'config' && call.method === 'set');
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].params, { plugin_id: PLUGIN_ID, key: 'model', value: DEFAULT_MODEL });
      const event = await host.translate();
      assert.equal(event.event_name, 'plugin:translation_result');
      assert.equal(host.requests[0].body.model, DEFAULT_MODEL);
      assert.equal(host.requests[0].headers.authorization, `Bearer ${API_KEY}`);
      assert.equal(host.requests[0].body.input[0].content, '自定义提示：英语 → 简体中文。只返回译文。');
    });
  }
});

test('failed migration persistence leaves stored settings intact and channel usable', async (t) => {
  const host = await load(t, { config: { model: LEGACY_IDS[0] }, failConfigSet: true });
  assert.deepEqual(host.config, { api_key: API_KEY, model: LEGACY_IDS[0], system_prompt: PROMPT });
  assert.ok(host.calls.some((call) => call.service === 'config' && call.method === 'set'));
  assert.ok(host.calls.some((call) => call.service === 'bunny' && call.method === 'register_translation_service'));
  for (const taskId of ['task-first', 'task-second']) {
    const event = await host.translate({ task_id: taskId });
    assert.equal(event.event_name, 'plugin:translation_result');
    assert.equal(event.data.task_id, taskId);
    assert.equal(host.requests.at(-1).body.model, DEFAULT_MODEL);
    assert.equal(host.requests.at(-1).headers.authorization, `Bearer ${API_KEY}`);
  }
});

test('malformed completed host response releases the channel without overwriting unread settings', async (t) => {
  const host = await load(t, {
    config: { model: LEGACY_IDS[0] }, malformedModelReadOnce: true,
  });
  assert.deepEqual(host.config, { api_key: API_KEY, model: LEGACY_IDS[0], system_prompt: PROMPT });
  assert.equal(host.calls.filter((call) => call.service === 'config' && call.method === 'set').length, 0);
  assert.ok(host.calls.some((call) => call.service === 'bunny' && call.method === 'register_translation_service'));
  const event = await host.translate();
  assert.equal(event.event_name, 'plugin:translation_result');
  assert.equal(host.requests[0].body.model, DEFAULT_MODEL);
  assert.equal(host.requests[0].headers.authorization, `Bearer ${API_KEY}`);
});

test('each current Seed 2.1 choice remains selected', async (t) => {
  for (const model of MODEL_IDS) {
    await t.test(model, async (t) => {
      const host = await load(t, { config: { model } });
      await host.translate();
      assert.equal(host.requests[0].body.model, model);
      assert.equal(host.config.model, model);
      assert.equal(host.calls.filter((call) => call.service === 'config' && call.method === 'set').length, 0);
    });
  }
});

test('structured HTTP errors retain provider status/code/message and emit one error event', async (t) => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const host = await load(t, {
        status,
        response: { error: { code: 'TestProviderError', message: 'Provider rejected test request' } },
      });
      const event = await host.translate();
      assert.equal(event.event_name, 'plugin:translation_error');
      assert.equal(event.data.task_id, 'task-42');
      assert.equal(event.data.service, 'doubao-translate');
      assert.match(event.data.error, new RegExp(String(status)));
      assert.match(event.data.error, /TestProviderError/);
      assert.match(event.data.error, /Provider rejected test request/);
      assert.equal(host.events.length, 1);
      assert.ok(host.notifications.some((notice) => notice.level === 'error'));
    });
  }
});

test('network, non-JSON and unusable Responses results fail without false success', async (t) => {
  const scenarios = [
    { name: 'network failure', networkError: 'mock connection refused' },
    { name: 'non-JSON HTTP error', status: 502, response: '<html>Bad Gateway</html>', contentType: 'text/html' },
    { name: 'invalid success JSON', response: 'not JSON' },
    { name: 'missing status', response: { output: [] } },
    { name: 'missing output', response: { status: 'completed' } },
    { name: 'empty output', response: { status: 'completed', output: [] } },
    { name: 'null text', response: completed([{ type: 'output_text', text: null }]) },
    { name: 'empty text', response: completed([{ type: 'output_text', text: '' }]) },
    { name: 'whitespace text', response: completed([{ type: 'output_text', text: ' \n\t ' }]) },
    { name: 'length limit', response: completed([{ type: 'output_text', text: 'partial' }], {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }) },
    { name: 'failed response', response: { status: 'failed', output: [] } },
    { name: 'in-progress response', response: { status: 'in_progress', output: [] } },
    { name: 'refusal', response: completed([{ type: 'refusal', refusal: 'Cannot translate' }]) },
    { name: 'HTTP 200 error', response: { error: { code: 'TestProviderError', message: 'API error' } } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const host = await load(t, scenario);
      const event = await host.translate();
      assert.equal(event.event_name, 'plugin:translation_error');
      assert.equal(event.data.task_id, 'task-42');
      assert.ok(event.data.error.length > 0);
      assert.equal(host.events.length, 1);
    });
  }
});

test('only assistant output_text contributes to translation, in original order', async (t) => {
  const host = await load(t, { response: {
    status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
      { type: 'function_call', arguments: 'private tool data' },
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'input echo' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '你好，' }, { type: 'output_text', text: '世界！\n' },
      ] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '下一行' },
      ] },
    ],
  } });
  const event = await host.translate();
  assert.equal(event.event_name, 'plugin:translation_result');
  assert.equal(event.data.translated_text, '你好，世界！\n下一行');
});

test('missing API key produces an error and never calls fetch', async (t) => {
  const host = await load(t, { config: { api_key: '' } });
  const event = await host.translate();
  assert.equal(event.event_name, 'plugin:translation_error');
  assert.equal(event.data.task_id, 'task-42');
  assert.equal(host.requests.length, 0);
});
