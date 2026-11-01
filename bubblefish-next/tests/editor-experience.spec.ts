import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const images = [1, 2].map((n) => resolve(`tests/fixtures/images/page-${n}.png`));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const canvas = (page: Page) => page.getByRole('application', { name: '图片标注画布' });
const marker = (page: Page, n: number) =>
  canvas(page).getByRole('button', { name: `标记 ${n}`, exact: true });
const item = (page: Page, n: number) =>
  page.getByRole('button', { name: `翻译项 ${n}`, exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '翻译内容' });
const tooltip = (page: Page) => page.getByRole('tooltip', { name: '译文预览' });

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
}
async function createProject(page: Page, pages = 1) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('编辑器体验');
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(images.slice(0, pages));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(canvas(page).locator('img')).toBeVisible();
}
async function bounds(locator: Locator) {
  return (await locator.boundingBox())!;
}
async function addPoint(page: Page, x: number, y: number) {
  const count = await canvas(page).locator('.canvas-marker').count();
  const image = await bounds(canvas(page).locator('img'));
  await page.mouse.click(image.x + image.width * x, image.y + image.height * y);
  await expect(canvas(page).locator('.canvas-marker')).toHaveCount(count + 1);
  await expect(page.locator('.editor-heading strong')).toHaveText(`#${count + 1}`);
}
async function addRectangle(page: Page) {
  const count = await canvas(page).locator('.canvas-marker').count();
  const image = await bounds(canvas(page).locator('img'));
  await page.mouse.move(image.x + image.width * 0.6, image.y + image.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(image.x + image.width * 0.8, image.y + image.height * 0.75, { steps: 5 });
  await page.mouse.up();
  await expect(canvas(page).locator('.canvas-marker')).toHaveCount(count + 1);
  await expect(marker(page, count + 1)).toHaveClass(/rectangle/);
  await expect(page.locator('.editor-heading strong')).toHaveText(`#${count + 1}`);
}
async function openSettings(page: Page) {
  await page.locator('.activity-bar').getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置与外观', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function emptyHover(page: Page) {
  const area = await bounds(canvas(page));
  await page.mouse.move(area.x + 5, area.y + 5);
}
async function sheetPosition(page: Page) {
  return canvas(page)
    .locator('.canvas-sheet')
    .evaluate((sheet) => ({
      left: sheet.style.left,
      top: sheet.style.top,
      width: sheet.style.width,
    }));
}
async function expectCentered(page: Page, n: number) {
  await expect
    .poll(() =>
      marker(page, n).evaluate((element) => {
        const viewport = element.closest('.canvas-viewport')!.getBoundingClientRect();
        const sheet = element.closest('.canvas-sheet')!.getBoundingClientRect();
        const marker = element as HTMLElement;
        const rectangle = marker.classList.contains('rectangle');
        const x =
          sheet.x +
          (sheet.width *
            (parseFloat(marker.style.left) +
              (rectangle ? parseFloat(marker.style.width) / 2 : 0))) /
            100;
        const y =
          sheet.y +
          (sheet.height *
            (parseFloat(marker.style.top) +
              (rectangle ? parseFloat(marker.style.height) / 2 : 0))) /
            100;
        return Math.max(
          Math.abs(x - viewport.x - viewport.width / 2),
          Math.abs(y - viewport.y - viewport.height / 2),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

test('point and rectangle emphasis follows canvas, full list row and selection; tooltips respect rich text and direction', async ({
  page,
}) => {
  await ready(page);
  await createProject(page);
  await addPoint(page, 0.25, 0.25);
  await editor(page).fill('粗体预览\n下一行😀');
  await editor(page).press(`${mod}+a`);
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await addRectangle(page);
  await editor(page).fill('横排预览');
  await page.getByRole('checkbox', { name: '横排', exact: true }).check();
  await page.getByRole('button', { name: '取消选择标记', exact: true }).click();
  await emptyHover(page);
  await expect(marker(page, 1)).toHaveCSS('opacity', '0.5');
  await expect(marker(page, 2)).toHaveCSS('opacity', '0.5');

  await marker(page, 1).hover();
  await expect(marker(page, 1)).toHaveCSS('opacity', '1');
  await expect(tooltip(page)).toContainText('粗体预览');
  await expect(tooltip(page).locator('.marker-tooltip-content')).toHaveCSS(
    'writing-mode',
    'vertical-rl',
  );
  await expect(tooltip(page).locator('span.bold').first()).toHaveCSS('font-weight', '700');
  await expect(tooltip(page)).toHaveCSS('pointer-events', 'none');

  await marker(page, 2).hover();
  await expect(marker(page, 1)).toHaveCSS('opacity', '0.5');
  await expect(marker(page, 2)).toHaveCSS('opacity', '1');
  await expect(tooltip(page)).toHaveText('横排预览');
  await expect(tooltip(page).locator('.marker-tooltip-content')).toHaveCSS(
    'writing-mode',
    'horizontal-tb',
  );

  await page.getByRole('button', { name: '定位标记 1', exact: true }).hover();
  await expect(marker(page, 1)).toHaveCSS('opacity', '1');
  await expect(marker(page, 2)).toHaveCSS('opacity', '0.5');
  await expect(tooltip(page)).toHaveCount(0);
  await item(page, 2).hover();
  await expect(marker(page, 2)).toHaveCSS('opacity', '1');
  await expect(tooltip(page)).toHaveCount(0);
  await item(page, 1).click();
  await emptyHover(page);
  await expect(marker(page, 1)).toHaveCSS('opacity', '1');
  await expect(marker(page, 2)).toHaveCSS('opacity', '0.5');

  await addPoint(page, 0.95, 0.95);
  await emptyHover(page);
  await marker(page, 3).hover();
  await expect(tooltip(page)).toHaveCount(0);
  await editor(page).fill('长译文用于检查边缘气泡不会超出画布。'.repeat(80));
  await marker(page, 3).hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page).locator('.marker-tooltip-ellipsis')).toBeVisible();
  const preview = await bounds(tooltip(page)),
    viewport = await bounds(canvas(page));
  expect(preview.width).toBeLessThanOrEqual(320);
  expect(preview.height).toBeLessThanOrEqual(320);
  expect(preview.x).toBeGreaterThanOrEqual(viewport.x);
  expect(preview.y).toBeGreaterThanOrEqual(viewport.y);
  expect(preview.x + preview.width).toBeLessThanOrEqual(viewport.x + viewport.width);
  expect(preview.y + preview.height).toBeLessThanOrEqual(viewport.y + viewport.height);
});

test('editor settings have conservative navigation defaults, persist, and immediately control hover previews', async ({
  page,
}) => {
  await ready(page);
  let settings = await openSettings(page);
  await expect(settings.getByRole('checkbox', { name: '悬浮气泡预览', exact: true })).toBeChecked();
  await expect(
    settings.getByRole('checkbox', { name: '切换标记时自动定位到标记', exact: true }),
  ).not.toBeChecked();
  await settings.getByRole('checkbox', { name: '悬浮气泡预览', exact: true }).uncheck();
  await settings.getByRole('checkbox', { name: '切换标记时自动定位到标记', exact: true }).check();
  await closeSettings(page);
  await page.reload();
  await expect(page.getByTestId('ready')).toHaveText('就绪');
  settings = await openSettings(page);
  await expect(
    settings.getByRole('checkbox', { name: '悬浮气泡预览', exact: true }),
  ).not.toBeChecked();
  await expect(
    settings.getByRole('checkbox', { name: '切换标记时自动定位到标记', exact: true }),
  ).toBeChecked();
  await closeSettings(page);
  await createProject(page);
  await addPoint(page, 0.3, 0.3);
  await editor(page).fill('开关预览');
  await marker(page, 1).hover();
  await expect(tooltip(page)).toHaveCount(0);
  settings = await openSettings(page);
  await settings.getByRole('checkbox', { name: '悬浮气泡预览', exact: true }).check();
  await closeSettings(page);
  await marker(page, 1).hover();
  await expect(tooltip(page)).toHaveText('开关预览');
  settings = await openSettings(page);
  await settings.getByRole('checkbox', { name: '悬浮气泡预览', exact: true }).uncheck();
  await closeSettings(page);
  await marker(page, 1).hover();
  await expect(tooltip(page)).toHaveCount(0);
});

test('automatic locate applies to list and both Tab paths across images while explicit locate and canvas selection keep their behavior', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, 2);
  await addPoint(page, 0.25, 0.25);
  await editor(page).fill('第一页第一项');
  await addPoint(page, 0.7, 0.7);
  await editor(page).fill('第一页第二项');
  await editor(page).press(`${mod}+ArrowRight`);
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  await addPoint(page, 0.75, 0.75);
  await editor(page).fill('第二页第一项');
  await page.getByRole('button', { name: '图片 1 page-1.png', exact: true }).click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-1.png');
  const initial = await sheetPosition(page);
  await item(page, 1).click();
  await expect(editor(page)).toHaveText('第一页第一项');
  await expect.poll(() => sheetPosition(page)).toEqual(initial);
  await page.getByRole('button', { name: '定位标记 1', exact: true }).click();
  await expectCentered(page, 1);
  const explicitlyLocated = await sheetPosition(page);
  await marker(page, 2).click();
  await expect(editor(page)).toHaveText('第一页第二项');
  await expect.poll(() => sheetPosition(page)).toEqual(explicitlyLocated);

  const settings = await openSettings(page);
  await settings.getByRole('checkbox', { name: '切换标记时自动定位到标记', exact: true }).check();
  await closeSettings(page);
  const width = (await sheetPosition(page)).width;
  await item(page, 1).click();
  await expect(editor(page)).toHaveText('第一页第一项');
  await expectCentered(page, 1);
  await editor(page).press('Tab');
  await expect(editor(page)).toHaveText('第一页第二项');
  await expectCentered(page, 2);
  await canvas(page).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(editor(page)).toHaveText('第一页第一项');
  await expectCentered(page, 1);
  await canvas(page).focus();
  await page.keyboard.press('Tab');
  await expect(editor(page)).toHaveText('第一页第二项');
  await expectCentered(page, 2);
  expect((await sheetPosition(page)).width).toBe(width);
  await editor(page).press('Tab');
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  await expect(editor(page)).toHaveText('第二页第一项');
  await expectCentered(page, 1);

  await (
    await openSettings(page)
  )
    .getByRole('checkbox', { name: '切换标记时自动定位到标记', exact: true })
    .uncheck();
  await closeSettings(page);
  await page.getByRole('button', { name: '图片 1 page-1.png', exact: true }).click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-1.png');
  const unchanged = await sheetPosition(page);
  await item(page, 2).click();
  await expect(editor(page)).toHaveText('第一页第二项');
  await editor(page).press('Shift+Tab');
  await expect(editor(page)).toHaveText('第一页第一项');
  await canvas(page).focus();
  await page.keyboard.press('Tab');
  await expect(editor(page)).toHaveText('第一页第二项');
  await expect.poll(() => sheetPosition(page)).toEqual(unchanged);
});

type ReorderGate = { hold: boolean; replies: Array<() => void> };
async function installReorderGate(page: Page) {
  await page.addInitScript(() => {
    const gate: ReorderGate = { hold: false, replies: [] };
    Object.assign(window, { __reorderGate: gate });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private reorderIds = new Set<number>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          'message',
          (event: MessageEvent) => {
            if (this.replaying || !gate.hold || !this.reorderIds.has(event.data?.id)) return;
            event.stopImmediatePropagation();
            gate.replies.push(() => {
              this.replaying = true;
              this.dispatchEvent(new MessageEvent('message', { data: event.data }));
              this.replaying = false;
            });
          },
          { capture: true },
        );
      }
      postMessage(
        message: { id: number; method: string; args?: Array<{ command?: { type: string } }> },
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        if (message.method === 'dispatch' && message.args?.[0]?.command?.type === 'reorderMarkers')
          this.reorderIds.add(message.id);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    } as typeof Worker;
  });
}
const order = (page: Page) =>
  page.locator('.translation-list > .translation-item .translation-preview').allTextContents();
