import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';

const legacyPackage = resolve('.cache/legacy-panel-theme.bfplugin');
const plugins = [
  {
    source: 'plugins/deepseek-translation',
    package: 'deepseek-translation-plugin.bfplugin',
    name: 'DeepSeek 翻译',
    panel: 'DeepSeek 翻译设置',
    location: 'modal' as const,
  },
  {
    source: 'plugins/kha-white-ocr',
    package: 'kha-white-ocr-plugin-web.bfplugin',
    name: 'Kha White OCR',
    panel: 'Kha White OCR 模型管理',
    location: 'modal' as const,
  },
  {
    source: 'examples/plugins/document-toolbox',
    package: 'example.document-toolbox.bfplugin',
    name: '图片与标记工具箱',
    panel: '图片与标记工具箱',
    location: 'bottom' as const,
  },
  {
    source: 'examples/plugins/history-inspector',
    package: 'example.history-inspector.bfplugin',
    name: '历史与事件检查器',
    panel: '历史与事件检查器',
    location: 'modal' as const,
  },
  {
    source: 'examples/plugins/edit-guard',
    package: 'example.edit-guard.bfplugin',
    name: '编辑检查插件',
    panel: '编辑检查示例',
    location: 'modal' as const,
  },
];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await mkdir('.cache', { recursive: true });
  await promisify(execFile)(process.execPath, [
    'scripts/package-plugin.mjs',
    'tests/fixtures/panel-theme',
    '--out',
    legacyPackage,
  ]);
  for (const plugin of plugins.filter((entry) => entry.name !== 'Kha White OCR'))
    await promisify(execFile)(process.execPath, ['scripts/package-plugin.mjs', plugin.source]);
  if (!existsSync(resolve('dist/plugins/kha-white-ocr-plugin-web.bfplugin')))
    await promisify(execFile)(process.execPath, ['plugins/kha-white-ocr/build.mjs', '--web-only'], {
      timeout: 180_000,
    });
});

async function ready(page: Page, theme = 'fruit', system: 'light' | 'dark' = 'dark') {
  await page.emulateMedia({ colorScheme: system });
  await page.addInitScript((value) => {
    if (window === window.top) localStorage.setItem('bubblefish.theme', value);
  }, theme);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}

async function installAndOpen(
  page: Page,
  path: string,
  name: string,
  title: string,
  location: 'modal' | 'bottom' = 'modal',
) {
  const manager = await center(page);
  await manager.getByLabel('安装插件包', { exact: true }).setInputFiles(path);
  const card = manager.getByRole('article', { name, exact: true });
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await card.getByRole('button', { name: title, exact: true }).click();
  const iframe = page.locator(`iframe[title="${title}"]`);
  const panel = page.getByRole(location === 'bottom' ? 'tabpanel' : 'dialog', {
    name: title,
    exact: true,
  });
  return {
    iframe,
    panel,
    frame: page.frameLocator(`iframe[title="${title}"]`),
    async close() {
      if (location === 'bottom')
        await page
          .locator('header.titlebar')
          .getByRole('button', { name: '隐藏底部面板', exact: true })
          .click();
      else await panel.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    },
  };
}

async function hostAppearance(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement),
      body = getComputedStyle(document.body);
    const probe = document.createElement('span');
    document.body.append(probe);
    const color = (name: string) => {
      probe.style.color = root.getPropertyValue(name);
      return getComputedStyle(probe).color;
    };
    const result = {
      background: color('--surface'),
      surface: color('--surface2'),
      text: color('--text'),
      strong: color('--strong'),
      border: color('--line'),
      danger: color('--danger'),
      accent: color('--accent'),
      fontFamily: body.fontFamily,
      fontSize: body.fontSize,
      scheme: root.colorScheme,
    };
    probe.remove();
    return result;
  });
}

