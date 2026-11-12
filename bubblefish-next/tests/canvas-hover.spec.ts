import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const canvas = (page: Page) => page.getByRole('application', { name: '图片标注画布' });
const marker = (page: Page) => canvas(page).getByRole('button', { name: '标记 1', exact: true });
const item = (page: Page) => page.getByRole('button', { name: '翻译项 1', exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '翻译内容' });
const tooltip = (page: Page) => page.getByRole('tooltip', { name: '译文预览' });
type Box = { x: number; y: number; width: number; height: number };
type PinFrame = {
  boxes: Box[];
  tip: { x: number; y: number };
  anchor: { x: number; y: number };
};

async function bounds(locator: Locator) {
  return (await locator.boundingBox())!;
}

async function project(page: Page, x = 0.3473, y = 0.4187) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('悬浮显示回归');
  await dialog
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const image = await bounds(canvas(page).locator('img'));
  await page.mouse.click(image.x + image.width * x, image.y + image.height * y);
  await expect(marker(page)).toBeVisible();
  await expect(page.locator('.editor-heading strong')).toHaveText('#1');
}

async function emptyHover(page: Page) {
  const area = await bounds(canvas(page));
  await page.mouse.move(area.x + 5, area.y + 5);
}

async function previewLayout(page: Page) {
  return tooltip(page).evaluate((element) => {
    const content = element.querySelector<HTMLElement>('.marker-tooltip-content')!;
    const outer = element.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    const viewport = element.closest('.canvas-viewport')!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      clipped: Math.max(
        outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) - inner.left,
        inner.right -
          outer.right +
          parseFloat(style.borderRightWidth) +
          parseFloat(style.paddingRight),
        outer.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) - inner.top,
        inner.bottom -
          outer.bottom +
          parseFloat(style.borderBottomWidth) +
          parseFloat(style.paddingBottom),
      ),
      overflow: Math.max(
        content.scrollWidth - content.clientWidth,
        content.scrollHeight - content.clientHeight,
      ),
      outside: Math.max(
        viewport.left + 8 - outer.left,
        outer.right - viewport.right + 8,
        viewport.top + 8 - outer.top,
        outer.bottom - viewport.bottom + 8,
      ),
      excessSize: Math.max(
        outer.width - Math.min(320, viewport.width - 16),
        outer.height - Math.min(320, viewport.height - 16),
      ),
    };
  });
}

async function pinFrames(page: Page, count = 10): Promise<PinFrame[]> {
  return marker(page).evaluate(async (element, count) => {
    const svg = element.querySelector<SVGSVGElement>('svg.point-pin')!;
    const number = element.querySelector('.marker-number')!;
    const range = document.createRange();
    range.selectNodeContents(number);
    const box = (rect: DOMRect): Box => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    const frames: PinFrame[] = [];
    for (let n = 0; n < count; n++) {
      await new Promise(requestAnimationFrame);
      const tip = new DOMPoint(12, 32).matrixTransform(svg.getScreenCTM()!);
      const sheet = element.closest('.canvas-sheet')!.getBoundingClientRect();
      const style = (element as HTMLElement).style;
      frames.push({
        boxes: [element, svg, number]
          .map((node) => box(node.getBoundingClientRect()))
          .concat(box(range.getBoundingClientRect())),
        tip: { x: tip.x, y: tip.y },
        anchor: {
          x: sheet.x + (sheet.width * parseFloat(style.left)) / 100,
          y: sheet.y + (sheet.height * parseFloat(style.top)) / 100,
        },
      });
    }
    return frames;
  }, count);
}