async function holdItem(page: Page, n: number) {
  // Cancellation animates rows back; wait for the intended row to settle before grabbing.
  await item(page, n).hover();
  const box = await bounds(item(page, n));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('.translation-drag-ghost')).toBeVisible({ timeout: 2500 });
  return box;
}

test('long-press reorder shows a moving ghost and live yielding, retains the drop while acknowledgement waits, and cancels cleanly', async ({
  page,
}) => {
  await installReorderGate(page);
  await ready(page);
  await createProject(page);
  for (const [index, text] of ['第一项', '第二项', '第三项'].entries()) {
    await addPoint(page, 0.2 + index * 0.2, 0.3);
    await editor(page).fill(text);
  }
  await expect(item(page, 3)).toContainText('第三项');
  await page.evaluate(() => {
    (window as unknown as { __reorderGate: ReorderGate }).__reorderGate.hold = true;
  });
  const last = await bounds(item(page, 3));
  const start = await holdItem(page, 1);
  await expect(page.locator('.translation-item.dragging')).toHaveCount(1);
  await expect(page.locator('.translation-drag-ghost')).not.toHaveCSS('box-shadow', 'none');
  await page.mouse.move(start.x + start.width / 2 + 10, last.y + last.height - 2, { steps: 8 });
  await expect.poll(() => order(page)).toEqual(['第二项', '第三项', '第一项']);
  await expect(page.locator('.translation-list .translation-number')).toHaveText(['2', '3', '1']);
  await expect(marker(page, 1).locator('.marker-number')).toHaveText('1');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __reorderGate: ReorderGate }).__reorderGate.replies.length,
      ),
    )
    .toBe(0);
  expect((await bounds(page.locator('.translation-drag-ghost'))).y).toBeGreaterThan(start.y + 40);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __reorderGate: ReorderGate }).__reorderGate.replies.length,
      ),
    )
    .toBe(1);
  await expect(page.locator('.translation-drag-ghost')).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(['第二项', '第三项', '第一项']);
  await page.evaluate(() => {
    const gate = (window as unknown as { __reorderGate: ReorderGate }).__reorderGate;
    gate.hold = false;
    for (const release of gate.replies.splice(0)) release();
  });
  await expect(item(page, 3)).toContainText('第一项');

  const selected = await page.locator('.editor-heading strong').textContent();
  const first = await bounds(item(page, 1));
  await holdItem(page, 3);
  await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 8 });
  await expect.poll(() => order(page)).toEqual(['第一项', '第二项', '第三项']);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.translation-drag-ghost')).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(['第二项', '第三项', '第一项']);
  await expect(page.locator('.editor-heading strong')).toHaveText(selected!);

  await holdItem(page, 3);
  await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 8 });
  await expect.poll(() => order(page)).toEqual(['第一项', '第二项', '第三项']);
  const list = await bounds(page.locator('.translation-list'));
  await page.mouse.move(list.x - 20, first.y + 2);
  await page.mouse.up();
  await expect(page.locator('.translation-drag-ghost')).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(['第二项', '第三项', '第一项']);

  await holdItem(page, 3);
  await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 8 });
  await expect.poll(() => order(page)).toEqual(['第一项', '第二项', '第三项']);
  await page.mouse.up();
  await expect(page.locator('.translation-drag-ghost')).toHaveCount(0);
  await expect(item(page, 1)).toContainText('第一项');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['第二项', '第三项', '第一项']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['第一项', '第二项', '第三项']);
});

test('dragging at the list edge scrolls and continues previewing while the pointer stays still', async ({
  page,
}) => {
  await ready(page);
  await createProject(page);
  for (let n = 1; n <= 12; n++) {
    await addPoint(page, 0.1 + ((n - 1) % 4) * 0.2, 0.2 + Math.floor((n - 1) / 4) * 0.25);
    await editor(page).fill(`第${n}项`);
  }
  await expect(item(page, 12)).toContainText('第12项');
  const list = page.locator('.translation-list');
  await list.evaluate((element) => (element.scrollTop = 0));
  await holdItem(page, 1);
  const area = await bounds(list);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height - 5, { steps: 6 });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
  await expect
    .poll(() =>
      list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => order(page))
    .toEqual([...Array.from({ length: 11 }, (_, n) => `第${n + 2}项`), '第1项']);
  await page.mouse.up();
  await expect(page.locator('.translation-drag-ghost')).toHaveCount(0);
  await expect(item(page, 12)).toContainText('第1项');
});
