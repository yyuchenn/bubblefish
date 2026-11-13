import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.beforeAll(async () => {
  await promisify(execFile)(process.execPath, [
    'scripts/package-plugin.mjs',
    'examples/plugins/edit-guard',
  ]);
});

async function setup(page: Page, delay = 160) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await page.keyboard.press(`${mod}+Alt+n`);
  const create = page.getByRole('dialog', { name: '新建项目', exact: true });
  await create.getByLabel('项目名称', { exact: true }).fill('拦截输入回归');
  await create
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(create).not.toBeVisible();
  const canvas = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
  const editor = page.getByRole('textbox', { name: '翻译内容', exact: true });
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  const center = page.getByRole('dialog', { name: '插件管理', exact: true });
  await center
    .getByLabel('安装插件包', { exact: true })
    .setInputFiles(resolve('dist/plugins/example.edit-guard.bfplugin'));
  const card = center.getByRole('article', { name: '编辑检查插件', exact: true });
  await card.getByRole('button', { name: '启用', exact: true }).click();
  const config = card.getByLabel('编辑检查插件 规范化钩子延迟（毫秒，超过 250 模拟超时）', {
    exact: true,
  });
  await config.fill(String(delay));
  await config.press('Tab');
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
  await center.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  return editor;
}

async function savedMarker(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.keyboard.press(`${mod}+s`);
  const bytes = [...(await readFile((await (await downloaded).path())!))];
  return page.evaluate(async (data) => {
    const url = `${location.origin}/src/wasm/bubblefish_wasm.js`;
    const module = await import(/* @vite-ignore */ url);
    await module.default();
    const core = new module.CoreHost();
    try {
      const imported = core.importProject(new Uint8Array(data), 'bf', 'input-check');
      const marker = imported.document.images[0].markers[0];
      return {
        translation: marker.translation.runs.map((run: { text: string }) => run.text).join(''),
        original: marker.bunnyCache?.originalText,
      };
    } finally {
      core.free();
    }
  }, bytes);
}

test('same-length hook rewrites keep input arriving in the middle and preserve one undo group', async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.fill('前１２後');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await page.keyboard.insertText('新');
  await expect(editor).toHaveText('前新12後');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText(
    '前新12後',
  );
  expect((await savedMarker(page)).translation).toBe('前新12後');
  await editor.press(`${mod}+z`);
  await expect(editor).toHaveText('');
  await editor.press(`${mod}+Shift+z`);
  await expect(editor).toHaveText('前新12後');
});

test('rejected input aligns canonical text and retains the complete original recovery draft', async ({
  page,
}) => {
  const editor = await setup(page, 0);
  await editor.fill('１２ [BLOCK]');
  await expect(page.getByRole('textbox', { name: '恢复输入草稿', exact: true })).toHaveValue(
    '１２ [BLOCK]',
  );
  await expect(editor).toHaveText('');
  await editor.fill('继续３');
  await expect(editor).toHaveText('继续3');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText('继续3');
  expect((await savedMarker(page)).translation).toBe('继续3');
});

test('input arriving during a rejected proposal remains in the latest complete recovery draft', async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.fill('１２ [BLOCK]');
  await page.keyboard.insertText('最新');
  await expect(page.getByRole('textbox', { name: '恢复输入草稿', exact: true })).toHaveValue(
    '１２ [BLOCK]最新',
  );
  await expect(editor).not.toHaveText('１２ [BLOCK]最新');
  // A rejected proposal does not poison subsequent document work.
  await editor.fill('安全４');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText('安全4');
  expect((await savedMarker(page)).translation).toBe('安全4');
});

