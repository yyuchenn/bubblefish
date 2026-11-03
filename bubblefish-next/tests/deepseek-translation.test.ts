import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Disposable,
  PluginContext,
  ProviderContext,
  TranslationHandler,
} from '../src/plugin-sdk';
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_PROMPT,
  parseTranslationInput,
  renderMessages,
  resolveConfig,
} from '../plugins/deepseek-translation/config';
import { DeepSeekClient, REQUEST_TIMEOUT_MS } from '../plugins/deepseek-translation/client';
import { activate, deactivate } from '../plugins/deepseek-translation/web';
import manifest from '../plugins/deepseek-translation/plugin.json';

const input = {
  text: '今日はいい天気ですね。',
  sourceLanguage: 'japanese',
  targetLanguage: 'simplifiedChinese',
};
const config = () => resolveConfig({ apiKey: 'test-secret-key' });
const context = (signal = new AbortController().signal): ProviderContext => ({
  signal,
  progress: vi.fn(),
});
const response = (content: unknown = '今天天气真好。', finish_reason = 'stop') =>
  Response.json({ choices: [{ finish_reason, message: { role: 'assistant', content } }] });

afterEach(() => {
  deactivate();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DeepSeek configuration and prompts', () => {
  it('keeps manifest defaults and provider declarations compatible with the runtime', () => {
    expect(
      Object.fromEntries(
        manifest.contributes.configuration.map((field) => [field.key, field.default]),
      ),
    ).toEqual(resolveConfig({}, false));
    expect(manifest.contributes.translation).toContainEqual({
      id: 'deepseek-translation',
      name: 'DeepSeek 翻译',
    });
    expect(manifest.contributes.configuration.find((field) => field.key === 'apiKey')?.type).toBe(
      'secret',
    );
    expect(manifest.permissions).toEqual([]);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.contributes).not.toHaveProperty('commands');
    expect(manifest.contributes.panels).toHaveLength(1);
  });
  it('provides defaults and allows a configuration preview without a key', () => {
    expect(() => resolveConfig({})).toThrow('API Key');
    expect(resolveConfig({}, false)).toEqual({
      apiKey: '',
      endpoint: DEFAULT_ENDPOINT,
      model: DEFAULT_MODEL,
      requestMode: 'deepseek',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userPrompt: DEFAULT_USER_PROMPT,
    });
  });

  it('trims connection settings, defaults blank prompts, and retains template formatting', () => {
    expect(
      resolveConfig({
        apiKey: ' key ',
        endpoint: ' ',
        model: ' ',
        systemPrompt: ' \n',
        userPrompt: ' ',
      }),
    ).toMatchObject({
      apiKey: 'key',
      endpoint: DEFAULT_ENDPOINT,
      model: DEFAULT_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userPrompt: DEFAULT_USER_PROMPT,
    });
    expect(resolveConfig({ apiKey: 'key', userPrompt: '  原文：\n{text}\n' }).userPrompt).toBe(
      '  原文：\n{text}\n',
    );
  });

  it.each([
    ['http://localhost:8080/chat/completions', 'HTTPS'],
    ['not a url', 'HTTPS'],
    ['https://user:password@example.com/chat/completions', '用户名'],
    ['https://example.com/chat/completions#fragment', '片段'],
  ])('rejects invalid endpoint %s', (endpoint, message) => {
    expect(() => resolveConfig({ apiKey: 'key', endpoint })).toThrow(message);
  });

  it('validates config types, request mode, key and original text placeholder', () => {
    expect(() => resolveConfig({ apiKey: 123 })).toThrow('文本');
    expect(() => resolveConfig({ apiKey: 'a\nb' })).toThrow('换行');
    expect(() => resolveConfig({ apiKey: 'key', requestMode: 'unknown' })).toThrow('请求模式');
    expect(() => resolveConfig({ apiKey: 'key', userPrompt: 'translate this' })).toThrow('{text}');
  });

  it('renders both messages in one pass and preserves source placeholders and unknown braces', () => {
    const messages = renderMessages(
      resolveConfig({
        apiKey: 'key',
        systemPrompt: '{source_lang} -> {target_lang} {"format":"text"}',
        userPrompt: '{source_lang}: {text}\n{text} / {unknown}',
      }),
      { ...input, text: '{target_lang} $& $1' },
    );
    expect(messages).toEqual([
      { role: 'system', content: '日本語 -> 简体中文 {"format":"text"}' },
      { role: 'user', content: '日本語: {target_lang} $& $1\n{target_lang} $& $1 / {unknown}' },
    ]);
  });

  it.each([
    ['english', '英语'],
    ['traditionalChinese', '繁体中文'],
    ['auto', '自动检测'],
    ['unknown-lang', 'unknown-lang'],
    ['__proto__', '__proto__'],
  ])('maps language %s to %s', (language, name) => {
    const messages = renderMessages(
      resolveConfig({ apiKey: 'key', systemPrompt: '{source_lang}' }),
      {
        ...input,
        sourceLanguage: language,
      },
    );
    expect(messages[0].content).toBe(name);
  });

  it('validates provider input while accepting the host options field', () => {
    expect(parseTranslationInput({ ...input, options: {} })).toEqual(input);
    expect(() => parseTranslationInput(null)).toThrow('格式');
    expect(() => parseTranslationInput({ ...input, text: ' \n' })).toThrow('原文');
    expect(() => parseTranslationInput({ text: 'source' })).toThrow('语言');
  });
});

