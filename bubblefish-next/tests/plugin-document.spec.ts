import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { ImageDocument, ProjectDocument } from '../src/generated/core';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const toolboxTitle = '图片与标记工具箱';
const header = (page: Page) => page.locator('header.titlebar');
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
async function createProject(page: Page, name = '文档插件回归', images = ['page-1.png']) {
  await header(page)
    .locator('.menu-bar summary')
    .filter({ hasText: /^文件$/ })
    .click();
  await header(page)
    .getByRole('button', { name: /^新建项目\s/ })
    .click();
  const create = page.getByRole('dialog', { name: '新建项目', exact: true });
  await create.getByLabel('项目名称', { exact: true }).fill(name);
  await create
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(images.map((image) => resolve('tests/fixtures/images', image)));
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(create).not.toBeVisible();
}
async function setup(
  page: Page,
  name: 'document-toolbox' | 'history-inspector',
  title: string,
  images?: string[],
) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  await createProject(page, '文档插件回归', images);
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
  const show = header(page).getByRole('button', { name: '显示底部面板', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: toolboxTitle, exact: true }).click();
  const frame = page.frameLocator(`iframe[title="${toolboxTitle}"]`);
  await expect(frame.locator('#project')).toContainText('文档插件回归');
  return frame;
}
async function closePanel(page: Page, location: 'bottom' | 'modal' = 'bottom') {
  if (location === 'bottom')
    await header(page).getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  else await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
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
  await header(page)
    .locator('.menu-bar summary')
    .filter({ hasText: /^文件$/ })
    .click();
  await header(page)
    .getByRole('button', { name: /^保存\s/ })
    .click();
  return decodeProject(page, await readFile((await (await pending).path())!));
}

