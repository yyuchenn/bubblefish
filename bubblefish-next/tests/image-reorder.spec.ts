import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const images = [1, 2, 3].map((n) => resolve(`tests/fixtures/images/page-${n}.png`));
const original = ['page-1.png', 'page-2.png', 'page-3.png'];
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const list = (page: Page) => page.locator('.image-list');
const ghost = (page: Page) => page.locator('.image-drag-ghost');
const row = (page: Page, filename: string) =>
  page
    .locator('.image-list > .image-row')
    .filter({ has: page.getByText(filename, { exact: true }) });
const button = (page: Page, filename: string) => row(page, filename).locator('.image-select');
const canvas = (page: Page) => page.getByRole('application', { name: '图片标注画布' });
const order = (page: Page) =>
  page.locator('.image-list > .image-row .image-info > span').allTextContents();

type ImageFile = { name: string; mimeType: string; buffer: Buffer };
type ImageGate = { hold: boolean; replies: Array<() => void>; commands: number; pointerId: number };

async function installGate(page: Page) {
  await page.addInitScript(() => {
    const gate: ImageGate = { hold: false, replies: [], commands: 0, pointerId: -1 };
    Object.assign(window, { __imageReorderGate: gate });
    window.addEventListener('pointerdown', (event) => (gate.pointerId = event.pointerId), true);
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
        if (message.method === 'dispatch' && message.args?.[0]?.command?.type === 'reorderImages') {
          this.reorderIds.add(message.id);
          gate.commands++;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    } as typeof Worker;
  });
}
const commandCount = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __imageReorderGate: ImageGate }).__imageReorderGate.commands,
  );