async function verifyAppearance(page: Page, frame: FrameLocator) {
  const host = await hostAppearance(page);
  await expect
    .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
    .toBe(host.background);
  const actual = await frame.locator('body').evaluate((body) => {
    const computed = getComputedStyle(body);
    const heading = document.querySelector('h1')!;
    return {
      background: computed.backgroundColor,
      text: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      heading: getComputedStyle(heading).color,
    };
  });
  expect(actual).toMatchObject({
    background: host.background,
    text: host.text,
    fontFamily: host.fontFamily,
    fontSize: host.fontSize,
    scheme: host.scheme,
    heading: host.strong,
  });
  const control = frame
    .locator('input:not([type="checkbox"]):not([type="radio"]), textarea, select')
    .first();
  if (await control.count()) {
    const style = await control.evaluate((node) => {
      const css = getComputedStyle(node);
      return {
        background: css.backgroundColor,
        text: css.color,
        border: css.borderTopColor,
        fontFamily: css.fontFamily,
        focused: document.activeElement === node,
      };
    });
    expect(style).toMatchObject({
      background: host.surface,
      text: host.text,
      border: style.focused ? host.accent : host.border,
      fontFamily: host.fontFamily,
    });
  }
}

for (const [theme, system] of [
  ['ocean', 'dark'],
  ['fruit', 'dark'],
  ['dark', 'light'],
] as const) {
  test(`all installed panels follow ${theme} while system appearance is ${system}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await ready(page, theme, system);
    for (const plugin of plugins) {
      const { iframe, panel, frame, close } = await installAndOpen(
        page,
        resolve('dist/plugins', plugin.package),
        plugin.name,
        plugin.panel,
        plugin.location,
      );
      await expect(iframe).toBeVisible();
      await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', theme);
      await verifyAppearance(page, frame);
      await close();
      await expect(panel).not.toBeVisible();
    }
  });
}

async function installedLegacyHtml(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bubblefish-plugins', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const request = database
          .transaction('files')
          .objectStore('files')
          .get(['test.legacy-theme', 'panel.html']);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return blob.text();
    } finally {
      database.close();
    }
  });
}

test('an old panel receives the current theme before becoming visible without changing its installed HTML', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === window.top) return;
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if ((message as { type?: string })?.type === 'appearance-ready') {
        setTimeout(() => Reflect.apply(send, this, [message, transfer]), 700);
      } else Reflect.apply(send, this, [message, transfer]);
    };
  });
  await ready(page);
  const { iframe, frame } = await installAndOpen(
    page,
    legacyPackage,
    '旧面板主题测试',
    '旧面板设置',
  );
  await expect(iframe).toBeAttached();
  await expect(iframe).not.toBeVisible();
  await expect(iframe).toBeVisible();
  await verifyAppearance(page, frame);
  await expect(frame.getByRole('status')).toHaveText('旧 API 已连接');
  const packaged = strFromU8(unzipSync(await readFile(legacyPackage))['panel.html']);
  expect(packaged).toContain('color-scheme: light dark');
  expect(packaged).not.toContain('--bf-panel-');
  expect(await installedLegacyHtml(page)).toBe(packaged);
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as unknown as { legacyApiPortCount: number }).legacyApiPortCount),
  ).toBe(2);
});

test('an unacknowledged theme times out and retries with a fresh theme and working legacy API connection', async ({
  page,
}) => {
  let acceptAppearance = false;
  await page.exposeFunction('__acceptTestPanelAppearance', () => acceptAppearance);
  await page.addInitScript(() => {
    if (window === window.top) return;
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if ((message as { type?: string })?.type === 'appearance-ready') {
        const port = this;
        void (window as unknown as { __acceptTestPanelAppearance: () => Promise<boolean> })
          .__acceptTestPanelAppearance()
          .then((accepted) => {
            if (accepted) Reflect.apply(send, port, [message, transfer]);
          });
      } else Reflect.apply(send, this, [message, transfer]);
    };
  });
  await ready(page);
  const { iframe, panel, frame } = await installAndOpen(
    page,
    legacyPackage,
    '旧面板主题测试',
    '旧面板设置',
  );
  await expect(iframe).toBeAttached();
  await expect(iframe).not.toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('主题初始化超时', { timeout: 10_000 });
  await expect(iframe).not.toBeAttached();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  acceptAppearance = true;
  await panel.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(iframe).toBeVisible();
  await expect(panel.getByRole('alert')).not.toBeAttached();
  await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', 'dark');
  await verifyAppearance(page, frame);
  await expect(frame.getByRole('status')).toHaveText('旧 API 已连接');
  await frame.getByLabel('旧面板文本', { exact: true }).fill('重试后 API 仍可保存');
  await frame.getByRole('button', { name: '保存旧面板配置', exact: true }).click();
  await expect(frame.getByRole('status')).toHaveText('旧 API 已保存');
});

test('live theme changes preserve a legacy form, focus, scroll and background operation while API port stays usable', async ({
  page,
}) => {
  await ready(page);
  const { frame } = await installAndOpen(page, legacyPackage, '旧面板主题测试', '旧面板设置');
  await expect(frame.getByRole('status')).toHaveText('旧 API 已连接');
  await frame.getByRole('button', { name: '开始面板后台计数', exact: true }).click();
  await expect.poll(() => frame.locator('#operation').textContent()).not.toBe('尚未开始');
  const input = frame.getByLabel('旧面板文本', { exact: true });
  await input.fill('尚未保存的输入与选择范围');
  const before = await input.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.setSelectionRange(2, 7);
    window.scrollTo(0, 180);
    const state = window as unknown as {
      legacyPanelInstance: string;
      legacyOperationCounter: number;
    };
    return {
      instance: state.legacyPanelInstance,
      counter: state.legacyOperationCounter,
      scrollY: window.scrollY,
    };
  });
  const installed = await installedLegacyHtml(page);
  for (const theme of ['dark', 'ocean', 'fruit', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', theme);
    await verifyAppearance(page, frame);
  }
  const after = await input.evaluate((node: HTMLTextAreaElement) => {
    const state = window as unknown as {
      legacyPanelInstance: string;
      legacyOperationCounter: number;
    };
    return {
      instance: state.legacyPanelInstance,
      counter: state.legacyOperationCounter,
      scrollY: window.scrollY,
      text: node.value,
      focused: document.activeElement === node,
      start: node.selectionStart,
      end: node.selectionEnd,
    };
  });
  expect(after).toMatchObject({
    instance: before.instance,
    scrollY: before.scrollY,
    text: '尚未保存的输入与选择范围',
    focused: true,
    start: 2,
    end: 7,
  });
  expect(after.counter).toBeGreaterThan(before.counter);
  expect(await installedLegacyHtml(page)).toBe(installed);
  await frame.getByRole('button', { name: '保存旧面板配置', exact: true }).click();
  await expect(frame.getByRole('status')).toHaveText('旧 API 已保存');
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  const manager = await center(page);
  const card = manager.getByRole('article', { name: '旧面板主题测试', exact: true });
  await expect(card.getByLabel('旧面板主题测试 保留文本', { exact: true })).toHaveValue(
    '尚未保存的输入与选择范围',
  );
});

test('rapid theme changes keep the latest appearance and preserve unsaved DeepSeek configuration', async ({
  page,
}) => {
  await ready(page);
  const plugin = plugins[0];
  const { frame } = await installAndOpen(
    page,
    resolve('dist/plugins', plugin.package),
    plugin.name,
    plugin.panel,
  );
  const key = frame.getByLabel('API Key', { exact: true }),
    prompt = frame.getByLabel('用户提示词', { exact: true });
  await key.fill('sk-theme-test-not-a-real-key');
  await prompt.fill('未保存的自定义提示词：{text}');
  const identity = await prompt.evaluate(() => {
    const state = window as unknown as { themeIdentity?: string };
    return (state.themeIdentity = String(Math.random()));
  });
  await page.evaluate(() => {
    for (const value of ['ocean', 'dark', 'fruit', 'ocean', 'dark'])
      document.documentElement.dataset.theme = value;
  });
  await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', 'dark');
  await verifyAppearance(page, frame);
  await expect(key).toHaveValue('sk-theme-test-not-a-real-key');
  await expect(prompt).toHaveValue('未保存的自定义提示词：{text}');
  expect(
    await prompt.evaluate(() => (window as unknown as { themeIdentity: string }).themeIdentity),
  ).toBe(identity);
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已保存');
});
