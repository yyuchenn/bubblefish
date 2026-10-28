import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const images = [1, 2].map((n) => resolve(`tests/fixtures/images/page-${n}.png`));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
type Box = { x: number; y: number; width: number; height: number };
type Gate = {
  mode: 'pass' | 'dispatch' | 'ack';
  requests: Array<() => void>;
  acknowledgements: Array<() => void>;
  seen: Array<{ method: string; command?: { type: string; geometry?: unknown } }>;
  releaseRequest(): void;
  releaseAck(): void;
};

async function installGate(page: Page) {
  await page.addInitScript(() => {
    // Delay the real browser transport, retaining the original Worker and Rust core.
    // The application contains no test hooks or alternative geometry implementation.
    const gate: Gate = {
      mode: 'pass',
      requests: [],
      acknowledgements: [],
      seen: [],
      releaseRequest() {
        this.requests.shift()?.();
      },
      releaseAck() {
        this.acknowledgements.shift()?.();
      },
    };
    Object.assign(window, { __geometryGate: gate });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private geometryIds = new Set<number>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          'message',
          (event: MessageEvent) => {
            if (this.replaying || !this.geometryIds.has(event.data?.id) || gate.mode !== 'ack')
              return;
            event.stopImmediatePropagation();
            gate.acknowledgements.push(() => {
              this.replaying = true;
              this.dispatchEvent(new MessageEvent('message', { data: event.data }));
              this.replaying = false;
            });
          },
          { capture: true },
        );
      }
      postMessage(
        message: {
          id: number;
          method: string;
          args?: Array<{ command?: { type: string; geometry?: unknown } }>;
        },
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const command = message.args?.[0]?.command;
        gate.seen.push({ method: message.method, command });
        const geometry =
          message.method === 'dispatch' && command?.type === 'updateMarker' && !!command.geometry;
        if (geometry) this.geometryIds.add(message.id);
        const send = () => {
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        };
        if (geometry && gate.mode === 'dispatch') gate.requests.push(send);
        else send();
      }
    } as typeof Worker;
  });
}

async function gate(
  page: Page,
  action: 'pass' | 'dispatch' | 'ack' | 'releaseRequest' | 'releaseAck',
) {
  await page.evaluate((action) => {
    const control = (window as unknown as { __geometryGate: Gate }).__geometryGate;
    if (action === 'releaseRequest' || action === 'releaseAck') control[action]();
    else control.mode = action;
  }, action);
}
async function held(page: Page, kind: 'requests' | 'acknowledgements') {
  return page.evaluate(
    (kind) => (window as unknown as { __geometryGate: Gate }).__geometryGate[kind].length,
    kind,
  );
}
async function geometryCommands(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __geometryGate: Gate }).__geometryGate.seen.filter(
        (entry) => entry.command?.type === 'updateMarker' && entry.command.geometry,
      ).length,
  );
}
const canvas = (page: Page) => page.getByRole('application', { name: '图片标注画布' });
const marker = (page: Page, n = 1) =>
  canvas(page).getByRole('button', { name: `标记 ${n}`, exact: true });