interface ToolboxReadGate {
  holdNext: boolean;
  pending: Array<() => void>;
  methods: Map<string, string>;
  created: number;
}
async function installReadGate(page: Page) {
  await page.addInitScript(() => {
    if (window === window.top) return;
    const gate: ToolboxReadGate = {
      holdNext: false,
      pending: [],
      methods: new Map(),
      created: 0,
    };
    Object.assign(window, { __toolboxReadGate: gate });
    const send = MessagePort.prototype.postMessage,
      start = MessagePort.prototype.start,
      wrapped = new WeakSet<MessagePort>();
    MessagePort.prototype.postMessage = function (
      packet: {
        message?: {
          kind?: string;
          id?: string;
          method?: string;
          params?: { operations?: Array<{ type?: string }> };
        };
      },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      const message = packet?.message;
      if (message?.kind === 'request' && message.id && message.method)
        gate.methods.set(
          message.id,
          message.method === 'document.transaction' &&
            message.params?.operations?.some((operation) => operation.type === 'image.create')
            ? 'image.create'
            : message.method,
        );
      Reflect.apply(send, this, [packet, transfer]);
    };
    MessagePort.prototype.start = function () {
      const port = this,
        receive = port.onmessage;
      if (receive && !wrapped.has(port)) {
        wrapped.add(port);
        port.onmessage = (event) => {
          const message = event.data?.message;
          if (message?.kind === 'response') {
            const method = gate.methods.get(message.id);
            gate.methods.delete(message.id);
            if (method === 'image.create' && !message.error) gate.created++;
            if (method === 'document.images.read' && gate.holdNext) {
              gate.holdNext = false;
              gate.pending.push(() => receive.call(port, event));
              return;
            }
          }
          receive.call(port, event);
        };
      }
      start.call(port);
    };
  });
}
async function gateCount(frame: FrameLocator, kind: 'pending' | 'created') {
  return frame.locator('body').evaluate((_, key) => {
    const gate = (window as unknown as { __toolboxReadGate: ToolboxReadGate }).__toolboxReadGate;
    return key === 'pending' ? gate.pending.length : gate.created;
  }, kind);
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

test('the docked toolbox follows host targets while preserving scoped drafts across hiding and theme changes', async ({
  page,
}) => {
  const frame = await setup(page, 'document-toolbox', toolboxTitle, ['page-1.png', 'page-2.png']);
  const sheet = page.getByRole('application', { name: '图片标注画布', exact: true }).locator('img');
  await expect(sheet).toBeVisible();
  const bounds = (await sheet.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.25);
  await page.mouse.click(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.45);
  await expect(frame.locator('#target')).toContainText('page-1.png');
  await expect(frame.locator('#target')).toContainText('#2');
  await frame.locator('#translation').fill('第二个标记的草稿');
  await frame.locator('#original-text').fill('第二个标记原文草稿');
  await page.getByRole('button', { name: '翻译项 1', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('#1');
  await expect(frame.locator('#translation')).toHaveValue('');
  await frame.locator('#translation').fill('第一个标记的草稿');
  await frame.locator('#x').fill('0.42');
  await page.getByRole('textbox', { name: '翻译内容', exact: true }).fill('宿主提交的译文');
  await expect(frame.locator('#translation')).toHaveValue('第一个标记的草稿');
  const identity = await frame.locator('body').evaluate(() => {
    const state = window as unknown as { toolboxIdentity?: string };
    return (state.toolboxIdentity = String(Math.random()));
  });
  await page.getByRole('tab', { name: 'OCR 与机器翻译', exact: true }).click();
  await closePanel(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await openToolbox(page);
  await expect(frame.locator('html')).toHaveAttribute('data-bf-theme', 'dark');
  await expect(frame.locator('#translation')).toHaveValue('第一个标记的草稿');
  await expect(frame.locator('#x')).toHaveValue('0.42');
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as unknown as { toolboxIdentity: string }).toolboxIdentity),
  ).toBe(identity);
  await frame.locator('#refresh').click();
  await expect(frame.locator('#translation')).toHaveValue('宿主提交的译文');
  await page.getByRole('button', { name: '翻译项 2', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('#2');
  await expect(frame.locator('#translation')).toHaveValue('第二个标记的草稿');
  await expect(frame.locator('#original-text')).toHaveValue('第二个标记原文草稿');
  await frame.locator('#marker-remove').click();
  await expect(frame.locator('#markers option')).toHaveCount(1);
  await expect(frame.locator('#target')).toContainText('未选择标记');
  await expect(frame.locator('#translation')).toHaveValue('');
  await expect(frame.locator('#original-text')).toHaveValue('');
  await frame.locator('#filename').fill('第一页文件名草稿.png');
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('page-2.png');
  await expect(frame.locator('#filename')).toHaveValue('page-2.png');
  await frame.locator('#filename').fill('第二页文件名草稿.png');
  await page.getByRole('button', { name: '上一张图片', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('page-1.png');
  await expect(frame.locator('#filename')).toHaveValue('第一页文件名草稿.png');
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('page-2.png');
  await expect(frame.locator('#filename')).toHaveValue('第二页文件名草稿.png');
});

test('a delayed toolbox copy stays in its captured project without replacing the next project form', async ({
  page,
}) => {
  await installReadGate(page);
  const frame = await setup(page, 'document-toolbox', toolboxTitle);
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __toolboxReadGate: ToolboxReadGate }).__toolboxReadGate.holdNext = true;
  });
  await frame.locator('#image-copy').click();
  await expect.poll(() => gateCount(frame, 'pending')).toBe(1);
  await createProject(page, '复制隔离乙', ['page-2.png']);
  await expect(frame.locator('#project')).toContainText('复制隔离乙');
  await expect(frame.locator('#target')).toContainText('page-2.png');
  await frame.locator('#filename').fill('乙项目未提交的文件名.png');
  await frame.locator('body').evaluate(() => {
    (
      window as unknown as { __toolboxReadGate: ToolboxReadGate }
    ).__toolboxReadGate.pending.shift()?.();
  });
  await expect.poll(() => gateCount(frame, 'created')).toBe(1);
  const second = await save(page);
  expect(second.name).toBe('复制隔离乙');
  expect(second.images).toHaveLength(1);
  expect(second.images[0].filename).toBe('page-2.png');
  await expect(frame.locator('#project')).toContainText('复制隔离乙');
  await expect(frame.locator('#target')).toContainText('page-2.png');
  await expect(frame.locator('#filename')).toHaveValue('乙项目未提交的文件名.png');
  await header(page).locator('.project-switcher > summary').click();
  await header(page)
    .getByRole('button', { name: /^文档插件回归(?: \*)?$/ })
    .click();
  await expect(frame.locator('#project')).toContainText('文档插件回归');
  const first = await save(page);
  expect(first.images).toHaveLength(2);
  expect(first.images.map((image) => image.filename)).toEqual(['page-1.png', 'copy-page-1.png']);
  const closeProject = async () => {
    await header(page)
      .locator('.menu-bar summary')
      .filter({ hasText: /^文件$/ })
      .click();
    await header(page).getByRole('button', { name: '关闭项目', exact: true }).click();
  };
  await closeProject();
  await expect(frame.locator('#project')).toContainText('复制隔离乙');
  await expect(frame.locator('#filename')).toHaveValue('乙项目未提交的文件名.png');
  await closeProject();
  await expect(frame.locator('#project')).toHaveText('请先打开项目');
  await expect(frame.locator('#images option')).toHaveCount(0);
  await expect(frame.locator('#filename')).toHaveValue('');
  await expect(frame.locator('#image-create')).toBeDisabled();
  await expect(frame.locator('#marker-create')).toBeDisabled();
});

test('a delayed copy refreshes the same project list while preserving the next image target and draft', async ({
  page,
}) => {
  await installReadGate(page);
  const frame = await setup(page, 'document-toolbox', toolboxTitle, ['page-1.png', 'page-2.png']);
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __toolboxReadGate: ToolboxReadGate }).__toolboxReadGate.holdNext = true;
  });
  await frame.locator('#image-copy').click();
  await expect.poll(() => gateCount(frame, 'pending')).toBe(1);
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(frame.locator('#target')).toContainText('page-2.png');
  const secondId = await frame.locator('#images').inputValue();
  await frame.locator('#filename').fill('第二张图片未提交的文件名.png');
  await frame.locator('body').evaluate(() => {
    (
      window as unknown as { __toolboxReadGate: ToolboxReadGate }
    ).__toolboxReadGate.pending.shift()?.();
  });
  await expect.poll(() => gateCount(frame, 'created')).toBe(1);
  await expect(frame.locator('#images option')).toHaveCount(3);
  await expect(frame.locator('#images')).toHaveValue(secondId);
  await expect(frame.locator('#target')).toContainText('page-2.png');
  await expect(frame.locator('#filename')).toHaveValue('第二张图片未提交的文件名.png');
  await expect(
    page.getByRole('application', { name: '图片标注画布', exact: true }).locator('img'),
  ).toHaveAttribute('alt', 'page-2.png');
  expect((await save(page)).images.map((image) => image.filename)).toEqual([
    'page-1.png',
    'page-2.png',
    'copy-page-1.png',
  ]);
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
