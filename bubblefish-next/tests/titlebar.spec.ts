import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type HeaderPlatform = 'web' | 'windows' | 'macos' | 'linux';
const header = (page: Page) => page.locator('header.titlebar');
const callbacks = (page: Page) => page.getByRole('list', { name: '回调记录' }).locator('li');
const summary = (page: Page, label: string) =>
  header(page)
    .locator('.menu-bar summary')
    .filter({ hasText: new RegExp(`^${label}$`) });
async function box(locator: Locator) {
  return (await locator.boundingBox())!;
}
async function fixture(page: Page, platform: HeaderPlatform) {
  await page.goto(`/tests/fixtures/header/index.html?platform=${platform}`);
  await expect(page.getByRole('status')).toHaveText('夹具就绪');
}
async function approximateHeight(locator: Locator, height: number) {
  expect(Math.abs((await box(locator)).height - height)).toBeLessThanOrEqual(0.1);
}
async function nativeScript(page: Page, platform: 'windows' | 'macos') {
  const cargo = await readFile(resolve('Cargo.lock'), 'utf8');
  expect(cargo).toMatch(/name = "tauri"\r?\nversion = "2\.12\.5"/);
  const source = await readFile(resolve('tests/fixtures/header/tauri-2.12.5-drag.txt'), 'utf8');
  expect(source).toContain('SPDX-License-Identifier: Apache-2.0');
  await page.evaluate(() => {
    const calls: string[] = [];
    Object.assign(window, {
      __headerNativeCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          calls.push(command);
        },
      },
    });
  });
  await page.addScriptTag({
    content: source.replace('__TEMPLATE_os_name__', JSON.stringify(platform)),
  });
}
async function nativeCalls(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __headerNativeCalls: string[] }).__headerNativeCalls,
  );
}
async function clearNativeCalls(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __headerNativeCalls: string[] }).__headerNativeCalls.length = 0;
  });
}

test('web and Linux retain the 49px header without custom native window controls', async ({
  page,
}) => {
  for (const platform of ['web', 'linux'] as const) {
    await fixture(page, platform);
    await approximateHeight(header(page), 49);
    await expect(header(page).getByRole('navigation', { name: '主菜单' })).toBeVisible();
    await expect(header(page).locator('.window-control')).toHaveCount(0);
    await expect(header(page).locator('.native-traffic-spacer')).toHaveCount(0);
    await expect(header(page).getByRole('button', { name: '保存项目', exact: true })).toBeVisible();
    await page.getByLabel('夹具未保存', { exact: true }).check();
    await expect(header(page).locator('.project-switcher > summary')).toContainText('标题栏项目 *');
  }
});

test('Windows uses 32px chrome and 46px controls; callbacks and published maximize state stay distinct', async ({
  page,
}) => {
  await fixture(page, 'windows');
  await approximateHeight(header(page), 32);
  const controls = header(page).locator('.window-control');
  await expect(controls).toHaveCount(3);
  for (const control of await controls.all())
    expect(Math.abs((await box(control)).width - 46)).toBeLessThanOrEqual(0.1);
  await expect(header(page)).toHaveAttribute('data-tauri-drag-region', 'deep');
  await page.getByLabel('夹具未保存', { exact: true }).check();
  await expect(header(page).getByLabel('未保存', { exact: true })).toHaveText('[*]');
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  const maximize = page.getByRole('button', { name: '最大化窗口', exact: true });
  const maximizeIcon = await maximize.locator('svg').innerHTML();
  await maximize.click();
  await expect(callbacks(page)).toHaveText(['minimize', 'maximize']);
  await expect(maximize).toBeVisible(); // Only a host state notification changes the icon.
  await page.getByLabel('夹具最大化', { exact: true }).check();
  const restore = page.getByRole('button', { name: '还原窗口', exact: true });
  await expect(restore).toBeVisible();
  expect(await restore.locator('svg').innerHTML()).not.toBe(maximizeIcon);
  await page.setViewportSize({ width: 980, height: 720 });
  await approximateHeight(header(page), 32);
  await expect(restore).toBeVisible();
  await restore.click();
  await page.getByLabel('夹具最大化', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '最大化窗口', exact: true })).toBeVisible();
  await page.getByLabel('夹具焦点', { exact: true }).uncheck();
  await expect(header(page)).toHaveClass(/window-unfocused/);
  await page.getByLabel('夹具全屏', { exact: true }).check();
  await expect(header(page)).toHaveClass(/window-fullscreen/);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(callbacks(page)).toHaveText(['minimize', 'maximize', 'maximize', 'quit']);
  await page.getByLabel('夹具空工作区', { exact: true }).check();
  await expect(header(page).locator('.project-switcher > summary')).toHaveText('Bubblefish Next');
});

