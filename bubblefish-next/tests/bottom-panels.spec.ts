import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const fixture = resolve('.cache/bottom-panels.bfplugin');
const otherFixture = resolve('.cache/bottom-panels-other.bfplugin');
const pluginName = '底部页面测试';
const notesTitle = '底部笔记';
const eventsTitle = '底部事件';
const settingsTitle = '底部测试设置';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const header = (page: Page) => page.locator('header.titlebar');
const bottom = (page: Page) => page.getByRole('region', { name: '底部面板', exact: true });
const tabs = (page: Page) => page.getByRole('tablist', { name: '底部面板页面', exact: true });
const frame = (page: Page, title = notesTitle) => page.frameLocator(`iframe[title="${title}"]`);

test.beforeAll(async () => {
  await mkdir('.cache', { recursive: true });
  await promisify(execFile)(process.execPath, [
    'scripts/package-plugin.mjs',
    'tests/fixtures/bottom-panels',
    '--out',
    fixture,
  ]);
  const files = unzipSync(await readFile(fixture));
  const manifest = JSON.parse(strFromU8(files['plugin.json']));
  manifest.id = 'test.bottom-panels-other';
  manifest.name = '底部页面测试乙';
  files['plugin.json'] = strToU8(JSON.stringify(manifest));
  await writeFile(otherFixture, zipSync(files));
});

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
}

async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}

async function install(dialog: Locator, file = fixture, name = pluginName) {
  await dialog.getByLabel('安装插件包', { exact: true }).setInputFiles(file);
  const card = dialog.getByRole('article', { name, exact: true });
  await card.getByRole('button', { name: '启用', exact: true }).click();
  return card;
}

async function setup(page: Page) {
  await ready(page);
  const dialog = await center(page);
  const card = await install(dialog);
  return { dialog, card };
}

async function closeCenter(dialog: Locator) {
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
}

async function createProjectMarker(page: Page) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const create = page.getByRole('dialog', { name: '新建项目', exact: true });
  await create.getByLabel('项目名称', { exact: true }).fill('独立底部工具');
  await create
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  const image = page.getByRole('application', { name: '图片标注画布', exact: true }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  return bounds;
}

test('bottom tools open by default and remember height and collapsed layout', async ({ page }) => {
  await ready(page);
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page).getByRole('button', { name: '收起底部面板', exact: true })).toHaveCount(
    0,
  );
  await expect(
    tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const leftHeight = (await page.locator('.left-panel').boundingBox())!.height;
  const rightHeight = (await page.locator('.translation-panel').boundingBox())!.height;
  const initial = (await bottom(page).boundingBox())!;
  const handle = (await page
    .getByRole('separator', { name: '调整底部面板', exact: true })
    .boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 60, { steps: 5 });
  await page.mouse.up();
  const resized = (await bottom(page).boundingBox())!;
  expect(resized.height).toBeGreaterThan(initial.height + 40);
  expect((await page.locator('.left-panel').boundingBox())!.height).toBe(leftHeight);
  expect((await page.locator('.translation-panel').boundingBox())!.height).toBe(rightHeight);
  await page.reload();
  await expect(bottom(page)).toBeVisible();
  expect((await bottom(page).boundingBox())!.height).toBeCloseTo(resized.height, -1);
  await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  await expect(bottom(page)).not.toBeVisible();
  expect((await page.locator('.left-panel').boundingBox())!.height).toBe(leftHeight);
  expect((await page.locator('.translation-panel').boundingBox())!.height).toBe(rightHeight);
  await page.reload();
  await expect(page.getByTestId('ready')).toHaveText('就绪');
  await expect(bottom(page)).not.toBeVisible();
  await header(page).getByRole('button', { name: '显示底部面板', exact: true }).click();
  await expect(bottom(page)).toBeVisible();
});

