import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const images = [1, 2].map((index) => resolve(`tests/fixtures/images/page-${index}.png`));
const menus = (page: Page) => page.locator('details[open]');

async function create(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('菜单回归项目');
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(images);
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('application', { name: '图片标注画布' })).toBeVisible();
}
async function location(page: Page, x = 0.35, y = 0.35) {
  const image = page.locator('.canvas-image');
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(20);
  const bounds = (await image.boundingBox())!;
  return { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y };
}
async function addPoint(page: Page) {
  const point = await location(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.canvas-marker')).toHaveCount(1);
}

test('disclosures are mutually exclusive, outside buttons still act, and modal/escape clean up', async ({
  page,
}) => {
  await create(page);
  for (const name of ['文件', '编辑', '视图', '更多']) {
    await page.locator('.menu-bar summary').filter({ hasText: name }).click();
    await expect(menus(page)).toHaveCount(1);
    await expect(menus(page).locator('summary')).toHaveText(name);
  }
  await page.locator('.project-switcher > summary').click();
  await expect(menus(page)).toHaveCount(1);
  await expect(page.locator('.project-switcher')).toHaveAttribute('open', '');
  await page.locator('.zoom-menu > summary').click();
  await expect(menus(page)).toHaveCount(1);
  const slider = page.getByRole('slider', { name: '缩放比例' });
  await slider.click();
  await expect(page.locator('.zoom-menu')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(menus(page)).toHaveCount(0);
  await expect(page.locator('.zoom-menu > summary')).toBeFocused();

  await page.locator('.menu-bar summary').filter({ hasText: '文件' }).click();
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(page.locator('.page-number')).toHaveText('2 / 2');
  await expect(menus(page)).toHaveCount(0);

  await page.locator('.menu-bar summary').filter({ hasText: '更多' }).click();
  await page.getByRole('button', { name: '设置与外观', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(menus(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menus(page)).toHaveCount(0);
});

test('canvas and translation context menus replace each other; the first blank click only dismisses', async ({
  page,
}) => {
  await create(page);
  await addPoint(page);
  const marker = page.getByRole('button', { name: '标记 1', exact: true });
  await marker.click({ button: 'right' });
  await expect(page.locator('.context-menu')).toHaveCount(1);
  await expect(page.locator('.context-menu.floating')).toHaveCount(0);
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click({ button: 'right' });
  await expect(page.locator('.context-menu')).toHaveCount(1);
  await expect(page.locator('.context-menu.floating')).toBeVisible();
  await page.locator('.menu-bar summary').filter({ hasText: '编辑' }).click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(menus(page)).toHaveCount(1);

  const blank = await location(page, 0.65, 0.55);
  await page.mouse.click(blank.x, blank.y);
  await expect(menus(page)).toHaveCount(0);
  await expect(page.locator('.canvas-marker')).toHaveCount(1);
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator('.canvas-marker')).toHaveCount(2);
  await marker.click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  const otherBlank = await location(page, 0.75, 0.7);
  await page.mouse.click(otherBlank.x, otherBlank.y);
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(page.locator('.canvas-marker')).toHaveCount(2);
  await page.mouse.click(otherBlank.x, otherBlank.y);
  await expect(page.locator('.canvas-marker')).toHaveCount(3);
});

test('context actions dismiss before committing; navigation and blur remove stale menus', async ({
  page,
}) => {
  await create(page);
  await addPoint(page);
  const marker = page.getByRole('button', { name: '标记 1', exact: true });
  await marker.click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: '转换为矩形标记', exact: true }).click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(marker).toHaveClass(/rectangle/);
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(page.locator('.canvas-marker')).toHaveCount(1);
  await marker.click({ button: 'right' });
  await page.keyboard.press(`${mod}+ArrowRight`);
  await expect(page.locator('.page-number')).toHaveText('2 / 2');
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await page.locator('.menu-bar summary').filter({ hasText: '文件' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(menus(page)).toHaveCount(0);
});

test('automatic translation scrolling does not dismiss a newly opened canvas menu', async ({
  page,
}) => {
  await create(page);
  for (let index = 0; index < 24; index++) {
    const point = await location(
      page,
      0.15 + (index % 6) * 0.12,
      0.12 + Math.floor(index / 6) * 0.18,
    );
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('.canvas-marker')).toHaveCount(index + 1);
  }
  const list = page.locator('.translation-list');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const previousScrollTop = await list.evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: '标记 1', exact: true }).click({ button: 'right' });
  await expect
    .poll(() => list.evaluate((node) => node.scrollTop))
    .toBeLessThan(previousScrollTop / 2);
  await expect
    .poll(() =>
      list.evaluate((node) => {
        const first = node.querySelector('.translation-item')!.getBoundingClientRect();
        const viewport = node.getBoundingClientRect();
        return first.top >= viewport.top - 1 && first.bottom <= viewport.bottom + 1;
      }),
    )
    .toBe(true);
  await expect(page.locator('.context-menu')).toBeVisible();
  await list.hover();
  await page.mouse.wheel(0, 100);
  await expect(page.locator('.context-menu')).toHaveCount(0);
});
