import { expect, test } from '@playwright/test';
import { deflateSync, gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const pages = 300;
const markersPerPage = 50;
const width = 2048;
const height = 3000;
const filename = (page: number) => `scale-${String(page).padStart(3, '0')}.png`;
const translation = (page: number, marker: number) => `前中后 · 第${page}页第${marker}条翻译😀`;

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Genuine 2048×3000 RGB PNG, kept visually simple so fixture I/O stays small. */
function png() {
  const chunk = (kind: string, bytes: Buffer) => {
    const type = Buffer.from(kind);
    const length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB8, no interlacing.
  const row = Buffer.alloc(width * 3 + 1, 245);
  row[0] = 0;
  const pixels = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(pixels, row.length * y);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Handwritten legacy archive independent of the application and its exporter. */
function bf() {
  const files: Record<string, unknown> = {
    'metadata.json': {
      formatVersion: '1.0',
      projectName: '300页真实规模验收',
      exportDate: '2026-10-28T00:00:00Z',
      sourceLanguage: 'japanese',
      targetLanguage: 'simplifiedChinese',
    },
    'styles.json': [{ id: 'normal', overlayText: false, horizontal: false }],
    'images.json': Array.from({ length: pages }, (_, page) => ({ filename: filename(page + 1) })),
    'markers.json': Array.from({ length: pages }, (_, page) =>
      Array.from({ length: markersPerPage }, (_, marker) => ({
        type: 'point',
        position: [5 + (marker % 10) * 9, 8 + Math.floor(marker / 10) * 18],
        style: 'normal',
        text: translation(page + 1, marker + 1),
      })),
    ),
  };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const content = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (offset: number, length: number, number: number) =>
      header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, content.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    parts.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('300 full-resolution pages and 15,000 markers import, navigate, edit, undo, and release resources through the real UI', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const pngBytes = png(),
    projectBytes = bf();
  // Observe platform URL ownership without reaching into application state.
  await page.addInitScript(() => {
    const active = new Set<string>();
    const stats = { created: 0, revoked: 0, active };
    Object.assign(window, { __scaleUrlStats: stats });
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      active.add(url);
      stats.created++;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (active.delete(url)) stats.revoked++;
      revoke(url);
    };
  });
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    const result = await cdp.send('Performance.getMetrics');
    return result.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
  };
  const heapBefore = await heap();
  const started = performance.now();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click();
  await (
    await chooser
  ).setFiles({ name: 'scale-300.bf', mimeType: 'application/gzip', buffer: projectBytes });
  const matching = page.getByRole('dialog', { name: '匹配项目图片' });
  await expect(matching).toBeVisible({ timeout: 30_000 });
  await matching.getByLabel('匹配图片', { exact: true }).setInputFiles(
    Array.from({ length: pages }, (_, page) => ({
      name: filename(page + 1),
      mimeType: 'image/png',
      buffer: pngBytes,
    })),
  );
  const open = matching.getByRole('button', { name: '打开项目', exact: true });
  await expect(open).toBeEnabled({ timeout: 75_000 });
  await open.click();
  await expect(matching).not.toBeVisible({ timeout: 30_000 });
  const canvas = page.getByRole('application', { name: '图片标注画布' });
  await expect(canvas.locator('img')).toHaveAttribute('alt', filename(1));
  await expect(canvas.locator('.canvas-marker')).toHaveCount(markersPerPage);
  await expect(page.locator('.image-row')).toHaveCount(pages);
  await expect(page.locator('.translation-item')).toHaveCount(markersPerPage);
  await expect(page.locator('.page-number')).toHaveText('1 / 300');
  await expect
    .poll(() => canvas.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(width);
  const importMilliseconds = Math.round(performance.now() - started);
  const heapImported = await heap();
  const initialImages = await page.locator('img').count();
  expect(initialImages).toBeLessThan(30);
  await expect(canvas.locator('img')).toHaveCount(1);

  const jumpStarted = performance.now();
  await page.locator('.page-number').click();
  const jump = page.getByRole('textbox', { name: '跳转页码' });
  await jump.fill('300');
  await jump.press('Enter');
  await expect(canvas.locator('img')).toHaveAttribute('alt', filename(300));
  await expect(page.locator('.page-number')).toHaveText('300 / 300');
  await expect(canvas.locator('.canvas-marker')).toHaveCount(markersPerPage);
  const pageJumpMilliseconds = Math.round(performance.now() - jumpStarted);
  const lastPageImages = await page.locator('img').count();
  expect(lastPageImages).toBeLessThan(30);
  await expect(canvas.locator('img')).toHaveCount(1);

  await page.getByRole('button', { name: '翻译项 26', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  const original = translation(300, 26);
  await expect(editor).toHaveText(original);
  await editor.press('Home');
  await editor.press('ArrowRight');
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
  await page.keyboard.insertText('译');
  await expect(editor).toHaveText(`前译${original.slice(1)}`);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText(original);
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
  const heapEdited = await heap();
  const urlStats = () =>
    page.evaluate(() => {
      const stats = (
        window as unknown as {
          __scaleUrlStats: { created: number; revoked: number; active: Set<string> };
        }
      ).__scaleUrlStats;
      return { created: stats.created, revoked: stats.revoked, active: stats.active.size };
    });
  // Original assets live until project close; temporary thumbnail-decode URLs
  // must already be revoked when their asynchronous jobs settle.
  await expect.poll(async () => (await urlStats()).active).toBe(pages);
  const ownedBeforeClose = await urlStats();
  expect(ownedBeforeClose.created).toBeGreaterThanOrEqual(pages);
  expect(ownedBeforeClose.active).toBe(pages);
  expect(ownedBeforeClose.revoked).toBe(ownedBeforeClose.created - pages);
  await page
    .locator('.app-menu > summary')
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole('button', { name: '关闭项目', exact: true }).click();
  await expect(canvas).not.toBeVisible();
  await expect(page.locator('.image-row')).toHaveCount(0);
  await expect
    .poll(async () => {
      const stats = await urlStats();
      return stats.active === 0 && stats.revoked === stats.created;
    })
    .toBe(true);
  const ownedAfterClose = await urlStats();
  const heapClosed = await heap();
  const cleanBeforeUnload = await page.evaluate(() =>
    window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
  );
  expect(cleanBeforeUnload).toBe(true);
  const observation = {
    pages,
    markersPerPage,
    totalMarkers: pages * markersPerPage,
    width,
    height,
    pngBytes: pngBytes.length,
    bfBytes: projectBytes.length,
    importMilliseconds,
    pageJumpMilliseconds,
    domImages: { initial: initialImages, page300: lastPageImages },
    pageJsHeapBytes: {
      before: heapBefore,
      imported: heapImported,
      afterEditAndUndo: heapEdited,
      closed: heapClosed,
    },
    objectUrls: {
      created: ownedAfterClose.created,
      createdBeforeClose: ownedBeforeClose.created,
      revokedBeforeClose: ownedBeforeClose.revoked,
      revokedAfterClose: ownedAfterClose.revoked,
      activeBeforeClose: ownedBeforeClose.active,
      activeAfterClose: ownedAfterClose.active,
    },
    heapNote:
      'CDP main-page JavaScript heap observation only; excludes decoded-image memory, worker/WASM memory and browser-process memory. No forced GC.',
  };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/scale-observation.json', JSON.stringify(observation, null, 2));
  await test.info().attach('scale-observation.json', {
    body: JSON.stringify(observation, null, 2),
    contentType: 'application/json',
  });
  test
    .info()
    .annotations.push({ type: 'scale-observation', description: JSON.stringify(observation) });
  console.log('Scale observation:', JSON.stringify(observation));
  await cdp.detach();
});