describe('DeepSeek HTTP client', () => {
  it('sends the official request and returns only trimmed final content with line breaks', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(' \n第一行\n第二行 \n'));
    const task = context();
    const client = new DeepSeekClient({ fetch });
    expect(await client.translate(config(), input, task)).toEqual({ text: '第一行\n第二行' });
    const [endpoint, request] = fetch.mock.calls[0];
    expect(endpoint).toBe(DEFAULT_ENDPOINT);
    expect(request).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret-key', 'Content-Type': 'application/json' },
      credentials: 'omit',
    });
    expect(JSON.parse(request!.body as string)).toEqual({
      model: DEFAULT_MODEL,
      messages: renderMessages(config(), input),
      stream: false,
      thinking: { type: 'disabled' },
    });
    expect(task.progress).toHaveBeenLastCalledWith({
      phase: 'completed',
      message: '翻译完成',
      completed: 1,
      total: 1,
    });
  });

  it('uses an exact custom endpoint/model and omits DeepSeek extensions in compatible mode', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const client = new DeepSeekClient({ fetch });
    await client.translate(
      resolveConfig({
        apiKey: 'key',
        endpoint: 'https://gateway.example/v1/chat/completions?route=x',
        model: 'custom-model',
        requestMode: 'openai',
      }),
      input,
      context(),
    );
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.example/v1/chat/completions?route=x');
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('custom-model');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each([
    [400, '格式'],
    [401, 'API Key'],
    [402, '余额'],
    [403, '权限'],
    [404, '地址'],
    [408, '超时'],
    [413, '过长'],
    [422, '参数'],
    [429, '频繁'],
    [500, '内部错误'],
    [502, '网关'],
    [503, '繁忙'],
    [504, '超时'],
    [418, '请求失败'],
  ])(
    'reports safe HTTP %i errors without leaking the upstream body or retrying',
    async (status, message) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response('test-secret-key private-source private-output', { status }),
        );
      const error = await new DeepSeekClient({ fetch })
        .translate(config(), input, context())
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).toContain(String(status));
      expect((error as Error).message).not.toMatch(/test-secret-key|private-source|private-output/);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['length', '截断'],
    ['content_filter', '过滤'],
    ['tool_calls', '工具'],
    ['insufficient_system_resource', '资源'],
    ['aborted', '中断'],
    ['unknown', '正常完成'],
    ['__proto__', '正常完成'],
  ])('rejects unfinished generation %s', async (reason, message) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response('partial text', reason));
    await expect(
      new DeepSeekClient({ fetch }).translate(config(), input, context()),
    ).rejects.toThrow(message);
  });

  it.each([null, '', ' \n', 12, { text: 'invalid' }])(
    'rejects invalid content %#',
    async (content) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(content));
      await expect(
        new DeepSeekClient({ fetch }).translate(config(), input, context()),
      ).rejects.toThrow('有效译文');
    },
  );

  it.each([
    {},
    { choices: [] },
    { choices: [{ message: { content: 'unfinished' } }] },
    { choices: [{ finish_reason: 'stop', message: { reasoning_content: 'thinking only' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'text', tool_calls: [{}] } }] },
  ])('rejects malformed and reasoning/tool-only responses %#', async (payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
    await expect(
      new DeepSeekClient({ fetch }).translate(config(), input, context()),
    ).rejects.toThrow();
  });

  it('reports malformed JSON and network errors without exposing server text', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('test-secret-key malformed payload'))
      .mockRejectedValueOnce(new Error('test-secret-key in network stack'));
    const client = new DeepSeekClient({ fetch });
    await expect(client.translate(config(), input, context())).rejects.toThrow('有效 JSON');
    const error = await client
      .translate(config(), input, context())
      .catch((value: unknown) => value);
    expect((error as Error).message).toContain('跨域');
    expect((error as Error).message).not.toContain('test-secret-key');
    expect(
      await new DeepSeekClient({
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()),
      }).translate(config(), input, context()),
    ).toEqual({ text: '今天天气真好。' });
  });

  it('aborts timed-out requests, clears timers, and allows a later request', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(response());
    const client = new DeepSeekClient({ fetch });
    const pending = expect(client.translate(config(), input, context())).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await pending;
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await client.translate(config(), input, context())).toEqual({ text: '今天天气真好。' });
  });

  it('immediately cancels and ignores a late result even if transport ignores cancellation', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const task = context(controller.signal);
    const client = new DeepSeekClient({ fetch });
    const pending = expect(client.translate(config(), input, task)).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await pending;
    finish(response('late result'));
    await Promise.resolve();
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(task.progress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fetch for already cancelled tasks and removes signal listeners on success', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const client = new DeepSeekClient({ fetch });
    await expect(
      client.translate(config(), input, context(AbortSignal.abort())),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await client.translate(config(), input, context(controller.signal));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('stops every pending request on disposal and rejects later work', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const client = new DeepSeekClient({ fetch });
    const pending = [1, 2].map(() =>
      expect(client.translate(config(), input, context())).rejects.toMatchObject({
        name: 'AbortError',
      }),
    );
    client.dispose();
    client.dispose();
    await Promise.all(pending);
    expect(fetch.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
    await expect(client.translate(config(), input, context())).rejects.toThrow('停用');
  });
});

describe('DeepSeek plugin activation', () => {
  it('reads config for each translation and registers only the provider and cleanup', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetch);
    const get = vi
      .fn()
      .mockResolvedValueOnce({ apiKey: 'first-key' })
      .mockResolvedValueOnce({ apiKey: 'second-key', model: 'custom', userPrompt: '翻译：{text}' });
    let handler!: TranslationHandler;
    const register = vi.fn((_info: unknown, value: TranslationHandler) => {
      handler = value;
      return { dispose: vi.fn() };
    });
    const open = vi.fn(async () => {});
    const commands = vi.fn();
    const subscriptions: Disposable[] = [];
    const ctx = {
      runtimeRole: 'main',
      config: { get },
      translation: { register },
      commands: { register: commands },
      panels: { open },
      subscriptions: {
        add(value: Disposable) {
          subscriptions.push(value);
          return value;
        },
      },
    } as unknown as PluginContext;
    activate(ctx);
    expect(register).toHaveBeenCalledWith(
      { id: 'deepseek-translation', name: 'DeepSeek 翻译' },
      expect.any(Function),
    );
    await handler(input, context());
    await handler(input, context());
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ Authorization: 'Bearer first-key' });
    expect(fetch.mock.calls[1][1]!.headers).toMatchObject({ Authorization: 'Bearer second-key' });
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({
      model: 'custom',
      messages: [{ role: 'system' }, { role: 'user', content: `翻译：${input.text}` }],
    });
    expect(commands).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(subscriptions).toHaveLength(2);
    deactivate();
    await expect(handler(input, context())).rejects.toThrow();
  });

  it('registers no services in the hooks role', () => {
    const register = vi.fn();
    activate({ runtimeRole: 'hooks', translation: { register } } as unknown as PluginContext);
    expect(register).not.toHaveBeenCalled();
  });
});
