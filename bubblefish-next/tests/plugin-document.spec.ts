import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { ImageDocument, ProjectDocument } from '../src/generated/core';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.beforeAll(async () => {
  for (const name of ['document-toolbox', 'history-inspector'])
    await promisify(execFile)(process.execPath, [
      'scripts/package-plugin.mjs',
      `examples/plugins/${name}`,
    ]);
});
async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}
async function setup(page: Page, name: 'document-toolbox' | 'history-inspector', title: string) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  await page.keyboard.press(`${mod}+Alt+n`);
  const create = page.getByRole('dialog', { name: '新建项目', exact: true });
  await create.getByLabel('项目名称', { exact: true }).fill('文档插件回归');
  await create
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(create).not.toBeVisible();
  const dialog = await center(page);
  await dialog
    .getByLabel('安装插件包', { exact: true })
    .setInputFiles(resolve(`dist/plugins/example.${name}.bfplugin`));
  const card = dialog.getByRole('article', { name: title, exact: true });
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await dialog.getByRole('button', { name: title, exact: true }).click();
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  await expect(frame.locator('#project')).toContainText('文档插件回归');
  return frame;
}
async function openToolbox(page: Page) {
  const dialog = await center(page);
  await dialog.getByRole('button', { name: '图片与标记工具箱', exact: true }).click();
  const frame = page.frameLocator('iframe[title="图片与标记工具箱"]');
  await expect(frame.locator('#project')).toContainText('文档插件回归');
  return frame;
}
async function closePanel(page: Page) {
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
}
async function decodeProject(page: Page, bytes: Uint8Array): Promise<ProjectDocument> {
  return page.evaluate(
    async (input) => {
      const url = `${location.origin}/src/wasm/bubblefish_wasm.js`;
      const wasm = await import(/* @vite-ignore */ url);
      await wasm.default();
      const core = new wasm.CoreHost();
      try {
        return core.importProject(new Uint8Array(input), 'bf', 'bundle-test').document;
      } finally {
        core.free();
      }
    },
    [...bytes],
  );
}
async function save(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press(`${mod}+s`);
  return decodeProject(page, await readFile((await (await pending).path())!));
}

test('image replacement, deletion, undo and resource ZIP keep the correct immutable bytes and marker coordinates', async ({
  page,
}) => {
  let frame = await setup(page, 'document-toolbox', '图片与标记工具箱');
  await frame.locator('#marker-create').click();
  await expect(frame.locator('#markers option')).toHaveCount(1);
  await frame.locator('#image-get').click();
  await expect
    .poll(async () => JSON.parse((await frame.getByRole('status').textContent())!))
    .toHaveProperty('filename');
  const original = JSON.parse((await frame.getByRole('status').textContent())!) as ImageDocument;
  await frame.locator('#original').click();
  await expect(frame.locator('#preview')).toBeVisible();
  await frame.locator('#crop').click();
  await expect(frame.getByRole('status')).toContainText('image/png');
  await frame.locator('#upload').setInputFiles(resolve('tests/fixtures/images/page-2.png'));
  await frame.locator('#image-replace').click();
  await expect(frame.getByRole('status')).toContainText('commandId');
  await frame.locator('#image-get').click();
  await expect
    .poll(async () => JSON.parse((await frame.getByRole('status').textContent())!))
    .toHaveProperty('filename');
  const replacement = JSON.parse((await frame.getByRole('status').textContent())!) as ImageDocument;
  expect(replacement.id).toBe(original.id);
  expect(replacement.assetId).not.toBe(original.assetId);
  expect(replacement.markers).toEqual(original.markers);
  await closePanel(page);
  await page.keyboard.press(`${mod}+z`);
  expect((await save(page)).images[0].checksum).toBe(original.checksum);
  await page.keyboard.press(`${mod}+Shift+z`);
  expect((await save(page)).images[0].checksum).toBe(replacement.checksum);
  frame = await openToolbox(page);
  await frame.locator('#image-remove').click();
  await expect(frame.locator('#images option')).toHaveCount(0);
  await closePanel(page);
  await page.keyboard.press(`${mod}+z`);
  expect((await save(page)).images[0]).toMatchObject({
    checksum: replacement.checksum,
    markers: original.markers.map(({ id: _id, ...marker }) => marker),
  });
  // Exporting a resource bundle must preserve the current dirty/saved state.
  frame = await openToolbox(page);
  await frame.locator('#filename').fill('changed.png');
  await frame.locator('#image-rename').click();
  await expect(frame.getByRole('status')).toContainText('commandId');
  await closePanel(page);
  await expect(page.locator('.project-title')).toContainText('*');
  const downloaded = page.waitForEvent('download');
  await page.getByText('文件', { exact: true }).click();
  await page.getByRole('button', { name: '导出项目资源包…', exact: true }).click();
  const files = unzipSync(await readFile((await (await downloaded).path())!));
  const bf = Object.entries(files).find(([path]) => path.endsWith('.bf'))!;
  const document = await decodeProject(page, bf[1]);
  expect(document.images[0].filename).toBe('000001_changed.png');
  expect(Buffer.from(files[`images/${document.images[0].filename}`])).toEqual(
    await readFile(resolve('tests/fixtures/images/page-2.png')),
  );
  await expect(page.locator('.project-title')).toContainText('*');
  expect((await save(page)).images[0].filename).toBe('changed.png');
  const choose = page.waitForEvent('filechooser');
  await page.keyboard.press(`${mod}+o`);
  await (
    await choose
  ).setFiles({ name: bf[0], mimeType: 'application/gzip', buffer: Buffer.from(bf[1]) });
  const match = page.getByRole('dialog', { name: '匹配项目图片', exact: true });
  await match.getByLabel('匹配图片', { exact: true }).setInputFiles({
    name: document.images[0].filename,
    mimeType: 'image/png',
    buffer: Buffer.from(files[`images/${document.images[0].filename}`]),
  });
  await match.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(match).not.toBeVisible();
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('img'),
  ).toHaveAttribute('alt', document.images[0].filename);
  expect((await save(page)).images[0]).toMatchObject({
    filename: document.images[0].filename,
    checksum: replacement.checksum,
    markers: original.markers.map(({ id: _id, ...marker }) => marker),
  });
});

