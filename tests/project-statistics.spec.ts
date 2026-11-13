import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { Marker, ProjectDocument, TextRun } from '../src/generated/core';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const images = [1, 2].map((number) => resolve(`tests/fixtures/images/page-${number}.png`));
const trigger = (page: Page) => page.getByRole('button', { name: '查看项目统计', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: '项目统计', exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '翻译内容', exact: true });

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
}

async function createProject(page: Page, name = '项目统计回归') {
  await page.keyboard.press(`${mod}+Alt+n`);
  const create = page.getByRole('dialog', { name: '新建项目', exact: true });
  await create.getByLabel('项目名称', { exact: true }).fill(name);
  await create.getByLabel('选择图片', { exact: true }).setInputFiles(images[0]);
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(create).not.toBeVisible();
}

async function addPoint(page: Page) {
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const box = (await image.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await expect(editor(page)).toBeVisible();
}

async function expectStatistics(page: Page, total: number, nonEmpty: number, characters: number) {
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.project-statistics dt')).toHaveText([
    '总标记数',
    '非空标记数',
    '总字数',
  ]);
  await expect(dialog(page).locator('.project-statistics dd')).toHaveText([
    String(total),
    String(nonEmpty),
    String(characters),
  ]);
}

async function closeStatistics(page: Page) {
  await dialog(page).getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
}

function marker(id: string, runs: TextRun[], auxiliary = false): Marker {
  return {
    id,
    geometry: { type: 'point', x: 0.3, y: 0.3 },
    translation: { runs },
    style: { overlayText: false, horizontal: false },
    ...(auxiliary
      ? { bunnyCache: { originalText: 'OCR 原文不得计入', machineTranslation: '机器译文不得计入' } }
      : {}),
  };
}

