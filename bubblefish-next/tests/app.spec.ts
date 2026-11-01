import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const imagePaths = [1, 2, 3].map((number) => resolve(`tests/fixtures/images/page-${number}.png`));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
}

async function createProject(page: Page, name: string, images = imagePaths.slice(0, 2)) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill(name);
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(images);
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('application', { name: '图片标注画布' })).toBeVisible();
}

async function sheetBounds(page: Page) {
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(20);
  return (await image.boundingBox())!;
}

async function point(page: Page, x = 0.3, y = 0.3) {
  const count = await page
    .getByRole('application', { name: '图片标注画布' })
    .locator('.canvas-marker')
    .count();
  const box = await sheetBounds(page);
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('.canvas-marker'),
  ).toHaveCount(count + 1);
  await expect(page.locator('.editor-heading strong')).toHaveText(`#${count + 1}`);
  await expect(page.getByRole('textbox', { name: '翻译内容' })).toBeVisible();
}

async function rectangle(page: Page) {
  const count = await page
    .getByRole('application', { name: '图片标注画布' })
    .locator('.canvas-marker')
    .count();
  const box = await sheetBounds(page);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('.canvas-marker'),
  ).toHaveCount(count + 1);
  await expect(page.locator('.editor-heading strong')).toHaveText(`#${count + 1}`);
}

test('WASM matches the native golden command trajectory and final documents', async ({ page }) => {
  // Import the actual compiled Rust module; the application uses the same module in its worker.
  // An image document has no Vite HMR client, so unrelated UI edits cannot
  // reload the execution context halfway through the protocol comparison.
  await page.goto('/tests/fixtures/images/page-1.png');
  const fixture = JSON.parse(
    await readFile(resolve('crates/core/tests/fixtures/runtime-trace.json'), 'utf8'),
  ) as {
    envelopes: unknown[];
    replies: unknown[];
    documents: { id: string }[];
  };
  const result = await page.evaluate(async (trace) => {
    const url = `${location.origin}/src/wasm/bubblefish_wasm.js`;
    const module = await import(/* @vite-ignore */ url);
    await module.default();
    const core = new module.CoreHost();
    try {
      return {
        replies: trace.envelopes.map((envelope) => core.dispatch(envelope)),
        documents: trace.documents.map((document) => core.document(document.id)),
      };
    } finally {
      core.free();
    }
  }, fixture);
  expect(result.replies).toEqual(fixture.replies);
  expect(result.documents).toEqual(fixture.documents);
});

test('creates point and rectangle markers, preserves middle-edit cursor through undo, and saves a BF download', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '往返项目');
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill('译文😀');
  await editor.press('Home');
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(0);
  await editor.press('ArrowRight');
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
  await page.keyboard.insertText('中');
  await expect(editor).toHaveText('译中文😀');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('译文😀');
  await editor.press(`${mod}+Shift+z`);
  await expect(editor).toHaveText('译中文😀');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('译文😀');
  await page.keyboard.insertText('新');
  await expect(editor).toHaveText('译新文😀');
  await rectangle(page);
  await expect(page.getByRole('button', { name: '标记 2', exact: true })).toHaveClass(/rectangle/);
  await editor.fill('框选翻译');
  await editor.press(`${mod}+a`);
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('框选翻译');
  await page.screenshot({ path: test.info().outputPath('workspace.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('往返项目.bf');
  const output = test.info().outputPath('roundtrip.bf');
  await download.saveAs(output);
  expect((await readFile(output)).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  await page.reload();
  await expect(page.getByTestId('ready')).toBeVisible();
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click();
  await (await fileChooser).setFiles(output);
  const openDialog = page.getByRole('dialog');
  await expect(openDialog).toBeVisible();
  const matchingInput = openDialog.locator('input[type=file]');
  if (await matchingInput.count()) await matchingInput.setInputFiles(imagePaths.slice(0, 2));
  else {
    const choose = page.waitForEvent('filechooser');
    await openDialog.getByRole('button', { name: /选择图片|匹配图片|关联图片/ }).click();
    await (await choose).setFiles(imagePaths.slice(0, 2));
  }
  await openDialog.getByRole('button', { name: /打开项目|确认打开/ }).click();
  await expect(openDialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '标记 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '标记 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '翻译内容' })).toHaveText('译新文😀');
  await page.getByRole('button', { name: '翻译项 2', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '翻译内容' }).locator('strong')).toHaveText(
    '框选翻译',
  );
});