test('macOS leaves a real-traffic-light inset, has no HTML main menu, and follows system light/dark chrome', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await fixture(page, 'macos');
  await approximateHeight(header(page), 28);
  const inset = header(page).locator('.native-traffic-spacer');
  expect(Math.abs((await box(inset)).width - 70)).toBeLessThanOrEqual(0.1);
  await expect(inset.locator('*')).toHaveCount(0);
  await expect(header(page).locator('.window-control')).toHaveCount(0);
  await expect(header(page).getByRole('navigation', { name: '主菜单' })).toHaveCount(0);
  const light = await header(page).evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    color: getComputedStyle(node).color,
  }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => header(page).evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(light.background);
  expect(await header(page).evaluate((node) => getComputedStyle(node).color)).not.toBe(light.color);
  await approximateHeight(header(page), 28);
  await page.getByLabel('夹具未保存', { exact: true }).check();
  await expect(header(page).getByLabel('未保存', { exact: true })).toHaveText('[*]');
  const pane = header(page).getByRole('button', { name: '隐藏左侧面板', exact: true });
  await expect(pane).toHaveAttribute('aria-pressed', 'true');
  await pane.click();
  await expect(
    header(page).getByRole('button', { name: '显示左侧面板', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(callbacks(page)).toHaveText(['left-toggle']);
});

test('800px native windows keep a long dirty title clear of menu, traffic inset and window controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 });
  const title = '很长的漫画汉化项目标题😀'.repeat(25);
  for (const platform of ['windows', 'macos'] as const) {
    await fixture(page, platform);
    await page.getByLabel('夹具项目名称', { exact: true }).fill(title);
    await page.getByLabel('夹具未保存', { exact: true }).check();
    const chooser = header(page).locator('.project-switcher > summary');
    await expect(chooser).toContainText(title);
    const titleBounds = await box(chooser);
    const left = await box(
      header(page).locator(platform === 'windows' ? '.menu-bar' : '.native-traffic-spacer'),
    );
    const right = await box(header(page).locator('.native-titlebar-actions'));
    expect(titleBounds.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(right.x + 1);
    const dirty = await box(header(page).getByLabel('未保存', { exact: true }));
    expect(dirty.x).toBeGreaterThanOrEqual(titleBounds.x);
    expect(dirty.x + dirty.width).toBeLessThanOrEqual(titleBounds.x + titleBounds.width + 1);
    expect(
      await header(page)
        .locator('.project-title')
        .evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
  }
});

test('Windows native menus remain mutually exclusive and interactive descendants never start native dragging', async ({
  page,
}) => {
  await fixture(page, 'windows');
  await nativeScript(page, 'windows');
  await header(page).dispatchEvent('mousedown', {
    button: 0,
    detail: 1,
    clientX: 400,
    clientY: 10,
  });
  await expect.poll(() => nativeCalls(page)).toEqual(['plugin:window|start_dragging']);
  await clearNativeCalls(page);
  await header(page).dispatchEvent('mousedown', {
    button: 0,
    detail: 2,
    clientX: 400,
    clientY: 10,
  });
  await header(page).dispatchEvent('dblclick', { button: 0, detail: 2, clientX: 400, clientY: 10 });
  await expect.poll(() => nativeCalls(page)).toEqual(['plugin:window|internal_toggle_maximize']);
  await clearNativeCalls(page);
  await summary(page, '文件').click();
  await expect(header(page).locator('details[open]')).toHaveCount(1);
  await summary(page, '视图').click();
  await expect(header(page).locator('details[open]')).toHaveCount(1);
  await expect(header(page).locator('details[open] > summary')).toHaveText('视图');
  await header(page).getByRole('button', { name: '适合屏幕', exact: true }).click();
  await expect(callbacks(page)).toHaveText(['zoom:fit']);
  await header(page).locator('.project-switcher > summary').click();
  await header(page).getByRole('button', { name: '另一项目', exact: true }).click();
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await header(page).getByRole('button', { name: '隐藏翻译面板', exact: true }).click();
  await expect(callbacks(page)).toHaveText([
    'zoom:fit',
    'project:secondary',
    'minimize',
    'right-toggle',
  ]);
  expect(await nativeCalls(page)).toEqual([]);
});

test('the locked macOS drag script maximizes once on mouseup and cancels a moved double click', async ({
  page,
}) => {
  await fixture(page, 'macos');
  await nativeScript(page, 'macos');
  await header(page).dispatchEvent('mousedown', {
    button: 0,
    detail: 1,
    clientX: 300,
    clientY: 10,
  });
  expect(await nativeCalls(page)).toEqual(['plugin:window|start_dragging']);
  await clearNativeCalls(page);
  await header(page).dispatchEvent('mousedown', {
    button: 0,
    detail: 2,
    clientX: 300,
    clientY: 10,
  });
  expect(await nativeCalls(page)).toEqual([]);
  await header(page).dispatchEvent('mouseup', { button: 0, detail: 2, clientX: 300, clientY: 10 });
  await header(page).dispatchEvent('dblclick', { button: 0, detail: 2, clientX: 300, clientY: 10 });
  expect(await nativeCalls(page)).toEqual(['plugin:window|internal_toggle_maximize']);
  await clearNativeCalls(page);
  await header(page).dispatchEvent('mousedown', {
    button: 0,
    detail: 2,
    clientX: 300,
    clientY: 10,
  });
  await header(page).dispatchEvent('mouseup', { button: 0, detail: 2, clientX: 320, clientY: 10 });
  expect(await nativeCalls(page)).toEqual([]);
  await header(page).getByRole('button', { name: '隐藏左侧面板', exact: true }).click();
  await header(page).locator('.project-switcher > summary').click();
  await expect(header(page).locator('details[open]')).toHaveCount(1);
  expect(await nativeCalls(page)).toEqual([]);
});