async function openFixture(page: Page) {
  const document: ProjectDocument = {
    id: 'statistics-fixture',
    name: '多页统计夹具',
    sourceLanguage: 'japanese',
    targetLanguage: 'simplifiedChinese',
    images: [
      [
        marker('empty', [], true),
        marker('whitespace', [{ text: ' \n\t　', marks: [] }]),
        marker('formatted', [
          { text: '中 A', marks: ['bold'] },
          { text: '😀！', marks: ['italic'] },
        ]),
      ],
      [
        marker('second-page', [{ text: '后\n页', marks: ['strike'] }]),
        marker('empty-with-assistance', [{ text: '', marks: [] }], true),
      ],
    ].map((markers, index) => ({
      id: `image-${index}`,
      assetId: `asset-${index}`,
      filename: `page-${index + 1}.png`,
      width: 600,
      height: 900,
      markers,
    })),
  };
  const bytes = await page.evaluate(async (value: unknown): Promise<number[]> => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/wasm/bubblefish_wasm.js`
    );
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
    name: 'statistics-fixture.bf',
    mimeType: 'application/gzip',
    buffer: Buffer.from(bytes),
  });
  const matching = page.getByRole('dialog', { name: '匹配项目图片', exact: true });
  await matching.getByLabel('匹配图片', { exact: true }).setInputFiles(images);
  await matching.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(matching).not.toBeVisible();
}

test('statistics supports zero values, keyboard activation, modal focus and every closing path', async ({
  page,
}) => {
  await ready(page);
  await expect(trigger(page)).toHaveCount(0);
  await createProject(page);
  await expect(trigger(page)).toHaveText('0 个标记');
  await trigger(page).focus();
  await trigger(page).press('Enter');
  await expectStatistics(page, 0, 0, 0);
  const close = dialog(page).getByRole('button', { name: '关闭弹窗', exact: true });
  await expect(close).toBeFocused();
  await close.press('Tab');
  await expect(close).toBeFocused();
  await close.press('Shift+Tab');
  await expect(close).toBeFocused();
  await close.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
  await expect(trigger(page)).toBeFocused();

  await trigger(page).press('Space');
  await expectStatistics(page, 0, 0, 0);
  await page.locator('.modal-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(dialog(page)).not.toBeVisible();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await closeStatistics(page);
  await expect(trigger(page)).toBeFocused();

  // A project whose last image was removed still has a usable statistics entry.
  page.on('dialog', (prompt) => void prompt.accept());
  await page.getByRole('button', { name: '项目配置', exact: true }).click();
  await page.getByRole('button', { name: '删除图片 1', exact: true }).click();
  await expect(page.getByRole('application', { name: '图片标注画布' })).not.toBeVisible();
  await trigger(page).click();
  await expectStatistics(page, 0, 0, 0);
});

test('statistics aggregates formatted human translations across pages and follows the active project', async ({
  page,
}) => {
  await ready(page);
  await openFixture(page);
  await expect(trigger(page)).toHaveText('5 个标记');
  await page.getByRole('button', { name: '下一张图片', exact: true }).click();
  await trigger(page).click();
  await expectStatistics(page, 5, 2, 6);
  await page.screenshot({ path: test.info().outputPath('statistics.png'), fullPage: true });
  await closeStatistics(page);

  await createProject(page, '另一个空项目');
  await trigger(page).click();
  await expectStatistics(page, 0, 0, 0);
  await closeStatistics(page);
  await page.locator('.project-switcher > summary').click();
  await page
    .locator('.project-option > button:first-child')
    .filter({ hasText: '多页统计夹具' })
    .click();
  await trigger(page).click();
  await expectStatistics(page, 5, 2, 6);
});

test('opening immediately after typing includes the current text and reflects undo and redo', async ({
  page,
}) => {
  await ready(page);
  await createProject(page);
  await addPoint(page);
  await editor(page).fill('中 A😀！\n');
  await trigger(page).click();
  await expectStatistics(page, 1, 1, 4);
  await closeStatistics(page);
  await page.keyboard.press(`${mod}+z`);
  await trigger(page).click();
  await expectStatistics(page, 1, 0, 0);
  await closeStatistics(page);
  await page.keyboard.press(`${mod}+Shift+z`);
  await trigger(page).click();
  await expectStatistics(page, 1, 1, 4);
});

test('statistics waits for compositionend before counting the final IME translation', async ({
  page,
}) => {
  await ready(page);
  await createProject(page);
  await addPoint(page);
  await editor(page).focus();
  await editor(page).dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中');
  await page.keyboard.insertText('文😀');
  await expect(editor(page)).toHaveText('中文😀');
  await trigger(page).click();
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(dialog(page)).not.toBeVisible();
  await editor(page).dispatchEvent('compositionend', { data: '中文😀' });
  await expectStatistics(page, 1, 1, 3);
});

type TranslationGate = { hold: boolean; acknowledgements: Array<() => void> };

async function installTranslationGate(page: Page) {
  await page.addInitScript(() => {
    // Hold only the real core's translation ACK; application state stays untouched.
    const gate: TranslationGate = { hold: false, acknowledgements: [] };
    Object.assign(window, { __statisticsGate: gate });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private translationIds = new Set<number>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          'message',
          (event: MessageEvent) => {
            if (this.replaying || !gate.hold || !this.translationIds.has(event.data?.id)) return;
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
          args?: Array<{ command?: { type: string; translation?: unknown } }>;
        },
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const command = message.args?.[0]?.command;
        if (
          message.method === 'dispatch' &&
          command?.type === 'updateMarker' &&
          command.translation
        )
          this.translationIds.add(message.id);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    } as typeof Worker;
  });
}

test('statistics stays closed until an in-flight translation is acknowledged', async ({ page }) => {
  await installTranslationGate(page);
  await ready(page);
  await createProject(page);
  await addPoint(page);
  await page.evaluate(() => {
    (window as unknown as { __statisticsGate: TranslationGate }).__statisticsGate.hold = true;
  });
  await editor(page).fill('等待 确认😀');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __statisticsGate: TranslationGate }).__statisticsGate
            .acknowledgements.length,
      ),
    )
    .toBe(1);
  await trigger(page).click();
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(dialog(page)).not.toBeVisible();
  await page.evaluate(() => {
    const gate = (window as unknown as { __statisticsGate: TranslationGate }).__statisticsGate;
    gate.hold = false;
    gate.acknowledgements.shift()?.();
  });
  await expectStatistics(page, 1, 1, 5);
});
