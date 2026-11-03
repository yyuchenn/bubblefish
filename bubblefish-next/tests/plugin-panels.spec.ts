import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const projectName = '插件面板入口';
const plugins = [
  {
    source: 'examples/plugins/document-toolbox',
    package: 'example.document-toolbox.bfplugin',
    name: '图片与标记工具箱',
    version: '0.1.0',
    panel: '图片与标记工具箱',
    commands: [],
    ready: '#project',
    readyText: projectName,
  },
  {
    source: 'examples/plugins/history-inspector',
    package: 'example.history-inspector.bfplugin',
    name: '历史与事件检查器',
    version: '0.1.0',
    panel: '历史与事件检查器',
    commands: [],
    ready: '#project',
    readyText: projectName,
  },
  {
    source: 'examples/plugins/edit-guard',
    package: 'example.edit-guard.bfplugin',
    name: '编辑检查插件',
    version: '0.1.0',
    panel: '编辑检查示例',
    commands: ['检查编辑插件主实例'],
    ready: '#result',
    readyText: '编辑检查插件已连接',
  },
  {
    source: 'plugins/deepseek-translation',
    package: 'deepseek-translation-plugin.bfplugin',
    name: 'DeepSeek 翻译',
    version: '0.1.0',
    panel: 'DeepSeek 翻译设置',
    commands: [],
    ready: '#status',
    readyText: 'API Key',
  },
  {
    source: 'plugins/kha-white-ocr',
    package: 'kha-white-ocr-plugin-web.bfplugin',
    name: 'Kha White OCR',
    version: '0.1.0',
    panel: 'Kha White OCR 模型管理',
    commands: ['查询 Kha White OCR 状态', '运行 Kha White OCR 自检', '释放 Kha White OCR 会话'],
    ready: '#model-state',
    readyText: 'web-wasm',
  },
];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  for (const plugin of plugins.filter((entry) => entry.name !== 'Kha White OCR'))
    await promisify(execFile)(process.execPath, ['scripts/package-plugin.mjs', plugin.source]);
  // Reuse the real packaged runtime; no model import or mock OCR is needed to open its panel.
  if (!existsSync(resolve('dist/plugins/kha-white-ocr-plugin-web.bfplugin')))
    await promisify(execFile)(process.execPath, ['plugins/kha-white-ocr/build.mjs', '--web-only'], {
      timeout: 180_000,
    });
});

async function project(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill(projectName);
  await dialog
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  await expect(page.getByRole('textbox', { name: '翻译内容', exact: true })).toBeVisible();
}

async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}

async function checkPanel(frame: FrameLocator, name: string) {
  if (name === '编辑检查插件') {
    await frame.locator('#probe').click();
    await expect(frame.locator('#result')).toContainText('"alive": true');
  } else if (name === 'Kha White OCR') {
    await frame.locator('#refresh').click();
    await expect(frame.locator('#result')).toContainText('状态已更新');
    await frame.locator('#reset').click();
    await expect(frame.locator('#result')).toContainText('推理会话已释放');
  }
}

for (const plugin of plugins) {
  test(`${plugin.name} exposes one panel entry and keeps independent commands after reopening`, async ({
    page,
  }) => {
    await project(page);
    let dialog = await center(page);
    await dialog
      .getByLabel('安装插件包', { exact: true })
      .setInputFiles(resolve('dist/plugins', plugin.package));
    let card = dialog.getByRole('article', { name: plugin.name, exact: true });
    await expect(card.getByText(`${plugin.version} ·`, { exact: false })).toBeVisible();
    await card.getByRole('button', { name: '启用', exact: true }).click();

    for (let round = 0; round < 2; round++) {
      if (round) {
        dialog = await center(page);
        card = dialog.getByRole('article', { name: plugin.name, exact: true });
        await expect(card.getByText('已激活', { exact: true })).toBeVisible();
      }
      const open = card.getByRole('button', { name: plugin.panel, exact: true });
      await expect(open).toHaveCount(1);
      await expect(open).toBeEnabled();
      // Stop, uninstall, one panel entry, and only the remaining functional commands.
      await expect(card.getByRole('button')).toHaveCount(3 + plugin.commands.length);
      for (const title of plugin.commands)
        await expect(card.getByRole('button', { name: title, exact: true })).toBeEnabled();
      await open.click();
      await expect(dialog).not.toBeVisible();
      const panel = page.getByRole('dialog', { name: plugin.panel, exact: true });
      await expect(panel).toBeVisible();
      const frame = page.frameLocator(`iframe[title="${plugin.panel}"]`);
      await expect(frame.locator(plugin.ready)).toContainText(plugin.readyText);
      await checkPanel(frame, plugin.name);
      await panel.getByRole('button', { name: '关闭插件面板', exact: true }).click();
      await expect(panel).not.toBeVisible();
    }
  });
}