async function bounds(locator: Locator) {
  return (await locator.boundingBox())!;
}
async function frames(page: Page, locator: Locator, count = 12): Promise<Box[]> {
  const element = await locator.elementHandle();
  return page.evaluate(
    async ({ element, count }) => {
      const result: Box[] = [];
      for (let n = 0; n < count; n++) {
        await new Promise(requestAnimationFrame);
        const r = element!.getBoundingClientRect();
        result.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
      return result;
    },
    { element, count },
  );
}
function stable(samples: Box[], target: Box) {
  for (const sample of samples)
    for (const field of ['x', 'y', 'width', 'height'] as const)
      expect(
        Math.abs(sample[field] - target[field]),
        `rendered ${field} must retain the pointerup geometry`,
      ).toBeLessThanOrEqual(1);
}

async function project(page: Page, count = 1) {
  await installGate(page);
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪');
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('几何回归');
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(images.slice(0, count));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(canvas(page).locator('img')).toBeVisible();
}
async function addPoint(page: Page, x = 0.35, y = 0.4) {
  const image = await bounds(canvas(page).locator('img'));
  await page.mouse.click(image.x + image.width * x, image.y + image.height * y);
  await expect(marker(page)).toBeVisible();
  return { x, y };
}
async function drag(page: Page, target: Locator, dx: number, dy: number) {
  const start = await bounds(target);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + dx, start.y + start.height / 2 + dy, {
    steps: 5,
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const final = await bounds(target);
  await page.mouse.up();
  return final;
}
async function pinAnchor(page: Page, expected: { x: number; y: number }) {
  const actual = await marker(page).evaluate((element) => {
    const svg = element.querySelector<SVGSVGElement>('svg.point-pin')!;
    const tip = new DOMPoint(12, 32).matrixTransform(svg.getScreenCTM()!);
    const sheet = element.closest('.canvas-sheet')!.getBoundingClientRect();
    return {
      x: tip.x,
      y: tip.y,
      sheet: { x: sheet.x, y: sheet.y, width: sheet.width, height: sheet.height },
      transform: getComputedStyle(element.querySelector('.marker-number')!).transform,
    };
  });
  expect(
    Math.abs(actual.x - (actual.sheet.x + actual.sheet.width * expected.x)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(actual.y - (actual.sheet.y + actual.sheet.height * expected.y)),
  ).toBeLessThanOrEqual(1);
  // Number text stays horizontal; the pin itself carries the anchor transform.
  expect(actual.transform).toBe('none');
}
function bfMarkers(bytes: Buffer): Array<Array<{ position: number[]; size?: number[] }>> {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 < tar.length;) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/, '');
    const size = parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/, '')
        .trim(),
      8,
    );
    if (!name) break;
    if (name === 'markers.json')
      return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing markers.json');
}

test('point pin tip remains on its image coordinate through fit, zoom, pan, selection and hover', async ({
  page,
}) => {
  await project(page);
  const coordinate = await addPoint(page);
  await pinAnchor(page, coordinate);
  for (const value of [50, 200]) {
    await page.locator('.zoom-menu > summary').click();
    await page.getByRole('slider', { name: '缩放比例' }).fill(String(value));
    await page.locator('.zoom-menu > summary').click();
    await pinAnchor(page, coordinate);
  }
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(marker(page)).not.toHaveClass(/selected/);
  await pinAnchor(page, coordinate);
  await marker(page).hover();
  await expect(marker(page)).toHaveClass(/hovered/);
  await pinAnchor(page, coordinate);
  const viewport = await bounds(canvas(page));
  await page.keyboard.down(mod);
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width / 2 + 45,
    viewport.y + viewport.height / 2 + 30,
  );
  await page.mouse.up();
  await page.keyboard.up(mod);
  await pinAnchor(page, coordinate);
});

test('two quick point drags keep their latest preview across delayed acknowledgements and make two history items', async ({
  page,
}) => {
  await project(page);
  await addPoint(page);
  const original = await bounds(marker(page));
  await gate(page, 'ack');
  const first = await drag(page, marker(page), 45, 25);
  await expect.poll(() => held(page, 'acknowledgements')).toBe(1);
  stable(await frames(page, marker(page)), first);
  const second = await drag(page, marker(page), 35, 20);
  stable(await frames(page, marker(page)), second);
  await gate(page, 'releaseAck');
  await expect.poll(() => geometryCommands(page)).toBe(2);
  await expect.poll(() => held(page, 'acknowledgements')).toBe(1);
  stable(await frames(page, marker(page)), second);
  await gate(page, 'releaseAck');
  stable(await frames(page, marker(page)), second);
  await gate(page, 'pass');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Math.abs((await bounds(marker(page))).x - first.x)).toBeLessThan(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => Math.abs((await bounds(marker(page))).x - original.x))
    .toBeLessThan(1);
  await expect(marker(page)).toBeVisible();
});