async function project(page: Page, files: string[] | ImageFile[] = images) {
  await installGate(page);
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('图片拖拽回归');
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(files);
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(canvas(page).locator('img')).toBeVisible();
}
async function settings(page: Page) {
  await page.getByRole('button', { name: '项目配置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '修改项目名称', exact: true })).toBeVisible();
}
async function bounds(locator: Locator) {
  return (await locator.boundingBox())!;
}
async function pointerDown(page: Page, locator: Locator) {
  // FLIP can still be restoring a cancelled preview; wait for the source to settle.
  await locator.hover();
  const area = await bounds(locator);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down();
  return area;
}
async function hold(page: Page, filename: string) {
  const area = await pointerDown(page, button(page, filename));
  await expect(ghost(page)).toBeVisible({ timeout: 2500 });
  return area;
}
async function canvasState(page: Page) {
  return canvas(page).evaluate((element) => {
    const image = element.querySelector('img')!,
      sheet = element.querySelector<HTMLElement>('.canvas-sheet')!;
    return {
      src: image.getAttribute('src'),
      alt: image.getAttribute('alt'),
      left: sheet.style.left,
      top: sheet.style.top,
      width: sheet.style.width,
      height: sheet.style.height,
    };
  });
}
async function expectClean(page: Page) {
  await expect(ghost(page)).toHaveCount(0);
  await expect(page.locator('.image-list > .image-row.dragging')).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(original);
  await expect.poll(() => commandCount(page)).toBe(0);
}

test('image dragging requires project settings and a full hold; clicks, delete controls and unchanged drops keep their behavior', async ({
  page,
}) => {
  await project(page);
  await button(page, 'page-2.png').click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  await pointerDown(page, button(page, 'page-1.png'));
  // This is the activation interval under test, rather than a synchronization delay.
  await page.waitForTimeout(1100);
  await expect(ghost(page)).toHaveCount(0);
  await page.mouse.up();
  await settings(page);
  await button(page, 'page-3.png').click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-3.png');
  const moved = await pointerDown(page, button(page, 'page-1.png'));
  await page.mouse.move(moved.x + moved.width / 2 + 15, moved.y + moved.height / 2);
  await page.waitForTimeout(1100);
  await expect(ghost(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-3.png');
  await button(page, 'page-2.png').click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  await button(page, 'page-3.png').click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-3.png');
  await hold(page, 'page-1.png');
  await page.mouse.up();
  await expectClean(page);
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-3.png');

  let confirmations = 0;
  page.on('dialog', (dialog) => {
    confirmations++;
    void dialog.dismiss();
  });
  await pointerDown(page, page.getByRole('button', { name: '删除图片 1', exact: true }));
  await page.waitForTimeout(1100);
  await expect(ghost(page)).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => confirmations).toBe(1);
  await expectClean(page);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('image reorder previews preserve thumbnail, page numbers, selected image and canvas until one acknowledged history change', async ({
  page,
}) => {
  await project(page);
  await settings(page);
  const area = await bounds(canvas(page));
  await page.keyboard.down(mod);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + 30, area.y + area.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(mod);
  const before = await canvasState(page),
    selected = await page.locator('.image-list > .image-row.current').getAttribute('data-image-id');
  await expect(row(page, 'page-2.png').locator('.thumbnail-image img')).toBeVisible();
  await expect
    .poll(() =>
      row(page, 'page-2.png')
        .locator('.thumbnail-image img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  const thumbnail = await row(page, 'page-2.png')
    .locator('.thumbnail-image img')
    .evaluate((image: HTMLImageElement) => image.currentSrc);
  const destination = await bounds(button(page, 'page-3.png'));
  await page.evaluate(() => {
    (window as unknown as { __imageReorderGate: ImageGate }).__imageReorderGate.hold = true;
  });
  const start = await hold(page, 'page-2.png');
  await expect(page.locator('.image-list > .image-row.dragging')).toHaveCount(1);
  await expect(ghost(page)).not.toHaveCSS('box-shadow', 'none');
  await expect(ghost(page).locator('img')).toHaveAttribute('src', thumbnail);
  await expect(ghost(page).locator('img')).toHaveAttribute('draggable', 'false');
  await page.mouse.move(start.x + start.width / 2, destination.y + destination.height - 2, {
    steps: 8,
  });
  await expect.poll(() => order(page)).toEqual(['page-1.png', 'page-3.png', 'page-2.png']);
  await expect(page.locator('.image-list > .image-row .page-index')).toHaveText(['1', '3', '2']);
  await expect.poll(() => commandCount(page)).toBe(0);
  await expect.poll(() => canvasState(page)).toEqual(before);
  await expect(page.locator('.image-list > .image-row.current')).toHaveAttribute(
    'data-image-id',
    selected!,
  );
  expect((await bounds(ghost(page))).y).toBeGreaterThan(start.y + 30);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __imageReorderGate: ImageGate }).__imageReorderGate.replies
            .length,
      ),
    )
    .toBe(1);
  await expect(ghost(page)).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(['page-1.png', 'page-3.png', 'page-2.png']);
  await expect(page.locator('.image-list > .image-row .page-index')).toHaveText(['1', '3', '2']);

  await pointerDown(page, button(page, 'page-3.png'));
  await page.waitForTimeout(1100);
  await expect(ghost(page)).toHaveCount(0);
  const outside = await bounds(list(page));
  await page.mouse.move(outside.x + outside.width + 20, outside.y + 20);
  await page.mouse.up();
  await expect.poll(() => commandCount(page)).toBe(1);
  await page.evaluate(() => {
    const gate = (window as unknown as { __imageReorderGate: ImageGate }).__imageReorderGate;
    gate.hold = false;
    for (const release of gate.replies.splice(0)) release();
  });
  await expect(page.getByRole('button', { name: '图片 3 page-2.png', exact: true })).toBeVisible();
  await expect(page.locator('.image-list > .image-row .page-index')).toHaveText(['1', '2', '3']);
  await expect.poll(() => canvasState(page)).toEqual(before);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(original);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect.poll(() => canvasState(page)).toEqual(before);
});

test('Escape, outside release, pointer cancellation and mode changes discard an image preview; a drop at the beginning commits', async ({
  page,
}) => {
  await project(page);
  await settings(page);
  const before = await canvasState(page);
  // Cancel both before and after activation, then keep holding beyond the old
  // click-suppression timeout. Neither release may select the source image.
  await pointerDown(page, button(page, 'page-3.png'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await page.mouse.up();
  await expectClean(page);
  await expect.poll(() => canvasState(page)).toEqual(before);
  await hold(page, 'page-3.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await page.mouse.up();
  await expectClean(page);
  await expect.poll(() => canvasState(page)).toEqual(before);
  const beginning = await bounds(button(page, 'page-1.png'));
  const previewFirst = async () => {
    await hold(page, 'page-3.png');
    await page.mouse.move(beginning.x + beginning.width / 2, beginning.y + 2, { steps: 8 });
    await expect.poll(() => order(page)).toEqual(['page-3.png', 'page-1.png', 'page-2.png']);
  };
  await previewFirst();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectClean(page);

  await previewFirst();
  const outside = await bounds(list(page));
  await page.mouse.move(outside.x + outside.width + 20, beginning.y + 2);
  await page.mouse.up();
  await expectClean(page);

  await previewFirst();
  const pointerId = await page.evaluate(
    () => (window as unknown as { __imageReorderGate: ImageGate }).__imageReorderGate.pointerId,
  );
  await list(page).dispatchEvent('pointercancel', { pointerId, bubbles: true });
  await page.mouse.up();
  await expectClean(page);

  await previewFirst();
  // Change the component mode while its original pointer remains captured.
  await page
    .getByRole('button', { name: '图片面板', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(ghost(page)).toHaveCount(0);
  await page.mouse.up();
  await expectClean(page);
  await settings(page);
  await previewFirst();
  await page.mouse.up();
  await expect(ghost(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '图片 1 page-3.png', exact: true })).toBeVisible();
  await expect.poll(() => commandCount(page)).toBe(1);
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-1.png');
});

test('an image drag at the list edge autoscrolls and updates insertion without further pointer movement', async ({
  page,
}) => {
  const buffer = await readFile(images[0]);
  const filenames = Array.from(
    { length: 12 },
    (_, n) => `scroll-${String(n + 1).padStart(2, '0')}.png`,
  );
  await project(
    page,
    filenames.map((name) => ({ name, mimeType: 'image/png', buffer })),
  );
  await settings(page);
  await list(page).evaluate((element) => (element.scrollTop = 0));
  await hold(page, filenames[0]);
  const area = await bounds(list(page));
  await page.mouse.move(area.x + area.width / 2, area.y + area.height - 5, { steps: 6 });
  await expect.poll(() => list(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
  await expect
    .poll(() =>
      list(page).evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect.poll(() => order(page)).toEqual([...filenames.slice(1), filenames[0]]);
  await expect.poll(() => commandCount(page)).toBe(0);
  await page.mouse.up();
  await expect(ghost(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `图片 12 ${filenames[0]}`, exact: true }),
  ).toBeVisible();
  await expect.poll(() => commandCount(page)).toBe(1);
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', filenames[0]);
});