function stableFrames(frames: PinFrame[], baseline: PinFrame) {
  for (const frame of frames) {
    for (const [index, box] of frame.boxes.entries())
      for (const field of ['x', 'y', 'width', 'height'] as const)
        expect(
          Math.abs(box[field] - baseline.boxes[index][field]),
          `pin part ${index} ${field}`,
        ).toBeLessThanOrEqual(0.1);
    for (const axis of ['x', 'y'] as const) {
      expect(
        Math.abs(frame.tip[axis] - baseline.tip[axis]),
        `pin tip ${axis} stays still`,
      ).toBeLessThanOrEqual(0.1);
      expect(
        Math.abs(frame.tip[axis] - frame.anchor[axis]),
        `pin tip ${axis} follows image coordinate`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function pan(page: Page) {
  const area = await bounds(canvas(page));
  await page.keyboard.down(mod);
  try {
    await page.mouse.move(area.x + 8, area.y + 8);
    await page.mouse.down();
    await page.mouse.move(area.x + 25.375, area.y + 31.625, { steps: 3 });
    await page.mouse.up();
  } finally {
    await page.keyboard.up(mod);
  }
}

test('short vertical and horizontal rich-text previews contain their full content box', async ({
  page,
}) => {
  await project(page);
  await editor(page).fill('加粗的第一列\n第二列译文');
  await editor(page).press(`${mod}+a`);
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  for (const horizontal of [false, true]) {
    await page.getByRole('checkbox', { name: '横排', exact: true }).setChecked(horizontal);
    await marker(page).hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toHaveText('加粗的第一列\n第二列译文');
    await expect(tooltip(page).locator('.marker-tooltip-content')).toHaveCSS(
      'writing-mode',
      horizontal ? 'horizontal-tb' : 'vertical-rl',
    );
    await expect(tooltip(page).locator('span.bold').first()).toHaveCSS('font-weight', '700');
    // Text presence alone passes even when WebKit collapses the outer box to its padding.
    await expect.poll(async () => (await previewLayout(page)).clipped).toBeLessThanOrEqual(1);
    expect((await previewLayout(page)).overflow).toBeLessThanOrEqual(1);
    await expect(tooltip(page).locator('.marker-tooltip-ellipsis')).toHaveCount(0);
    await expect(tooltip(page)).toHaveCSS('pointer-events', 'none');
    await emptyHover(page);
    await expect(tooltip(page)).toHaveCount(0);
  }
});

test('long previews in both writing directions retain the content box and ellipsis at canvas edges', async ({
  page,
}) => {
  await project(page, 0.97, 0.97);
  await editor(page).fill('长译文用于检查边缘气泡不会超出画布。'.repeat(80));
  for (const horizontal of [false, true]) {
    await page.getByRole('checkbox', { name: '横排', exact: true }).setChecked(horizontal);
    await marker(page).hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page).locator('.marker-tooltip-ellipsis')).toBeVisible();
    await expect.poll(async () => (await previewLayout(page)).clipped).toBeLessThanOrEqual(1);
    const layout = await previewLayout(page);
    expect(layout.overflow).toBeGreaterThan(1);
    expect(layout.excessSize).toBeLessThanOrEqual(1);
    expect(layout.outside).toBeLessThanOrEqual(1);
    await emptyHover(page);
    await expect(tooltip(page)).toHaveCount(0);
  }
});

test('point artwork and number retain their image anchor through hover, list emphasis, selection, zoom and pan', async ({
  page,
}) => {
  await project(page);
  await editor(page).fill('稳定的悬浮预览');
  await page.getByRole('button', { name: '取消选择标记', exact: true }).click();
  for (const zoom of ['fit', 73, 137, 200] as const) {
    await test.step(`zoom ${zoom}`, async () => {
      await page.locator('.zoom-menu > summary').click();
      if (zoom === 'fit') {
        await page.getByRole('button', { name: '适合屏幕', exact: true }).click();
      } else {
        await page.getByRole('slider', { name: '缩放比例' }).fill(String(zoom));
        await page.locator('.zoom-menu > summary').click();
      }
      await page.getByRole('button', { name: '定位标记 1', exact: true }).click();
      await pan(page);
      await emptyHover(page);
      await expect(marker(page)).toHaveCSS('opacity', '0.5');
      const baseline = (await pinFrames(page, 1))[0];

      await marker(page).hover();
      stableFrames(await pinFrames(page), baseline);
      await expect(tooltip(page)).toBeVisible();
      await expect(page.getByRole('group', { name: '标记译文 1', exact: true })).toHaveClass(
        /hovered/,
      );
      await emptyHover(page);
      stableFrames(await pinFrames(page), baseline);
      await expect(marker(page)).toHaveCSS('opacity', '0.5');
      await expect(tooltip(page)).toHaveCount(0);

      await item(page).hover();
      stableFrames(await pinFrames(page), baseline);
      await expect(marker(page)).toHaveClass(/hovered/);
      await expect(marker(page)).toHaveCSS('opacity', '1');
      await expect(tooltip(page)).toHaveCount(0);
      await item(page).click();
      await emptyHover(page);
      stableFrames(await pinFrames(page), baseline);
      await expect(marker(page)).toHaveClass(/selected/);
      await expect(marker(page)).toHaveCSS('opacity', '1');
      await marker(page).hover();
      stableFrames(await pinFrames(page), baseline);
      await expect(tooltip(page)).toBeVisible();
      await emptyHover(page);
      stableFrames(await pinFrames(page), baseline);
      await expect(marker(page)).toHaveCSS('opacity', '1');
      await expect(tooltip(page)).toHaveCount(0);
      await item(page).click();
      await emptyHover(page);
      await expect(marker(page)).not.toHaveClass(/selected/);
    });
  }
});
