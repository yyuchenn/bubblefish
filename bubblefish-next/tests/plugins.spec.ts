import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.beforeAll(async () => {
  test.setTimeout(120_000);
  await promisify(execFile)(process.execPath, ['crates/plugin-sdk/examples/build-example.mjs']);
});
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
}
async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}
async function install(page: Page, path: string, name: string) {
  const dialog = await center(page);
  await dialog.getByLabel('安装插件包', { exact: true }).setInputFiles(path);
  const card = dialog.getByRole('article', { name, exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card.getByText('未激活', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
}
async function project(page: Page) {
  await page.keyboard.press(`${mod}+Alt+n`);
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill('插件工作流');
  await dialog
    .getByLabel('选择图片', { exact: true })
    .setInputFiles(resolve('tests/fixtures/images/page-1.png'));
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const image = page.getByRole('application', { name: '图片标注画布' }).locator('img');
  await expect(image).toBeVisible();
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  await expect(page.getByRole('textbox', { name: 'OCR 原文', exact: true })).toBeVisible();
}
function cached(bytes: Buffer) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 < tar.length;) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/, '')
        .trim(),
      8,
    );
    if (name === 'bunny_cache.json')
      return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing bunny_cache.json');
}
async function save(page: Page) {
  const download = page.waitForEvent('download');
  await page.keyboard.press(`${mod}+s`);
  return readFile((await (await download).path())!);
}

test('real Rust WASM plugin registers and receives a cropped image through the SDK', async ({
  page,
}) => {
  await ready(page);
  await install(
    page,
    resolve('.cache/plugin-sdk-example/example.echo.bfplugin'),
    'Rust SDK example',
  );
  await project(page);
  await page.getByLabel('OCR 插件', { exact: true }).selectOption('example.echo/echo-ocr');
  await page.getByRole('button', { name: '识别原文', exact: true }).click();
  await expect(page.getByLabel('OCR 原文', { exact: true })).toHaveValue(
    /^Received \d+ image bytes$/,
  );
});

test('real Rust WASM command cancels through its independent control handle and reuses the same worker', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const observed = {
      started: 0,
      terminated: 0,
      commandWorkers: [] as number[],
      responses: [] as Array<{ worker: number; code?: string; result?: unknown }>,
    };
    Object.assign(window, { __rustCommandWorkers: observed });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private echoId = 0;
      private requests = new Set<string>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent) => {
          const packet = event.data?.message;
          if (packet?.kind === 'response' && this.requests.delete(packet.id))
            observed.responses.push({
              worker: this.echoId,
              code: packet.error?.code,
              result: packet.result,
            });
        });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const packet = message as {
          load?: { manifest?: { id?: string }; runtimeRole?: string };
          message?: { kind?: string; id: string; method?: string; params?: { commandId?: string } };
        };
        if (packet.load?.manifest?.id === 'example.echo' && packet.load.runtimeRole !== 'hooks')
          this.echoId = ++observed.started;
        if (
          this.echoId &&
          packet.message?.kind === 'request' &&
          packet.message.method === 'commands.execute' &&
          packet.message.params?.commandId === 'task-demo'
        ) {
          observed.commandWorkers.push(this.echoId);
          this.requests.add(packet.message.id);
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      terminate() {
        if (this.echoId) observed.terminated++;
        super.terminate();
      }
    } as typeof Worker;
  });
  await ready(page);
  await install(
    page,
    resolve('.cache/plugin-sdk-example/example.echo.bfplugin'),
    'Rust SDK example',
  );
  const dialog = await center(page);
  const card = dialog.getByRole('article', { name: 'Rust SDK example', exact: true });
  const title = 'Rust: task progress and cancellation';
  const command = card.getByRole('button', { name: title, exact: true });
  const feedback = card.getByRole('region', { name: `${title} 执行结果`, exact: true });
  await command.click();
  await expect(feedback).toHaveAttribute('data-state', 'running');
  await expect(feedback.getByRole('status')).toHaveText('Rust command step');
  await expect
    .poll(() => feedback.getByRole('progressbar').evaluate((bar: HTMLProgressElement) => bar.value))
    .toBeGreaterThan(0);
  await feedback.getByRole('button', { name: '取消命令', exact: true }).click();
  await expect(feedback).toHaveAttribute('data-state', 'cancelled');
  await expect(feedback.getByRole('status')).toHaveText('已取消');
  await expect(card.getByText('已激活', { exact: true })).toBeVisible();
  await expect(command).toBeEnabled();
  const cancelled = await page.evaluate(
    () =>
      (
        window as unknown as {
          __rustCommandWorkers: {
            started: number;
            terminated: number;
            responses: Array<{ code?: string }>;
          };
        }
      ).__rustCommandWorkers,
  );
  expect(cancelled.started).toBe(1);
  expect(cancelled.terminated).toBe(0);
  // Assert the real WASM reply is cancelled, rather than merely ignoring a completed result.
  expect(cancelled.responses[0].code).toBe('cancelled');

  await command.click();
  await expect(feedback).toHaveAttribute('data-state', 'completed');
  await expect(feedback.getByRole('status')).toHaveText('Rust command completed');
  await feedback.getByText('数据详情', { exact: true }).click();
  await expect(feedback.locator('pre')).toHaveText('{\n  "completed": 100\n}');
  const reused = await page.evaluate(
    () =>
      (
        window as unknown as {
          __rustCommandWorkers: {
            started: number;
            terminated: number;
            commandWorkers: number[];
            responses: Array<{ code?: string; result?: unknown }>;
          };
        }
      ).__rustCommandWorkers,
  );
  expect(reused.started).toBe(1);
  expect(reused.terminated).toBe(0);
  expect(reused.commandWorkers).toEqual([1, 1]);
  expect(reused.responses[1]).toMatchObject({ result: { completed: 100 } });
  expect(reused.responses[1].code).toBeUndefined();
});

test('deleting original text before its previous ACK arrives preserves the latest draft and saved cache', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const gate = { hold: true, replies: [] as Array<() => void> };
    Object.assign(window, { __originalAckGate: gate });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private ids = new Set<number>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          'message',
          (event: MessageEvent) => {
            if (this.replaying || !gate.hold || !this.ids.has(event.data?.id)) return;
            event.stopImmediatePropagation();
            gate.replies.push(() => {
              this.replaying = true;
              this.dispatchEvent(new MessageEvent('message', { data: event.data }));
              this.replaying = false;
            });
          },
          { capture: true },
        );
      }
      postMessage(
        message: { id: number; method?: string; args?: Array<{ command?: { type: string } }> },
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        if (
          message.method === 'dispatch' &&
          message.args?.[0]?.command?.type === 'updateAssistance'
        )
          this.ids.add(message.id);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    } as typeof Worker;
  });
  await ready(page);
  await project(page);
  const original = page.getByLabel('OCR 原文', { exact: true });
  await original.fill('等待确认的原文');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __originalAckGate: { replies: unknown[] } }).__originalAckGate
            .replies.length,
      ),
    )
    .toBe(1);
  await original.fill('');
  await page.evaluate(() => {
    const gate = (
      window as unknown as { __originalAckGate: { hold: boolean; replies: Array<() => void> } }
    ).__originalAckGate;
    gate.hold = false;
    gate.replies.splice(0).forEach((reply) => reply());
  });
  await expect(page.getByTestId('ready')).toHaveText('就绪');
  await expect(original).toHaveValue('');
  expect(cached(await save(page))[0].originalText).toBe('');
});
