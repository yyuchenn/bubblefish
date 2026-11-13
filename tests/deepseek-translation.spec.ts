import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const plugin = resolve('dist/plugins/deepseek-translation-plugin.bfplugin');
const endpoint = 'https://api.deepseek.com/chat/completions';
const provider = 'deepseek-translation-plugin/deepseek-translation';
const panelTitle = 'DeepSeek 翻译设置';
const fakeKey = 'sk-browser-test-not-a-real-key';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

interface ChatRequest {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
  thinking?: { type: string };
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await promisify(execFile)(process.execPath, [
    'scripts/package-plugin.mjs',
    'plugins/deepseek-translation',
  ]);
});

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
}

async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}

async function install(page: Page) {
  const dialog = await center(page);
  await dialog.getByLabel('安装插件包', { exact: true }).setInputFiles(plugin);
  const card = dialog.getByRole('article', { name: 'DeepSeek 翻译', exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card.getByText('未激活', { exact: true })).toBeVisible();
  const panelButton = card.getByRole('button', { name: panelTitle, exact: true });
  await expect(panelButton).toHaveCount(1);
  await panelButton.click();
  const frame = page.frameLocator(`iframe[title="${panelTitle}"]`);
  await expect(frame.getByLabel('API 地址', { exact: true })).toHaveValue(endpoint);
  return frame;
}

async function settings(page: Page) {
  const dialog = await center(page);
  const panelButton = dialog.getByRole('button', { name: panelTitle, exact: true });
  await expect(panelButton).toHaveCount(1);
  await panelButton.click();
  return page.frameLocator(`iframe[title="${panelTitle}"]`);
}

async function closePanel(page: Page) {
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
}

async function configure(page: Page) {
  const frame = await install(page);
  await frame.getByLabel('API Key', { exact: true }).fill(fakeKey);
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已保存');
  await closePanel(page);
}

async function project(page: Page, text: string) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill('DeepSeek 翻译验收');
  await dialog
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  await page.getByLabel('OCR 原文', { exact: true }).fill(text);
  await page.getByLabel('翻译插件', { exact: true }).selectOption(provider);
}

function completion(text: string, finishReason = 'stop') {
  return {
    id: 'chat-test',
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
    ],
  };
}

async function respond(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: cors,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });
}

async function mock(
  context: BrowserContext,
  url: string,
  handler: (route: Route, body: ChatRequest) => Promise<void>,
) {
  await context.route(url, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    expect(route.request().method()).toBe('POST');
    await handler(route, route.request().postDataJSON() as ChatRequest);
  });
}

async function savedCache(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press(`${mod}+s`);
  const bytes = await readFile((await (await pending).path())!);
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 < tar.length;) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/, '')
        .trim(),
      8,
    );
    if (name === 'bunny_cache.json')
      return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing bunny_cache.json');
}

test('installed DeepSeek package persists custom prompts and translates, adopts, undoes and saves through the real workflow', async ({
  page,
  context,
}) => {
  const requests: Array<{ headers: Record<string, string>; body: ChatRequest }> = [];
  await mock(context, endpoint, async (route, body) => {
    requests.push({ headers: await route.request().allHeaders(), body });
    await respond(route, completion('  今天真是好天气。\n一起出去吧。  '));
  });
  await ready(page);
  let frame = await install(page);
  await expect(frame.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await frame.getByLabel('API Key', { exact: true }).pressSequentially('sk-panel-secret');
  await frame.getByLabel('示例原文', { exact: true }).fill('skeleton sk-panel-secret');
  await expect(frame.getByLabel('用户消息预览', { exact: true })).toContainText(
    'skeleton [已隐藏]',
  );
  await frame.getByLabel('API Key', { exact: true }).fill(fakeKey);
  const system = '翻译 {source_lang} → {target_lang}。只给译文。';
  const user = '原文：{text}\n译成 {target_lang}';
  await frame.getByLabel('系统提示词', { exact: true }).fill(system);
  await frame.getByLabel('用户提示词', { exact: true }).fill(user);
  await frame.getByLabel('示例原文', { exact: true }).fill('原文中的 {target_lang} 不展开');
  await expect(frame.getByLabel('用户消息预览', { exact: true })).toContainText(
    '原文中的 {target_lang} 不展开',
  );
  expect(requests).toHaveLength(0);
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已保存');
  await closePanel(page);
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  frame = await settings(page);
  await expect(frame.getByLabel('API Key', { exact: true })).toHaveValue(fakeKey);
  await expect(frame.getByLabel('系统提示词', { exact: true })).toHaveValue(system);
  await expect(frame.getByLabel('用户提示词', { exact: true })).toHaveValue(user);
  await closePanel(page);
  await project(page, '今日は{text}いい天気ですね。');
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  const translated = '今天真是好天气。\n一起出去吧。';
  await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue(translated);
  expect(requests).toHaveLength(1);
  expect(requests[0].headers.authorization).toBe(`Bearer ${fakeKey}`);
  expect(requests[0].headers['content-type']).toContain('application/json');
  expect(requests[0].body).toMatchObject({
    model: 'deepseek-flash',
    stream: false,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: '翻译 日本語 → 简体中文。只给译文。' },
      { role: 'user', content: '原文：今日は{text}いい天気ですね。\n译成 简体中文' },
    ],
  });
  const human = page.getByRole('textbox', { name: '翻译内容', exact: true });
  await expect(human).toHaveText('');
  await page.getByRole('button', { name: '采用机器译文', exact: true }).click();
  await expect(human.locator('p')).toHaveText(translated.split('\n'));
  await human.press(`${mod}+z`);
  await expect(human).toHaveText('');
  await human.blur();
  expect((await savedCache(page))[0]).toMatchObject({
    originalText: '今日は{text}いい天気ですね。',
    machineTranslation: translated,
    lastTranslationService: provider,
  });
});