test('a multi-operation plugin transaction writes rich text and unknown assistance fields in one undo entry', async ({
  page,
}) => {
  let frame = await setup(page, 'document-toolbox', '图片与标记工具箱');
  await frame.locator('#batch').click();
  await expect(frame.locator('#images option')).toHaveCount(2);
  await expect(frame.locator('#markers option')).toHaveCount(1);
  await closePanel(page);
  const written = await save(page);
  const marker = written.images[1].markers[0];
  expect(marker.translation.runs).toEqual([
    { text: '原子事务１２３', marks: ['bold', 'emphasis'] },
  ]);
  expect(marker.bunnyCache).toMatchObject({
    toolboxField: 'unknown field remains',
    originalText: 'Transaction source',
    machineTranslation: '批事务机器译文',
  });
  await page.keyboard.press(`${mod}+z`);
  expect((await save(page)).images).toHaveLength(1);
  await page.keyboard.press(`${mod}+Shift+z`);
  expect((await save(page)).images[1].markers[0]).toEqual(marker);
  frame = await openToolbox(page);
  await frame.locator('#images').selectOption({ index: 1 });
  await expect(frame.locator('#markers option')).toHaveCount(1);
  await frame.locator('#assistance-clear').click();
  await expect(frame.getByRole('status')).toContainText('commandId');
  await frame.locator('#assistance-get').click();
  await expect
    .poll(async () => JSON.parse((await frame.getByRole('status').textContent())!))
    .toMatchObject({
      toolboxField: 'unknown field remains',
    });
});

test('history push and pop preserve entry identity and publish each opted-in transaction once', async ({
  page,
}) => {
  const frame = await setup(page, 'history-inspector', '历史与事件检查器');
  await frame.locator('#push').click();
  await expect(frame.locator('#undo-list')).toContainText('历史检查器压入事务');
  const identity = await frame
    .locator('#undo-list li')
    .first()
    .locator('small')
    .first()
    .textContent();
  await expect(frame.locator('#events')).toHaveText('尚无事件');
  await frame.locator('#include-self').check();
  await expect(frame.getByRole('status')).toContainText('自身事件');
  await frame.locator('#pop-undo').click();
  await expect(frame.locator('#redo-list li').first().locator('small').first()).toHaveText(
    identity!,
  );
  await expect(frame.locator('#events')).toContainText('transaction.committed');
  let events = JSON.parse((await frame.locator('#events').textContent())!) as Array<{
    event: string;
    data: { transactionId: string; origin: { pluginId: string } };
  }>;
  expect(events.filter((event) => event.event === 'transaction.committed')).toHaveLength(1);
  expect(events.every((event) => event.data.origin.pluginId === 'example.history-inspector')).toBe(
    true,
  );
  await frame.locator('#pop-redo').click();
  await expect(frame.locator('#undo-list li').first().locator('small').first()).toHaveText(
    identity!,
  );
  events = JSON.parse((await frame.locator('#events').textContent())!);
  expect(events.filter((event) => event.event === 'transaction.committed')).toHaveLength(2);
  expect(
    new Set(
      events
        .filter((event) => event.event === 'transaction.committed')
        .map((event) => event.data.transactionId),
    ).size,
  ).toBe(2);
});
