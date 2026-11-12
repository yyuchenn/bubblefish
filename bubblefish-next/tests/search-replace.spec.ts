import { expect, test, type Page } from '@playwright/test';
import { historyFromMenu } from './history-actions';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Marker, ProjectDocument } from '../src/generated/core';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const imagePaths = [1, 2].map((number) => resolve(`tests/fixtures/images/page-${number}.png`));
const editor = (page: Page) => page.getByRole('textbox', { name: '翻译内容', exact: true });
const original = (page: Page) => page.getByRole('textbox', { name: 'OCR 原文', exact: true });
const query = (page: Page) => page.getByRole('textbox', { name: '查找文本', exact: true });
const replacement = (page: Page) => page.getByRole('textbox', { name: '替换文本', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary', { name: '查找替换', exact: true });

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
}

async function createProject(page: Page, pages = 2) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill('项目内查找替换');
  await dialog.getByLabel('选择图片', { exact: true }).setInputFiles(imagePaths.slice(0, pages));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function addPoint(page: Page) {
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
  await expect(editor(page)).toBeVisible();
}

async function count(page: Page, matches: number) {
  await expect(page.getByTestId('search-count')).toHaveText(
    new RegExp(`^${matches} 处匹配(?: ·.*)?$`),
  );
}

async function search(page: Page, text: string) {
  await page.keyboard.press(`${mod}+f`);
  await expect(query(page)).toBeFocused();
  await query(page).fill(text);
}

async function savedDocument(page: Page): Promise<ProjectDocument> {
  const downloaded = page.waitForEvent('download');
  const header = page.locator('header.titlebar');
  await header
    .locator('.menu-bar summary')
    .filter({ hasText: /^文件$/ })
    .click();
  await header.getByRole('button', { name: /^保存\s/ }).click();
  const path = await (await downloaded).path();
  const bytes = [...(await readFile(path!))];
  return (await page.evaluate(async (data): Promise<unknown> => {
    const url = `${location.origin}/src/wasm/bubblefish_wasm.js`;
    const module = await import(/* @vite-ignore */ url);
    await module.default();
    const core = new module.CoreHost();
    try {
      return core.importProject(new Uint8Array(data), 'bf', 'search-save-check').document;
    } finally {
      core.free();
    }
  }, bytes)) as ProjectDocument;
}

function fixtureMarker(id: string, text: string, auxiliary = false): Marker {
  return {
    id,
    geometry: { type: 'point', x: 0.3, y: 0.3 },
    translation: { runs: [{ text, marks: [] }] },
    style: { overlayText: false, horizontal: false },
    ...(auxiliary
      ? {
          bunnyCache: {
            originalText: `猫 OCR ${id}`,
            machineTranslation: `猫 机器${id}`,
            lastOcrModel: 'fixture-ocr',
            lastTranslationService: 'fixture-translation',
            unknown: { retained: true },
          },
        }
      : {}),
  };
}

function fixture(pages: Marker[][]): ProjectDocument {
  return {
    id: 'search-fixture',
    name: '查找替换 BF 夹具',
    sourceLanguage: 'japanese',
    targetLanguage: 'simplifiedChinese',
    images: pages.map((markers, index) => ({
      id: `image-${index}`,
      assetId: `asset-${index}`,
      filename: `page-${index + 1}.png`,
      width: 800,
      height: 1200,
      markers,
    })),
  };
}

async function openFixture(page: Page, document: ProjectDocument) {
  // Exercise the actual BF codec and the normal image-matching UI, without injecting app state.
  const bytes = await page.evaluate(async (value: unknown): Promise<number[]> => {
    const url = `${location.origin}/src/wasm/bubblefish_wasm.js`;
    const module = await import(/* @vite-ignore */ url);
    await module.default();
    const core = new module.CoreHost();
    try {
      return [...core.encodeProject(value, 'bf')];
    } finally {
      core.free();
    }
  }, document as unknown);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click();
  await (
    await chooser
  ).setFiles({
    name: 'search-fixture.bf',
    mimeType: 'application/gzip',
    buffer: Buffer.from(bytes),
  });
  const dialog = page.getByRole('dialog', { name: '匹配项目图片', exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel('匹配图片', { exact: true })
    .setInputFiles(imagePaths.slice(0, document.images.length));
  await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

const text = (marker: Marker) => marker.translation.runs.map((run) => run.text).join('');

test('project search keeps focus, navigates across paragraphs and pages, and replaces with one undo per action', async ({
  page,
}) => {
  await ready(page);
  await search(page, '保留查询');
  await expect(page.getByTestId('search-count')).toHaveText('请先打开项目');
  await expect(sidebar(page).getByRole('button', { name: '全部替换', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '图片面板', exact: true }).click();
  await expect(sidebar(page)).not.toBeVisible();
  await page
    .locator('.activity-bar')
    .getByRole('button', { name: '查找替换面板', exact: true })
    .click();
  await expect(query(page)).toHaveValue('保留查询');
  await query(page).press('Escape');
  await createProject(page);
  await addPoint(page);
  await editor(page).fill('第一猫\n第二猫😀');
  await original(page).fill('猫原文');
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(
    page.getByRole('application', { name: '图片标注画布' }).locator('img'),
  ).toHaveAttribute('alt', 'page-2.png');
  await addPoint(page);
  await editor(page).fill('猫 第二页');
  await original(page).fill('猫 OCR 二');

  await editor(page).press(`${mod}+f`);
  await expect(sidebar(page)).toBeVisible();
  await expect(query(page)).toBeFocused();
  await expect(
    page.getByRole('checkbox', { name: '包含 OCR 原文', exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '包含机器译文', exact: true })).not.toBeChecked();
  await query(page).fill('猫');
  await count(page, 3);
  await query(page).press(`${mod}+f`);
  await expect(query(page)).toBeFocused();
  expect(
    await query(page).evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, 1]);

  await query(page).press('Enter');
  await expect(page.locator('.page-number')).toHaveText('1 / 2');
  await expect(editor(page).locator('.search-current-match')).toHaveText('猫');
  await expect(query(page)).toBeFocused();
  await query(page).press('Enter');
  await expect(page.getByTestId('search-count')).toHaveText('3 处匹配 · 2/3');
  await expect(editor(page).locator('p').nth(1).locator('.search-current-match')).toHaveText('猫');
  await query(page).press('Enter');
  await expect(page.locator('.page-number')).toHaveText('2 / 2');
  await expect(query(page)).toBeFocused();

  await original(page).press(`${mod}+f`);
  await expect(query(page)).toBeFocused();
  await sidebar(page)
    .getByRole('button', { name: /^第 2 页 标记 1 译文 匹配/ })
    .click();
  await replacement(page).fill('犬');
  await sidebar(page).getByRole('button', { name: '替换当前项', exact: true }).click();
  await count(page, 2);
  await sidebar(page).getByRole('button', { name: '全部替换', exact: true }).click();
  await count(page, 0);
  await historyFromMenu(page, 'undo');
  await count(page, 2);
  await historyFromMenu(page, 'redo');
  await count(page, 0);

  const saved = await savedDocument(page);
  expect(saved.images.map((image) => image.markers.map(text))).toEqual([
    ['第一犬\n第二犬😀'],
    ['犬 第二页'],
  ]);
  expect(saved.images[0].markers[0].bunnyCache).toMatchObject({ originalText: '猫原文' });
  expect(saved.images[1].markers[0].bunnyCache).toMatchObject({ originalText: '猫 OCR 二' });

  await query(page).focus();
  await query(page).press('Escape');
  await expect(sidebar(page)).not.toBeVisible();
  await page.keyboard.press(`${mod}+f`);
  await expect(query(page)).toHaveValue('猫');
  await expect(query(page)).toBeFocused();
});

test('independent OCR and machine scopes reveal their fields and persist one atomic replacement through BF', async ({
  page,
}) => {
  await ready(page);
  const fixtureDocument = fixture([
    [fixtureMarker('one', '猫 Alpha 猫', true), fixtureMarker('two', '边界猫尾')],
    [fixtureMarker('three', '猫 第二页', true)],
  ]);
  fixtureDocument.images[0].markers[0].translation = {
    runs: [
      { text: '猫', marks: ['bold'] },
      { text: ' Alpha 猫', marks: [] },
    ],
  };
  await openFixture(page, fixtureDocument);
  await search(page, '猫');
  await count(page, 4);
  const includeOriginal = page.getByRole('checkbox', { name: '包含 OCR 原文', exact: true });
  const includeMachine = page.getByRole('checkbox', { name: '包含机器译文', exact: true });
  await includeOriginal.check();
  await count(page, 6);
  await includeMachine.check();
  await count(page, 8);
  await includeOriginal.uncheck();
  await count(page, 6);
  await includeOriginal.check();
  await count(page, 8);

  await page.getByRole('button', { name: '隐藏底部面板', exact: true }).click();
  await sidebar(page)
    .getByRole('button', { name: /^第 2 页 标记 1 OCR 原文 匹配/ })
    .click();
  await expect(page.locator('.page-number')).toHaveText('2 / 2');
  await expect(page.getByRole('tab', { name: 'OCR 与机器翻译', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(original(page)).toHaveAttribute('data-search-highlight', 'true');
  expect(
    await original(page).evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, 1]);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-search-panel]'))).toBe(
    true,
  );
  await sidebar(page)
    .getByRole('button', { name: /^第 2 页 标记 1 机器译文 匹配/ })
    .click();
  await expect(page.getByRole('textbox', { name: '机器译文', exact: true })).toHaveAttribute(
    'data-search-highlight',
    'true',
  );
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-search-panel]'))).toBe(
    true,
  );

  await replacement(page).fill('犬');
  await sidebar(page).getByRole('button', { name: '全部替换', exact: true }).click();
  await count(page, 0);
  await historyFromMenu(page, 'undo');
  await count(page, 8);
  await historyFromMenu(page, 'redo');
  await count(page, 0);
  const saved = await savedDocument(page);
  expect(saved.images.map((image) => image.markers.map(text))).toEqual([
    ['犬 Alpha 犬', '边界犬尾'],
    ['犬 第二页'],
  ]);
  expect(saved.images[0].markers[0].translation.runs[0]).toEqual({ text: '犬', marks: ['bold'] });
  for (const marker of [saved.images[0].markers[0], saved.images[1].markers[0]]) {
    expect(marker.bunnyCache).toMatchObject({
      originalText: expect.stringMatching(/^犬 OCR /),
      machineTranslation: expect.stringMatching(/^犬 机器/),
      lastOcrModel: 'fixture-ocr',
      lastTranslationService: 'fixture-translation',
      unknown: { retained: true },
    });
  }
});

test('advanced rules handle captures, invalid expressions, line breaks and zero-width insertion', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, 1);
  await addPoint(page);
  await editor(page).fill('cat CAT scatter\ncat 😀');
  await search(page, 'cat');
  await count(page, 4);
  await page.getByRole('checkbox', { name: '区分大小写', exact: true }).check();
  await count(page, 3);
  await page.getByRole('checkbox', { name: '整词', exact: true }).check();
  await count(page, 2);
  await page.getByRole('checkbox', { name: '区分大小写', exact: true }).uncheck();
  await count(page, 3);
  await page.getByRole('checkbox', { name: '正则', exact: true }).check();
  await query(page).fill('(?<word>cat)');
  await count(page, 3);
  await replacement(page).fill('$<word>-$&-$$');
  await sidebar(page).getByRole('button', { name: '全部替换', exact: true }).click();
  await expect(sidebar(page).getByText('已替换 3 处', { exact: true })).toBeVisible();
  expect(text((await savedDocument(page)).images[0].markers[0])).toBe(
    'cat-cat-$ CAT-CAT-$ scatter\ncat-cat-$ 😀',
  );
  await historyFromMenu(page, 'undo');
  await expect(editor(page)).toHaveText('cat CAT scattercat 😀');

  await query(page).fill('[');
  await expect(sidebar(page).getByRole('alert')).toContainText('正则表达式无效');
  await expect(sidebar(page).getByRole('button', { name: '全部替换', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: '整词', exact: true }).uncheck();
  await query(page).fill('\\n');
  await count(page, 1);
  await query(page).press('Enter');
  await expect(editor(page).locator('.search-current-linebreak')).toHaveText('↵');
  await expect(query(page)).toBeFocused();

  await query(page).fill('(?=😀)');
  await count(page, 1);
  await query(page).press('Enter');
  await expect(editor(page).locator('.search-current-insertion')).toHaveCount(1);
  await replacement(page).fill('前');
  await sidebar(page).getByRole('button', { name: '替换当前项', exact: true }).click();
  await expect(sidebar(page).getByText('已替换 1 处', { exact: true })).toBeVisible();
  expect(text((await savedDocument(page)).images[0].markers[0])).toBe('cat CAT scatter\ncat 前😀');
});

test('a pathological regex times out in its worker while the workspace remains responsive', async ({
  page,
}) => {
  await ready(page);
  await createProject(page, 1);
  await addPoint(page);
  await editor(page).fill(`${'a'.repeat(80)}!`);
  await search(page, 'a');
  await count(page, 80);
  await page.getByRole('checkbox', { name: '正则', exact: true }).check();
  const worker = page.waitForEvent('worker', {
    predicate: (entry) => entry.url().includes('search-worker'),
  });
  await query(page).fill('^(a+)+$');
  await worker;
  await page.getByRole('button', { name: '隐藏底部面板', exact: true }).click({ timeout: 1000 });
  await expect(page.locator('.bottom-panel')).not.toBeVisible({ timeout: 1000 });
  await expect(sidebar(page).getByRole('alert')).toContainText('查找超时', { timeout: 6000 });
  await expect(sidebar(page).getByRole('button', { name: '全部替换', exact: true })).toBeDisabled();
  await query(page).fill('a');
  await count(page, 80);
  await expect(sidebar(page).getByRole('alert')).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: '全部替换', exact: true })).toBeEnabled();
});