test('compatible HTTPS endpoint and custom model omit DeepSeek extensions and settings take effect without reactivation', async ({
  page,
  context,
}) => {
  const compatible = 'https://translation.example.test/v1/chat/completions';
  const bodies: ChatRequest[] = [];
  await mock(context, compatible, async (route, body) => {
    bodies.push(body);
    await respond(route, completion(`兼容译文 ${bodies.length}`));
  });
  await ready(page);
  await configure(page);
  await project(page, 'テスト');
  const frame = await settings(page);
  await frame.getByLabel('API 地址', { exact: true }).fill(compatible);
  await frame.getByLabel('请求模式', { exact: true }).selectOption('openai');
  await frame.getByLabel('模型', { exact: true }).fill('my-compatible-model');
  await frame.getByLabel('用户提示词', { exact: true }).fill('翻译这段文字：{text}');
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已保存');
  await closePanel(page);
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue('兼容译文 1');
  expect(bodies[0].model).toBe('my-compatible-model');
  expect(bodies[0]).not.toHaveProperty('thinking');
  expect(bodies[0].messages[1]).toEqual({ role: 'user', content: '翻译这段文字：テスト' });
  const again = await settings(page);
  await again.getByLabel('用户提示词', { exact: true }).fill('新的提示：{text}');
  await again.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(again.locator('#status')).toContainText('已保存');
  await closePanel(page);
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue('兼容译文 2');
  expect(bodies[1].messages[1]).toEqual({ role: 'user', content: '新的提示：テスト' });
});

test('cancelled and stale API replies never overwrite the document and a later request still succeeds', async ({
  page,
  context,
}) => {
  const waiting: Array<() => void> = [];
  const finished: number[] = [];
  await mock(context, endpoint, async (route) => {
    const index = waiting.length;
    await new Promise<void>((release) => waiting.push(release));
    try {
      await respond(route, completion(`回复 ${index + 1}`));
    } catch (error) {
      // Fetch cancellation may destroy the intercepted network request first.
      if (!/closed|handled|aborted|cancel/i.test(String(error))) throw error;
    }
    finished.push(index);
  });
  await ready(page);
  await configure(page);
  await project(page, '原文 A');
  const original = page.getByLabel('OCR 原文', { exact: true });
  const translated = page.getByLabel('机器译文', { exact: true });
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect.poll(() => waiting.length).toBe(1);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.locator('.assistance-progress')).toContainText('已取消');
  waiting[0]();
  await expect.poll(() => finished).toContain(0);
  await expect(translated).toHaveValue('');
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect.poll(() => waiting.length).toBe(2);
  await original.fill('原文 B');
  waiting[1]();
  await expect(page.locator('.assistance-progress')).toContainText('已写入 0 项');
  await expect(original).toHaveValue('原文 B');
  await expect(translated).toHaveValue('');
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect.poll(() => waiting.length).toBe(3);
  waiting[2]();
  await expect(translated).toHaveValue('回复 3');
  expect((await savedCache(page))[0]).toMatchObject({
    originalText: '原文 B',
    machineTranslation: '回复 3',
  });
});

test('API errors and truncated output leave the cache unchanged and permit retry', async ({
  page,
  context,
}) => {
  let count = 0;
  await mock(context, endpoint, async (route) => {
    count++;
    if (count === 1) await respond(route, { error: { message: `Bad API key: ${fakeKey}` } }, 401);
    else if (count === 2) await respond(route, completion('不完整译文', 'length'));
    else await respond(route, completion('完整译文'));
  });
  await ready(page);
  await configure(page);
  await project(page, '失敗してから再試行');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '机器翻译', exact: true }).click();
    await expect.poll(() => count).toBe(attempt + 1);
    await expect(page.locator('.assistance-progress')).toContainText('已写入 0 项');
    await expect(page.locator('.toast')).toContainText(attempt === 0 ? 'API Key' : '截断');
    await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue('');
    await expect(page.locator('body')).not.toContainText(fakeKey);
  }
  expect(count).toBe(2);
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue('完整译文');
  expect(count).toBe(3);
});