test('Tab navigates markers across image boundaries and multiple projects keep independent history', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '项目甲');
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill('甲第一页');
  await editor.press(`${mod}+ArrowRight`);
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('img'),
  ).toHaveAttribute('alt', 'page-2.png');
  await point(page);
  await editor.fill('甲第二页');
  await editor.press('Shift+Tab');
  await expect(editor).toHaveText('甲第一页');
  await editor.press('Tab');
  await expect(editor).toHaveText('甲第二页');
  await createProject(page, '项目乙', imagePaths.slice(2));
  await point(page);
  await editor.fill('乙独立历史');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('');
  await editor.focus();
  await editor.press(`${mod}+Shift+z`);
  await expect(editor).toHaveText('乙独立历史');
  await page.locator('.project-switcher > summary').click();
  await page
    .getByRole('button', { name: /项目甲/ })
    .first()
    .click();
  await page.locator('.project-switcher > summary').click();
  await expect(editor).toHaveText('甲第二页');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('');
  await page.locator('.project-switcher > summary').click();
  await page
    .getByRole('button', { name: /项目乙/ })
    .first()
    .click();
  await expect(editor).toHaveText('乙独立历史');
});

test('image ordering, deletion with undo, marker conversion, and adding after the last image is deleted work', async ({
  page,
}) => {
  await ready(page);
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await createProject(page, '图片管理', [imagePaths[1], imagePaths[0]]);
  await page.getByRole('button', { name: '项目配置', exact: true }).click();
  const first = page.getByRole('button', { name: '图片 1 page-2.png', exact: true }).locator('..');
  const second = page.getByRole('button', { name: '图片 2 page-1.png', exact: true }).locator('..');
  await second.hover();
  const firstBounds = (await first.boundingBox())!,
    secondBounds = (await second.boundingBox())!;
  await page.mouse.move(
    secondBounds.x + secondBounds.width / 2,
    secondBounds.y + secondBounds.height / 2,
  );
  await page.mouse.down();
  await expect(page.locator('.image-drag-ghost')).toBeVisible({ timeout: 2500 });
  await page.mouse.move(firstBounds.x + firstBounds.width / 2, firstBounds.y + 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '图片 1 page-1.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '图片 1 page-1.png', exact: true }).click();
  await point(page);
  await page.getByRole('textbox', { name: '翻译内容' }).fill('删除图片也要保留译文历史');
  await page.getByRole('button', { name: '标记 1', exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: '转换为矩形标记', exact: true }).click();
  await expect(page.getByRole('button', { name: '标记 1', exact: true })).toHaveClass(/rectangle/);
  await page.getByRole('button', { name: '删除图片 1', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '图片 1 page-1.png', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '图片 1 page-1.png', exact: true }).click();
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '翻译内容' })).toHaveText(
    '删除图片也要保留译文历史',
  );
  await expect(page.getByRole('button', { name: '标记 1', exact: true })).toHaveClass(/rectangle/);
  await page.getByRole('button', { name: '删除图片 1', exact: true }).click();
  await page.getByRole('button', { name: '删除图片 1', exact: true }).click();
  await expect(page.getByRole('application', { name: '图片标注画布' })).not.toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加图片', exact: true }).first().click();
  await (await chooser).setFiles(imagePaths[2]);
  await expect(page.getByRole('button', { name: '图片 1 page-3.png', exact: true })).toBeVisible();
  await expect(page.getByRole('application', { name: '图片标注画布' })).toBeVisible();
});

