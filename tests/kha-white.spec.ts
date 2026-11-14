import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const plugin = resolve('dist/plugins/kha-white-ocr-plugin-web.bfplugin');
const model = resolve('dist/models/kha-white-manga-ocr-fp32.bfmodel');
const corrupted = resolve('.cache/kha-corrupt.bfmodel');
const source = resolve('legacy/plugins/kha-white-ocr-plugin/onnx_model/encoder.onnx');
const expected = '今日はいい天気ですね。';
const tokenIds = [2, 2, 1109, 2719, 897, 854, 854, 1847, 3139, 889, 875, 895, 829, 3];
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.describe('real Kha White ONNX OCR', () => {
  test.skip(
    !existsSync(source) && !existsSync(model),
    'Requires the verified local FP32 model files; no mock OCR is used.',
  );
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    if (!existsSync(model))
      await promisify(execFile)(process.execPath, ['plugins/kha-white-ocr/build-model.mjs'], {
        timeout: 120_000,
      });
    if (!existsSync(plugin))
      await promisify(execFile)(
        process.execPath,
        ['plugins/kha-white-ocr/build.mjs', '--web-only'],
        { timeout: 180_000 },
      );
    await mkdir(resolve('.cache'), { recursive: true });
    await copyFile(model, corrupted);
    const file = await open(corrupted, 'r+');
    try {
      const header = Buffer.alloc(30);
      await file.read(header, 0, 30, 0);
      const encoder =
        30 + header.readUInt16LE(26) + header.readUInt16LE(28) + header.readUInt32LE(18);
      await file.read(header, 0, 30, encoder);
      const offset = encoder + 30 + header.readUInt16LE(26) + header.readUInt16LE(28) + 32;
      const byte = Buffer.alloc(1);
      await file.read(byte, 0, 1, offset);
      byte[0] ^= 1;
      await file.write(byte, 0, 1, offset);
    } finally {
      await file.close();
    }
  });
  test.afterAll(async () => {
    await rm(corrupted, { force: true });
  });
  async function center(page: Page) {
    await page.getByRole('button', { name: '插件管理', exact: true }).click();
    return page.getByRole('dialog', { name: '插件管理', exact: true });
  }
  async function panel(page: Page) {
    const dialog = await center(page);
    await dialog.getByRole('button', { name: 'Kha White OCR 模型管理', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Kha White OCR 模型管理"]');
    await expect(frame.locator('#model-state')).toContainText('web-wasm');
    return frame;
  }
  async function savedOriginal(page: Page) {
    const pending = page.waitForEvent('download');
    await page.keyboard.press(`${mod}+s`);
    const bytes = [...(await readFile((await (await pending).path())!))];
    return page.evaluate(async (data) => {
      const wasm = await import(
        /* @vite-ignore */ `${location.origin}/src/wasm/bubblefish_wasm.js`
      );
      await wasm.default();
      const core = new wasm.CoreHost();
      try {
        return core.importProject(new Uint8Array(data), 'bf', 'kha-save').document.images[0]
          .markers[0].bunnyCache;
      } finally {
        core.free();
      }
    }, bytes);
  }
  test('installs a real plugin, imports/cancels/verifies 440 MiB weights, recognizes, saves, undoes and reloads offline', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
      timeout: 30_000,
    });
    const manager = await center(page);
    await manager.getByLabel('安装插件包', { exact: true }).setInputFiles(plugin);
    await manager
      .getByRole('article', { name: 'Kha White OCR', exact: true })
      .getByRole('button', { name: '启用', exact: true })
      .click();
    await manager.getByRole('button', { name: 'Kha White OCR 模型管理', exact: true }).click();
    let frame = page.frameLocator('iframe[title="Kha White OCR 模型管理"]');
    await expect(frame.locator('#model-state')).toContainText('尚未导入模型');
    // A failed first inference must not poison lazy initialization.
    await frame.locator('#test').click();
    await expect(frame.locator('#result')).toContainText('导入');
    await expect(frame.locator('#result')).toHaveAttribute('data-error', 'true');
    await frame.locator('#file').setInputFiles({
      name: 'broken.bfmodel',
      mimeType: 'application/zip',
      buffer: Buffer.from('broken archive'),
    });
    await frame.locator('#import').click();
    await expect(frame.locator('#import-status')).toContainText('导入失败');
    await expect(frame.locator('#import')).toBeEnabled();
    await frame.locator('#file').setInputFiles(model);
    await frame.locator('#import').click();
    await expect
      .poll(
        () =>
          frame.locator('#progress').evaluate((progress: HTMLProgressElement) => progress.value),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(4 * 1024 * 1024);
    await frame.locator('#cancel').click();
    await expect(frame.locator('#import-status')).toContainText('导入已取消');
    await expect(frame.locator('#import')).toBeEnabled();
    const started = Date.now();
    await frame.locator('#import').click();
    await expect
      .poll(
        () =>
          frame.locator('#progress').evaluate((progress: HTMLProgressElement) => progress.value),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(4 * 1024 * 1024);
    const importing = await frame.locator('#progress').evaluate((progress: HTMLProgressElement) => {
      const state = window as unknown as { importThemeIdentity?: string };
      state.importThemeIdentity = String(Math.random());
      return { instance: state.importThemeIdentity, bytes: progress.value };
    });
    const importTheme = await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'dark' ? 'fruit' : 'dark';
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(root).getPropertyValue('--surface');
      document.body.append(probe);
      const background = getComputedStyle(probe).color;
      probe.remove();
      return { name: root.dataset.theme, background };
    });
    await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', importTheme.name);
    await expect
      .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
      .toBe(importTheme.background);
    expect(
      await frame
        .locator('body')
        .evaluate(() => (window as unknown as { importThemeIdentity: string }).importThemeIdentity),
    ).toBe(importing.instance);
    expect(
      await frame.locator('#progress').evaluate((progress: HTMLProgressElement) => progress.value),
    ).toBeGreaterThanOrEqual(importing.bytes);
    await expect(frame.locator('#import-status')).toHaveText('模型导入成功，已持久保存', {
      timeout: 180_000,
    });
    expect(
      await frame
        .locator('body')
        .evaluate(() => (window as unknown as { importThemeIdentity: string }).importThemeIdentity),
    ).toBe(importing.instance);
    await expect(frame.locator('#model-state')).toContainText('模型已导入');
    const importedMs = Date.now() - started;
    // Corrupt the actual encoder bytes, not the advertised digest. The previous
    // complete catalog must stay available after host-side SHA verification fails.
    await expect(frame.locator('#import')).toBeEnabled();
    await frame.locator('#file').setInputFiles(corrupted);
    await frame.locator('#import').click();
    await expect(frame.locator('#import-status')).toContainText('导入失败', { timeout: 120_000 });
    await expect(frame.locator('#result')).toContainText('SHA');
    await expect(frame.locator('#model-state')).toContainText('模型已导入');
    await frame.locator('#test').click();
    await expect(frame.locator('#result')).toContainText('"passed": true', { timeout: 120_000 });
    const selfTest = JSON.parse((await frame.locator('#result').textContent())!);
    expect(selfTest).toMatchObject({ text: expected, tokenIds, backend: 'web-wasm', passed: true });
    await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    const commandManager = await center(page);
    const commandCard = commandManager.getByRole('article', { name: 'Kha White OCR', exact: true });
    await commandCard.getByRole('button', { name: '查询 Kha White OCR 状态', exact: true }).click();
    const stateFeedback = commandCard.getByRole('region', {
      name: '查询 Kha White OCR 状态 执行结果',
      exact: true,
    });
    await expect(stateFeedback).toHaveAttribute('data-state', 'completed');
    await expect(stateFeedback).toContainText('模型已导入');
    await expect(stateFeedback).toContainText('Web WASM 后端');
    await commandCard.getByRole('button', { name: '释放 Kha White OCR 会话', exact: true }).click();
    const resetFeedback = commandCard.getByRole('region', {
      name: '释放 Kha White OCR 会话 执行结果',
      exact: true,
    });
    await expect(resetFeedback).toHaveAttribute('data-state', 'completed');
    await expect(resetFeedback).toContainText('推理会话已释放');
    await commandCard.getByRole('button', { name: '运行 Kha White OCR 自检', exact: true }).click();
    const commandFeedback = commandCard.getByRole('region', {
      name: '运行 Kha White OCR 自检 执行结果',
      exact: true,
    });
    await expect(commandFeedback).toContainText('正在加载', { timeout: 30_000 });
    await expect(commandFeedback.getByRole('progressbar')).toBeVisible();
    await commandFeedback.getByRole('button', { name: '取消命令', exact: true }).click();
    await expect(commandFeedback).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
    await expect(commandFeedback).not.toContainText('OCR 自检通过');
    await commandCard.getByRole('button', { name: '运行 Kha White OCR 自检', exact: true }).click();
    await expect(commandFeedback).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });
    await expect(commandFeedback).toContainText(`OCR 自检通过：${expected}`);
    await commandFeedback.getByText('数据详情', { exact: true }).click();
    await expect(commandFeedback).toContainText('"passed": true');
    await commandManager.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.keyboard.press(`${mod}+Alt+n`);
    const create = page.getByRole('dialog', { name: '新建项目', exact: true });
    await create.getByLabel('项目名称', { exact: true }).fill('真实 Kha White OCR');
    await create
      .getByLabel('选择图片', { exact: true })
      .setInputFiles(resolve('tests/fixtures/kha-white/japanese-smoke.png'));
    await create.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(create).not.toBeVisible();
    const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
    await expect(image).toBeVisible();
    const bounds = (await image.boundingBox())!;
    await page.mouse.move(bounds.x + 1, bounds.y + 1);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1, { steps: 10 });
    await page.mouse.up();
    const original = page.getByLabel('OCR 原文', { exact: true });
    await expect(original).toBeVisible();
    await page
      .getByLabel('OCR 插件', { exact: true })
      .selectOption('kha-white-ocr-plugin/kha-white-ocr');
    await page.getByRole('button', { name: '识别原文', exact: true }).click();
    await expect(original).toHaveValue(expected, { timeout: 30_000 });
    expect(await savedOriginal(page)).toMatchObject({
      originalText: expected,
      lastOcrModel: 'kha-white-ocr-plugin/kha-white-ocr',
    });
    await page.locator('.statusbar').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press(`${mod}+z`);
    await expect(original).toHaveValue('');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect(original).toHaveValue(expected);
    await page.keyboard.press(`${mod}+z`);
    await expect(original).toHaveValue('');
    await page.getByRole('button', { name: '识别原文', exact: true }).click();
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(page.locator('.assistance-progress')).toContainText('已取消');
    await expect(original).toHaveValue('');
    await page.getByRole('button', { name: '识别原文', exact: true }).click();
    await expect(page.locator('.assistance-progress')).toContainText('处理中');
    await original.fill('用户更新的原文');
    await expect(page.locator('.assistance-progress')).toContainText('已写入 0 项', {
      timeout: 30_000,
    });
    await expect(original).toHaveValue('用户更新的原文');
    expect(await savedOriginal(page)).toMatchObject({ originalText: '用户更新的原文' });
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
    frame = await panel(page);
    await expect(frame.locator('#model-state')).toContainText('模型已导入');
    await context.setOffline(true);
    try {
      await frame.locator('#test').click();
      await expect(frame.locator('#result')).toContainText('"passed": true', { timeout: 120_000 });
      expect(JSON.parse((await frame.locator('#result').textContent())!)).toMatchObject({
        text: expected,
        tokenIds,
        passed: true,
      });
    } finally {
      await context.setOffline(false);
    }
    await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    const lifecycle = await center(page);
    const card = lifecycle.getByRole('article', { name: 'Kha White OCR', exact: true });
    await card.getByRole('button', { name: '停用', exact: true }).click();
    await expect(card.getByText('已停用', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '启用', exact: true }).click();
    await lifecycle.getByRole('button', { name: 'Kha White OCR 模型管理', exact: true }).click();
    frame = page.frameLocator('iframe[title="Kha White OCR 模型管理"]');
    await expect(frame.locator('#model-state')).toContainText('模型已导入');
    await frame.locator('#test').click();
    await expect(frame.locator('#result')).toContainText('"passed": true', { timeout: 120_000 });
    await frame.locator('#remove').click();
    await expect(frame.locator('#model-state')).toContainText('尚未导入模型');
    await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    const again = await center(page);
    await again
      .getByRole('article', { name: 'Kha White OCR', exact: true })
      .getByRole('button', { name: '卸载', exact: true })
      .click();
    await expect(again.getByRole('article')).toHaveCount(0);
    expect(failures).toEqual([]);
    await writeFile(
      resolve('.cache/kha-browser-verification.json'),
      `${JSON.stringify({ passed: true, importedMs, selfTest, realPluginInstalled: true, real440MiBModelImported: true, themeChangedDuringModelImport: true, modelImportIframePreserved: true, cancelledImport: true, corruptReplacementRejected: true, commandStatusSummary: true, commandProgressAndCancellation: true, commandRetryAfterCancellation: true, staleResultRejected: true, workflowSavedAndUndoable: true, offlineAfterReload: true, disabledAndReenabled: true, removedAndUninstalled: true }, null, 2)}\n`,
    );
    console.log(`Real Kha White ONNX browser: ${JSON.stringify({ importedMs, selfTest })}`);
  });
});