test('contributed tabs load lazily and preserve independent pages through hiding and theme changes', async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await closeCenter(dialog);
  await expect(tabs(page).getByRole('tab')).toHaveCount(3);
  await expect(page.locator('iframe')).toHaveCount(0);
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('test.bottom-panels / notes 已连接');
  await expect(page.locator('iframe')).toHaveCount(1);
  await frame(page).getByLabel('页面草稿', { exact: true }).fill('保留笔记草稿');
  const instance = await frame(page).getByLabel('页面实例', { exact: true }).textContent();
  await tabs(page).getByRole('tab', { name: eventsTitle, exact: true }).click();
  await expect(frame(page, eventsTitle).getByRole('status')).toContainText('/ events 已连接');
  await frame(page, eventsTitle).getByLabel('页面草稿', { exact: true }).fill('独立事件草稿');
  await expect(page.locator('iframe')).toHaveCount(2);
  await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(2);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await header(page).getByRole('button', { name: '显示底部面板', exact: true }).click();
  await expect(frame(page, eventsTitle).getByLabel('页面草稿', { exact: true })).toHaveValue(
    '独立事件草稿',
  );
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(frame(page).getByLabel('页面草稿', { exact: true })).toHaveValue('保留笔记草稿');
  await expect(frame(page).getByLabel('页面实例', { exact: true })).toHaveText(instance!);
  await expect(frame(page).locator('html')).toHaveAttribute('data-bf-theme', 'dark');
  await expect(page.locator(`iframe[title="${notesTitle}"]`)).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs(page).getByRole('tab', { name: eventsTitle, exact: true })).toBeFocused();
});