test('a save waits for compositionend and one undo removes the complete synthetic IME group', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '输入法屏障', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await rectangle(page);
  await editor.fill('候选确认后导航的标记');
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(editor).toHaveText('');
  await editor.focus();
  await editor.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中');
  await page.keyboard.insertText('文😀');
  await expect(editor).toHaveText('中文😀');
  await editor.dispatchEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    keyCode: 9,
    isComposing: true,
    bubbles: true,
  });
  await expect(page.locator('.editor-heading strong')).toHaveText('#1');
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  // Synchronize to rendered frames, rather than using a timing delay to mask input races.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(downloads).toBe(0);
  await editor.dispatchEvent('compositionend', { data: '中文😀' });
  const download = await downloadPromise;
  const output = test.info().outputPath('composition.bf');
  await download.saveAs(output);
  const bytes = [...(await readFile(output))];
  const text = await page.evaluate(async (data) => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/wasm/bubblefish_wasm.js`
    );
    await module.default();
    const core = new module.CoreHost();
    try {
      const result = core.importProject(new Uint8Array(data), 'bf', 'composition-copy');
      return result.document.images[0].markers[0].translation.runs
        .map((run: { text: string }) => run.text)
        .join('');
    } finally {
      core.free();
    }
  }, bytes);
  expect(text).toBe('中文😀');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('');
});

test('typing immediately after undo is rebased onto the restored text without losing input', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '快速撤销输入', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill('前后');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
  await page.keyboard.insertText('中');
  await expect(editor).toHaveText('前中后');
  await editor.press(`${mod}+z`);
  // Keep these two events adjacent: an assertion between them would hide the race.
  await page.keyboard.insertText('新');
  await expect(editor).toHaveText('前新后');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText('前新后');
});

test('long press reorders marker numbering and zoom/pan can return an offscreen image', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '画布操作', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill('第一句');
  await rectangle(page);
  await editor.fill('第二句');
  const source = await page.getByRole('button', { name: '翻译项 2', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: '翻译项 1', exact: true }).boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await expect(page.locator('.translation-item.dragging')).toBeVisible({ timeout: 2500 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText('第二句');
  await expect(page.getByRole('button', { name: '翻译项 2', exact: true })).toContainText('第一句');
  const before = await sheetBounds(page);
  await page.mouse.move(before.x + before.width * 0.8, before.y + before.height * 0.8);
  await page.keyboard.down(mod);
  await page.mouse.wheel(0, -160);
  await page.keyboard.up(mod);
  await expect.poll(async () => (await sheetBounds(page)).width).toBeGreaterThan(before.width);
  const box = await sheetBounds(page);
  await page.keyboard.down(mod);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7 + 2500, box.y + box.height * 0.8 + 1200, {
    steps: 10,
  });
  await page.mouse.up();
  await page.keyboard.up(mod);
  await page.getByRole('button', { name: '图片归位' }).click();
  await expect(page.getByRole('button', { name: '图片归位' })).not.toBeVisible();
  const restored = await sheetBounds(page);
  const canvas = await page.getByRole('application', { name: '图片标注画布' }).boundingBox();
  expect(restored.x + restored.width).toBeGreaterThan(canvas!.x);
  expect(restored.x).toBeLessThan(canvas!.x + canvas!.width);
});

test('automatic timed snapshots can be downloaded, restored with matching images, and deleted', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-28T00:00:00Z') });
  await ready(page);
  await createProject(page, '快照恢复', imagePaths.slice(0, 1));
  await point(page);
  await page.getByRole('textbox', { name: '翻译内容' }).fill('三十秒快照内容');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText(
    '三十秒快照内容',
  );
  await page.clock.runFor(31_500);
  await page.clock.resume();
  await page.getByRole('button', { name: '快照', exact: true }).click();
  const snapshots = page.getByRole('dialog', { name: '项目快照' });
  await expect(snapshots).toContainText('快照恢复');
  const downloadPromise = page.waitForEvent('download');
  await snapshots.getByRole('button', { name: '下载快照' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('快照恢复.bf');
  await snapshots.getByRole('button', { name: '恢复', exact: true }).click();
  const matching = page.getByRole('dialog', { name: '匹配项目图片' });
  await matching.getByLabel('匹配图片').setInputFiles(imagePaths.slice(0, 1));
  await matching.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(matching).not.toBeVisible();
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '翻译内容' })).toHaveText('三十秒快照内容');
  await page.getByRole('button', { name: '快照', exact: true }).click();
  await snapshots.getByRole('button', { name: '删除快照' }).click();
  await expect(snapshots).toContainText('还没有快照');
});

test('legacy MD5-prefixed checksums match renamed images and reject same-name changed content', async ({
  page,
}) => {
  await ready(page);
  const original = await readFile(imagePaths[0]);
  const different = await readFile(imagePaths[1]);
  const checksum = `md5:${createHash('md5').update(original).digest('hex').toUpperCase()}`;
  const bytes = await page.evaluate(async (expectedChecksum) => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/wasm/bubblefish_wasm.js`
    );
    await module.default();
    const core = new module.CoreHost();
    try {
      core.dispatch({
        commandId: 'create',
        sessionId: 'checksum-fixture',
        command: {
          type: 'createProject',
          saved: true,
          document: {
            id: 'checksum-project',
            name: '旧校验格式',
            sourceLanguage: 'japanese',
            targetLanguage: 'simplifiedChinese',
            images: [
              {
                id: 'page',
                assetId: 'asset',
                filename: 'original.png',
                checksum: expectedChecksum,
                width: 600,
                height: 900,
                markers: [],
              },
            ],
          },
        },
      });
      return [...core.exportProject('checksum-project', 'bf')];
    } finally {
      core.free();
    }
  }, checksum);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'legacy-checksum.bf',
    mimeType: 'application/gzip',
    buffer: Buffer.from(bytes),
  });
  const dialog = page.getByRole('dialog', { name: '匹配项目图片' });
  const matching = dialog.getByRole('combobox', { name: '匹配 original.png' });
  await dialog
    .getByLabel('匹配图片', { exact: true })
    .setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: different });
  await expect(matching.locator('option')).toHaveCount(2);
  await expect(matching).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '打开项目', exact: true })).toBeDisabled();
  await expect(matching.locator('option').last()).toContainText('校验不同');
  await dialog
    .getByLabel('匹配图片', { exact: true })
    .setInputFiles({ name: 'renamed.png', mimeType: 'image/png', buffer: original });
  await expect(matching.locator('option')).toHaveCount(3);
  await expect(matching).not.toHaveValue('');
  await expect(matching.locator('option:checked')).toHaveText('renamed.png');
  await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('img'),
  ).toHaveAttribute('alt', 'original.png');
});