test('IME candidates stay local until the final checked proposal and save waits for confirmation', async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.fill('前後');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText('前後');
  await editor.press('Home');
  await editor.press('ArrowRight');
  const ime = await page.context().newCDPSession(page);
  try {
    for (const candidate of ['１', '１２', '３４']) {
      await ime.send('Input.imeSetComposition', {
        text: candidate,
        selectionStart: candidate.length,
        selectionEnd: candidate.length,
      });
      await expect(editor).toHaveText(`前${candidate}後`);
      await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText(
        '前後',
      );
    }
    await ime.send('Input.insertText', { text: '５６' });
    expect((await savedMarker(page)).translation).toBe('前56後');
    await expect(editor).toHaveText('前56後');
    await editor.press(`${mod}+z`);
    await expect(editor).toHaveText('前後');
    await editor.press(`${mod}+Shift+z`);
    await expect(editor).toHaveText('前56後');
  } finally {
    await ime.detach();
  }
});

test('original-text acknowledgements replay pending edits and rejected originals retain their draft', async ({
  page,
}) => {
  await setup(page);
  const original = page.getByRole('textbox', { name: 'OCR 原文', exact: true });
  await original.fill('前１２後');
  await original.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(1, 1));
  await page.keyboard.insertText('新');
  await expect(original).toHaveValue('前新12後');
  expect((await savedMarker(page)).original).toBe('前新12後');
  await original.fill('拒绝 [BLOCK]');
  await expect(page.getByRole('textbox', { name: '恢复原文草稿', exact: true })).toHaveValue(
    '拒绝 [BLOCK]',
  );
  await expect(original).toHaveValue('前新12後');
  await original.fill('恢复４');
  await expect(original).toHaveValue('恢复4');
  expect((await savedMarker(page)).original).toBe('恢复4');
});

test('save waits for the original-text IME final proposal without submitting intermediate candidates', async ({
  page,
}) => {
  await setup(page);
  const original = page.getByRole('textbox', { name: 'OCR 原文', exact: true });
  await original.focus();
  await original.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('１');
  await page.keyboard.insertText('２😀');
  await expect(original).toHaveValue('１２😀');
  let downloads = 0;
  page.on('download', () => downloads++);
  const saving = savedMarker(page);
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(downloads).toBe(0);
  await original.dispatchEvent('compositionend', { data: '１２😀' });
  expect((await saving).original).toBe('12😀');
  await expect(original).toHaveValue('12😀');
});

test('a timed-out hook fails open, keeps the main provider running and can resume', async ({
  page,
}) => {
  const editor = await setup(page, 400);
  await editor.fill('超时１２');
  await expect(page.getByRole('button', { name: '翻译项 1', exact: true })).toContainText(
    '超时１２',
  );
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  const center = page.getByRole('dialog', { name: '插件管理', exact: true });
  const card = center.getByRole('article', { name: '编辑检查插件', exact: true });
  await expect(card.getByRole('alert')).toContainText('编辑检查已暂停');
  const config = card.getByLabel('编辑检查插件 规范化钩子延迟（毫秒，超过 250 模拟超时）', {
    exact: true,
  });
  await config.fill('0');
  await config.press('Tab');
  await expect(card.getByRole('button', { name: '恢复编辑检查', exact: true })).toBeEnabled();
  await center.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  // Interception failure retires only the hooks role; the main role can still
  // lazily activate and serve a translation with its own event loop.
  await page.getByRole('textbox', { name: 'OCR 原文', exact: true }).fill('still alive');
  await page.getByLabel('翻译插件', { exact: true }).selectOption('example.edit-guard/guard-echo');
  await page.getByRole('button', { name: '机器翻译', exact: true }).click();
  await expect(page.getByLabel('机器译文', { exact: true })).toHaveValue('主实例译文：still alive');
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  await card.getByRole('button', { name: '恢复编辑检查', exact: true }).click();
  await expect(card.getByText('编辑检查已就绪', { exact: true })).toBeVisible();
  await center.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await editor.fill('恢复３４');
  await expect(editor).toHaveText('恢复34');
  expect((await savedMarker(page)).translation).toBe('恢复34');
});
