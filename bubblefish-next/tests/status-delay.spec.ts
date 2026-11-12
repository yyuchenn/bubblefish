import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const clockStart = new Date('2026-11-11T00:00:00Z');
const trigger = (page: Page) => page.getByRole('button', { name: '查看项目统计', exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '翻译内容', exact: true });
const statusParts = (page: Page) => page.locator('.status-indicator, .status-separator');
type Kind = 'ready' | 'translation' | 'other';
type Gate = {
  holdReady: boolean;
  holdTranslation: boolean;
  pending: Set<number>;
  translationsSent: number;
  replies: Array<{ kind: Kind; release(): void }>;
};

async function installGate(page: Page, holdReady = false) {
  await page.clock.install({ time: clockStart });
  await page.addInitScript((holdReady) => {
    const gate: Gate = {
      holdReady,
      holdTranslation: false,
      pending: new Set(),
      translationsSent: 0,
      replies: [],
    };
    Object.assign(window, { __statusDelayGate: gate });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private core: boolean;
      private kinds = new Map<number, Kind>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.core = options?.name === 'bubblefish-core';
        this.addEventListener(
          'message',
          (event: MessageEvent) => {
            if (!this.core || this.replaying) return;
            const kind = this.kinds.get(event.data?.id);
            if (!kind) return;
            const release = () => {
              gate.pending.delete(event.data.id);
              this.kinds.delete(event.data.id);
              this.replaying = true;
              this.dispatchEvent(new MessageEvent('message', { data: event.data }));
              this.replaying = false;
            };
            if (
              (kind === 'ready' && gate.holdReady) ||
              (kind === 'translation' && gate.holdTranslation)
            ) {
              event.stopImmediatePropagation();
              gate.replies.push({ kind, release });
            } else {
              gate.pending.delete(event.data.id);
              this.kinds.delete(event.data.id);
            }
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
        if (this.core) {
          const command = message.args?.[0]?.command;
          const kind: Kind =
            message.method === 'ready'
              ? 'ready'
              : message.method === 'dispatch' &&
                  command?.type === 'updateMarker' &&
                  command.translation
                ? 'translation'
                : 'other';
          this.kinds.set(message.id, kind);
          gate.pending.add(message.id);
          if (kind === 'translation') gate.translationsSent++;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    } as typeof Worker;
  }, holdReady);
}

const held = (page: Page, kind: Kind) =>
  page.evaluate(
    (kind) =>
      (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate.replies.filter(
        (reply) => reply.kind === kind,
      ).length,
    kind,
  );
const idle = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate.pending.size,
      ),
    )
    .toBe(0);
async function release(page: Page, kind: Kind, keepHolding = false) {
  await page.evaluate(
    ({ kind, keepHolding }) => {
      const gate = (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate;
      if (kind === 'ready') gate.holdReady = keepHolding;
      if (kind === 'translation') gate.holdTranslation = keepHolding;
      const index = gate.replies.findIndex((reply) => reply.kind === kind);
      if (index < 0) throw new Error(`No held ${kind} reply`);
      gate.replies.splice(index, 1)[0].release();
    },
    { kind, keepHolding },
  );
}
async function expectHidden(page: Page) {
  await expect(statusParts(page)).toHaveCount(0);
  await expect(page.locator('.status-left')).not.toContainText(/正在记录|正在启动核心/);
}
async function startProject(page: Page) {
  await installGate(page);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill('状态延迟回归');
  await dialog
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
  await expect(editor(page)).toBeVisible();
  await idle(page);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await idle(page);
  await expectHidden(page);
  await page.evaluate(() => {
    (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate.holdTranslation = true;
  });
}

test('core startup status appears at 100ms and disappears as soon as ready', async ({ page }) => {
  await installGate(page, true);
  await page.clock.pauseAt(clockStart.getTime() + 1000);
  await page.goto('/');
  await expect.poll(() => held(page, 'ready')).toBe(1);
  await expectHidden(page);
  await page.clock.runFor(99);
  await expectHidden(page);
  await page.clock.runFor(1);
  await expect(page.locator('.status-left')).toHaveText('正在启动核心…');
  await expect(page.locator('.status-indicator')).toHaveCount(1);
  await expect(page.locator('.status-separator')).toHaveCount(0);
  await release(page, 'ready');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await expectHidden(page);
});

test('a core that is ready before 100ms never leaves a delayed startup status', async ({
  page,
}) => {
  await installGate(page, true);
  await page.clock.pauseAt(clockStart.getTime() + 1000);
  await page.goto('/');
  await expect.poll(() => held(page, 'ready')).toBe(1);
  await page.clock.runFor(60);
  await expectHidden(page);
  await release(page, 'ready');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.clock.runFor(200);
  await expectHidden(page);
});

test('continuous recording keeps its original delay across queued edits and ACK updates', async ({
  page,
}) => {
  await startProject(page);
  const before = await trigger(page).boundingBox();
  await editor(page).fill('甲');
  await expect.poll(() => held(page, 'translation')).toBe(1);
  await page.clock.runFor(30);
  await editor(page).press('End');
  await page.keyboard.insertText('乙');
  // The second edit enters the mutation queue while the first still awaits its ACK.
  await release(page, 'translation', true);
  await expect.poll(() => held(page, 'translation')).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate.translationsSent,
      ),
    )
    .toBe(2);
  await page.clock.runFor(69);
  await expectHidden(page);
  expect(await trigger(page).boundingBox()).toEqual(before);
  await page.clock.runFor(1);
  await expect(page.locator('.status-left')).toContainText('正在记录…');
  await expect(statusParts(page)).toHaveCount(2);
  expect(await trigger(page).boundingBox()).toEqual(before);
  await release(page, 'translation');
  await idle(page);
  await expectHidden(page);
  expect(await trigger(page).boundingBox()).toEqual(before);
});

test('short recordings cancel their timer and the next recording waits a fresh 100ms', async ({
  page,
}) => {
  await startProject(page);
  const before = await trigger(page).boundingBox();
  await editor(page).fill('短');
  await expect.poll(() => held(page, 'translation')).toBe(1);
  await page.clock.runFor(60);
  await expectHidden(page);
  await release(page, 'translation');
  await idle(page);
  await page.clock.runFor(200);
  await expectHidden(page);
  await page.evaluate(() => {
    (window as unknown as { __statusDelayGate: Gate }).__statusDelayGate.holdTranslation = true;
  });
  await editor(page).fill('第二轮');
  await expect.poll(() => held(page, 'translation')).toBe(1);
  await page.clock.runFor(99);
  await expectHidden(page);
  // Use the real pointer without actionability waits advancing the controlled clock.
  await page.mouse.click(before!.x + before!.width / 2, before!.y + before!.height / 2);
  const statistics = page.getByRole('dialog', { name: '项目统计', exact: true });
  await expect(statistics).not.toBeVisible();
  await page.clock.runFor(1);
  await expect(page.locator('.status-left')).toContainText('正在记录…');
  expect(await trigger(page).boundingBox()).toEqual(before);
  await release(page, 'translation');
  // Boundary assertions are complete; allow the editor's existing settlement
  // polling to finish before the normal statistics synchronization completes.
  await page.clock.resume();
  await expect(statistics).toBeVisible();
  await expect(statistics.locator('.project-statistics dd')).toHaveText(['1', '1', '3']);
  await idle(page);
  await expectHidden(page);
});