test('an unrepresentable formatted bracket reports its location but remains recoverable in a local snapshot', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-28T00:00:00Z') });
  await ready(page);
  await createProject(page, '不能导出的恢复快照', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill(']');
  await editor.press(`${mod}+a`);
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText(']');
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("formatted ']' character");
  await expect(page.getByRole('status')).toContainText('images[0].markers[0].translation');
  expect(downloads).toBe(0);
  await page.clock.runFor(31_500);
  await page.clock.resume();
  await page.getByRole('button', { name: '快照', exact: true }).click();
  const snapshots = page.getByRole('dialog', { name: '项目快照' });
  await expect(snapshots).toContainText('不能导出的恢复快照');
  await expect(
    snapshots.getByRole('button', { name: /已保留本地恢复快照；无法下载 BF/ }),
  ).toBeDisabled();
  await snapshots.getByRole('button', { name: '恢复', exact: true }).click();
  const matching = page.getByRole('dialog', { name: '匹配项目图片' });
  await expect(matching).toContainText('不能用旧 BF 格式表达的内容');
  await matching.getByLabel('匹配图片', { exact: true }).setInputFiles(imagePaths.slice(0, 1));
  await matching.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(matching).not.toBeVisible();
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(editor).toHaveText(']');
  await expect(editor.locator('strong')).toHaveText(']');
  await expect(page).toHaveTitle(/● /);
});

test('one IME composition with growing and same-length candidate replacements is a single undo group', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '候选替换分组', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await editor.fill('前后');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
  const ime = await page.context().newCDPSession(page);
  try {
    // Chromium dispatches compositionstart/update/end and native composition input
    // through the actual editing path, including ProseMirror's composition IDs.
    for (const candidate of ['z', 'zh', 'zhong', '中', '忠', '中文', '终文']) {
      await ime.send('Input.imeSetComposition', {
        text: candidate,
        selectionStart: candidate.length,
        selectionEnd: candidate.length,
      });
      await expect(editor).toHaveText(`前${candidate}后`);
    }
    await ime.send('Input.insertText', { text: '中文' });
    await expect(editor).toHaveText('前中文后');
    await editor.press(`${mod}+z`);
    await expect(editor).toHaveText('前后');
    await editor.press(`${mod}+Shift+z`);
    await expect(editor).toHaveText('前中文后');
  } finally {
    await ime.detach();
  }
});

test('typing immediately while undo removes the current marker is retained as a recoverable draft', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, '撤销删标记的输入保全', imagePaths.slice(0, 1));
  await point(page);
  const editor = page.getByRole('textbox', { name: '翻译内容' });
  await expect(editor).toHaveText('');
  await editor.press(`${mod}+z`);
  // Do not wait for the marker to disappear: these keystrokes must race the
  // in-flight history operation so the editor's disposal path is exercised.
  await page.keyboard.insertText('保留');
  await expect(page.getByRole('button', { name: '标记 1', exact: true })).not.toBeVisible();
  const draft = page.getByRole('textbox', { name: '恢复输入草稿', exact: true });
  await expect(draft).toHaveValue('保留');
  await page.getByRole('button', { name: '恢复为标记', exact: true }).click();
  await expect(page.getByRole('button', { name: '标记 1', exact: true })).toBeVisible();
  await expect(editor).toHaveText('保留');
  await expect(draft).not.toBeVisible();
});