test('saved plugin selection restores after startup and repeated SDK opens expand the same tab', async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await closeCenter(dialog);
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
  await page.reload();
  await expect(tabs(page).getByRole('tab', { name: notesTitle, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
  const instance = await frame(page).getByLabel('页面实例', { exact: true }).textContent();
  for (let round = 0; round < 2; round++) {
    await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
    const manager = await center(page);
    await manager
      .getByRole('article', { name: pluginName, exact: true })
      .getByRole('button', { name: settingsTitle, exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: settingsTitle, exact: true });
    await expect(modal).toBeVisible();
    await expect(frame(page, settingsTitle).getByRole('status')).toContainText('/ settings 已连接');
    await frame(page, settingsTitle)
      .getByRole('button', { name: '通过 SDK 打开底部笔记', exact: true })
      .click();
    await modal.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    await expect(bottom(page)).toBeVisible();
    await expect(tabs(page).getByRole('tab', { name: notesTitle, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(frame(page).getByLabel('页面实例', { exact: true })).toHaveText(instance!);
  }
});

test('same-title tabs belong to separate plugins and disabling the selected owner removes its pages', async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await install(dialog, otherFixture, '底部页面测试乙');
  await closeCenter(dialog);
  const notes = tabs(page).getByRole('tab', { name: notesTitle, exact: true });
  await expect(notes).toHaveCount(2);
  await notes.nth(1).click();
  await expect(frame(page).getByRole('status')).toContainText(
    'test.bottom-panels-other / notes 已连接',
  );
  await notes.nth(0).click();
  await expect(page.locator(`iframe[title="${notesTitle}"]`)).toHaveCount(2);
  const manager = await center(page);
  await manager
    .getByRole('article', { name: pluginName, exact: true })
    .getByRole('button', { name: '停用', exact: true })
    .click();
  await closeCenter(manager);
  await expect(notes).toHaveCount(1);
  await expect(page.locator(`iframe[title="${notesTitle}"]`)).toHaveCount(1);
  await expect(
    tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await notes.click();
  await expect(frame(page).getByRole('status')).toContainText(
    'test.bottom-panels-other / notes 已连接',
  );
});

test('a failed plugin keeps its tab and retries only after an explicit request', async ({
  page,
}) => {
  const { dialog, card } = await setup(page);
  await card.getByLabel(`${pluginName} 模拟激活失败`, { exact: true }).check();
  await closeCenter(dialog);
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(bottom(page).getByRole('alert')).toContainText('底部测试激活失败');
  await expect(tabs(page).getByRole('tab', { name: notesTitle, exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  const manager = await center(page);
  await manager
    .getByRole('article', { name: pluginName, exact: true })
    .getByLabel(`${pluginName} 模拟激活失败`, { exact: true })
    .uncheck();
  await closeCenter(manager);
  await expect(bottom(page).getByRole('alert')).toBeVisible();
  await bottom(page).getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
});

test('a plugin can request its own bottom page during activation without waiting for itself', async ({
  page,
}) => {
  const { dialog, card } = await setup(page);
  await card.getByLabel(`${pluginName} 激活时打开笔记`, { exact: true }).check();
  await closeCenter(dialog);
  await tabs(page).getByRole('tab', { name: eventsTitle, exact: true }).click();
  await expect(tabs(page).getByRole('tab', { name: notesTitle, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
});

test('bottom original editing and translation work independently of the right panel and survive tab changes', async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await closeCenter(dialog);
  const bounds = await createProjectMarker(page);
  await page.mouse.click(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6);
  const firstMarker = page.getByRole('button', { name: '翻译项 1', exact: true });
  await firstMarker.click();
  await expect(page.getByRole('group', { name: '标记译文 1', exact: true })).toHaveClass(
    /selected/,
  );
  await tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('group', { name: '标记译文 1', exact: true })).toHaveClass(
    /selected/,
  );
  const original = page.getByRole('textbox', { name: 'OCR 原文', exact: true });
  await original.fill('手动输入原文');
  await page.getByLabel('OCR 插件', { exact: true }).selectOption('test.bottom-panels/ocr');
  await page.getByLabel('翻译插件', { exact: true }).selectOption('test.bottom-panels/translator');
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
  await tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }).click();
  await expect(original).toHaveValue('手动输入原文');
  await expect(page.getByLabel('OCR 插件', { exact: true })).toHaveValue('test.bottom-panels/ocr');
  await expect(page.getByLabel('翻译插件', { exact: true })).toHaveValue(
    'test.bottom-panels/translator',
  );
  await page.getByText('视图', { exact: true }).click();
  await header(page)
    .locator('details.app-menu[open]')
    .getByRole('button', { name: '隐藏翻译面板', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '翻译内容', exact: true })).not.toBeVisible();
  await original.fill('右栏关闭后的原文');
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '机器译文', exact: true })).toHaveValue(
    '译文：右栏关闭后的原文',
  );
  await page.getByRole('button', { name: '采用机器译文', exact: true }).click();
  await page.getByText('视图', { exact: true }).click();
  await header(page)
    .locator('details.app-menu[open]')
    .getByRole('button', { name: '显示翻译面板', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '翻译内容', exact: true })).toContainText(
    '译文：右栏关闭后的原文',
  );
});

test('hidden translation tasks remain cancellable and can finish while the bottom panel is collapsed', async ({
  page,
}) => {
  const { dialog, card } = await setup(page);
  await card.getByLabel(`${pluginName} 等待释放译文`, { exact: true }).check();
  await closeCenter(dialog);
  await createProjectMarker(page);
  await page.getByRole('textbox', { name: 'OCR 原文', exact: true }).fill('隐藏任务原文');
  await page.getByLabel('翻译插件', { exact: true }).selectOption('test.bottom-panels/translator');
  const translate = page.getByRole('button', { name: '机器翻译', exact: true });
  const cancel = page.getByRole('button', { name: '取消任务', exact: true });
  const machine = page.locator('textarea[aria-label="机器译文"]');
  await translate.click();
  await expect(page.getByLabel('推理阶段', { exact: true })).toHaveText('等待释放译文');
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('/ notes 已连接');
  await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  await expect(bottom(page)).not.toBeVisible();
  await header(page).getByRole('button', { name: '显示底部面板', exact: true }).click();
  await tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }).click();
  await expect(page.getByLabel('推理阶段', { exact: true })).toHaveText('等待释放译文');
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.locator('.assistance-progress')).toContainText('已取消');
  await expect(machine).toHaveValue('');

  await translate.click();
  await expect(page.getByLabel('推理阶段', { exact: true })).toHaveText('等待释放译文');
  await tabs(page).getByRole('tab', { name: notesTitle, exact: true }).click();
  await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  const manager = await center(page);
  await manager
    .getByRole('article', { name: pluginName, exact: true })
    .getByLabel(`${pluginName} 等待释放译文`, { exact: true })
    .uncheck();
  await closeCenter(manager);
  await expect(bottom(page)).not.toBeVisible();
  await expect(machine).toHaveValue('译文：隐藏任务原文');
  await expect(page.locator('.assistance-progress')).toContainText('已写入 1 项');
  await header(page).getByRole('button', { name: '显示底部面板', exact: true }).click();
  await tabs(page).getByRole('tab', { name: 'OCR 与机器翻译', exact: true }).click();
  await expect(machine).toBeVisible();
  await expect(machine).toHaveValue('译文：隐藏任务原文');
  await expect(cancel).not.toBeVisible();
});