test('rectangle resize is stable while dispatch is delayed; immediate save and undo await the committed geometry', async ({
  page,
}) => {
  await project(page);
  const image = await bounds(canvas(page).locator('img'));
  await page.mouse.move(image.x + image.width * 0.2, image.y + image.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(image.x + image.width * 0.45, image.y + image.height * 0.4, { steps: 5 });
  await page.mouse.up();
  await expect(marker(page)).toHaveClass(/rectangle/);
  const original = await bounds(marker(page));
  let downloads = 0;
  page.on('download', () => downloads++);
  const download = page.waitForEvent('download');
  await gate(page, 'dispatch');
  await drag(page, page.getByRole('button', { name: '调整标记 se', exact: true }), 40, 30);
  // Keep save adjacent to pointerup; an assertion here would hide a missing barrier.
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => held(page, 'requests')).toBe(1);
  const resized = await bounds(marker(page));
  expect(resized.width).toBeGreaterThan(original.width + 30);
  stable(await frames(page, marker(page)), resized);
  expect(downloads).toBe(0);
  await gate(page, 'releaseRequest');
  const result = await download;
  const output = test.info().outputPath('resized.bf');
  await result.saveAs(output);
  const exported = bfMarkers(await readFile(output))[0][0];
  expect(exported.size![0]).toBeCloseTo((resized.width / image.width) * 100, 1);
  await gate(page, 'ack');
  await drag(page, page.getByRole('button', { name: '调整标记 se', exact: true }), 25, 20);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => held(page, 'acknowledgements')).toBe(1);
  await gate(page, 'releaseAck');
  await expect
    .poll(async () => Math.abs((await bounds(marker(page))).width - resized.width))
    .toBeLessThan(1);
  await gate(page, 'pass');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => Math.abs((await bounds(marker(page))).width - original.width))
    .toBeLessThan(1);
});

test('Escape and a second real touch cancel geometry previews without adding history', async ({
  page,
  context,
}) => {
  await project(page);
  await addPoint(page);
  const original = await bounds(marker(page));
  await page.mouse.move(original.x + 12, original.y + 12);
  await page.mouse.down();
  await page.mouse.move(original.x + 52, original.y + 42);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  stable(await frames(page, marker(page), 4), original);
  expect(await geometryCommands(page)).toBe(0);
  const cdp = await context.newCDPSession(page);
  const a = { x: original.x + 12, y: original.y + 12, id: 1 };
  const moved = { ...a, x: a.x + 40, y: a.y + 25 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [moved, { x: moved.x + 75, y: moved.y + 50, id: 2 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  stable(await frames(page, marker(page), 4), original);
  expect(await geometryCommands(page)).toBe(0);
  await expect(canvas(page).locator('.canvas-marker')).toHaveCount(1);
  await cdp.detach();
});

test('a pending geometry acknowledgement cannot leak the previous page preview into the next page', async ({
  page,
}) => {
  await project(page, 2);
  await addPoint(page, 0.3, 0.35);
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  const coordinate = await addPoint(page, 0.65, 0.6);
  await page.getByRole('button', { name: '上一张图片', exact: true }).click();
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-1.png');
  await gate(page, 'ack');
  await drag(page, marker(page), 45, 30);
  await expect.poll(() => held(page, 'acknowledgements')).toBe(1);
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await gate(page, 'releaseAck');
  await expect(canvas(page).locator('img')).toHaveAttribute('alt', 'page-2.png');
  await expect(canvas(page).locator('.canvas-marker')).toHaveCount(1);
  await pinAnchor(page, coordinate);
  await expect.poll(() => geometryCommands(page)).toBe(1);
});
