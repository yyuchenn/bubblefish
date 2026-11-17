import { expect, test, type Page } from '@playwright/test';
import { canvasSheetBounds } from './canvas-actions';

async function fixture(page: Page) {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 2000px; }
      .canvas-viewport {
        position: absolute;
        left: 20px;
        top: 30px;
        width: 800px;
        height: 600px;
        overflow: hidden;
      }
      .canvas-sheet {
        position: absolute;
        left: 0;
        top: 0;
        width: 600px;
        height: 900px;
      }
      #popup { position: fixed; right: 10px; top: 10px; }
    </style>
    <input id="focused" aria-label="保留焦点" />
    <div class="canvas-viewport" role="application" aria-label="图片标注画布">
      <div class="canvas-sheet"></div>
    </div>
    <div id="popup" role="menu">保留菜单</div>
  `);
}

test('canvas bounds wait for changing layout to settle before returning the fitted rectangle', async ({
  page,
}) => {
  await fixture(page);
  const sheet = page.locator('.canvas-sheet');
  await sheet.evaluate((element: HTMLElement) => {
    element.dataset.moving = 'true';
    let frame = 0;
    const move = () => {
      if (element.dataset.moving !== 'true') return;
      frame++;
      element.style.left = `${frame % 100}px`;
      element.style.top = `${frame % 50}px`;
      element.style.width = `${600 + (frame % 100)}px`;
      requestAnimationFrame(move);
    };
    requestAnimationFrame(move);
  });

  let settled = false;
  const measurement = canvasSheetBounds(page);
  void measurement.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          let remaining = 6;
          const frame = () => {
            if (--remaining === 0) done();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
    );
    expect(settled, 'measurement must remain pending while the sheet is moving').toBe(false);
  } finally {
    await sheet.evaluate((element: HTMLElement) => {
      element.dataset.moving = 'false';
      Object.assign(element.style, {
        left: '180px',
        top: '20px',
        width: '360px',
        height: '540px',
      });
    });
  }
  expect(await measurement).toEqual({ x: 200, y: 50, width: 360, height: 540 });
});

test('offscreen canvas measurement preserves scroll, focus, pointer state and open menus', async ({
  page,
}) => {
  await fixture(page);
  await page.locator('#focused').focus();
  await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.canvas-sheet')!;
    Object.assign(sheet.style, { left: '2000px', top: '1000px' });
    const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
    viewport.scrollLeft = 17;
    viewport.scrollTop = 23;
    window.scrollTo(0, 100);
  });
  await page.getByRole('menu').hover();
  await page.evaluate(() => {
    document.documentElement.dataset.pointerEvents = '0';
    for (const type of [
      'pointermove',
      'pointerdown',
      'pointerup',
      'mousemove',
      'mousedown',
      'mouseup',
      'click',
    ])
      document.addEventListener(type, () => {
        document.documentElement.dataset.pointerEvents = String(
          Number(document.documentElement.dataset.pointerEvents) + 1,
        );
      });
    document.addEventListener('pointerdown', () => {
      document.querySelector<HTMLElement>('#popup')!.hidden = true;
    });
  });
  const snapshot = () =>
    page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>('.canvas-sheet')!;
      const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
      const rect = sheet.getBoundingClientRect();
      return {
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: sheet.style.cssText,
        windowScroll: { x: scrollX, y: scrollY },
        canvasScroll: { x: viewport.scrollLeft, y: viewport.scrollTop },
        pointerEvents: document.documentElement.dataset.pointerEvents,
        focused: document.activeElement?.id,
        menuHidden: document.querySelector<HTMLElement>('#popup')!.hidden,
      };
    });
  const before = await snapshot();
  expect(before.bounds.x).toBeGreaterThan(page.viewportSize()!.width);
  expect(await canvasSheetBounds(page)).toEqual(before.bounds);
  expect(await snapshot()).toEqual(before);
  await expect(page.getByRole('menu')).toBeVisible();
});

test('canvas measurement completes with a paused clock without running application timers or frames', async ({
  page,
}) => {
  await fixture(page);
  const start = new Date('2026-11-17T00:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start.getTime() + 1000);
  const before = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.canvas-sheet')!;
    sheet.dataset.timer = 'pending';
    sheet.dataset.frame = 'pending';
    setTimeout(() => (sheet.dataset.timer = 'fired'), 1);
    requestAnimationFrame(() => (sheet.dataset.frame = 'fired'));
    return Date.now();
  });

  expect(await canvasSheetBounds(page)).toEqual({ x: 20, y: 30, width: 600, height: 900 });
  expect(
    await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>('.canvas-sheet')!;
      return { now: Date.now(), timer: sheet.dataset.timer, frame: sheet.dataset.frame };
    }),
  ).toEqual({ now: before, timer: 'pending', frame: 'pending' });
});
