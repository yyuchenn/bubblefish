import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const fixture = resolve('.cache/plugin-command-feedback.bfplugin');
const otherFixture = resolve('.cache/plugin-command-other.bfplugin');
const name = '命令反馈测试';

test.beforeAll(async () => {
  await mkdir('.cache', { recursive: true });
  await promisify(execFile)(process.execPath, [
    'scripts/package-plugin.mjs',
    'tests/fixtures/plugin-commands',
    '--out',
    fixture,
  ]);
  const files = unzipSync(await readFile(fixture));
  const manifest = JSON.parse(strFromU8(files['plugin.json']));
  manifest.id = 'test.command-other';
  manifest.name = '命令反馈测试乙';
  files['plugin.json'] = strToU8(JSON.stringify(manifest));
  await writeFile(otherFixture, zipSync(files));
});

async function center(page: Page) {
  await page.getByRole('button', { name: '插件管理', exact: true }).click();
  return page.getByRole('dialog', { name: '插件管理', exact: true });
}

async function install(dialog: Locator, file = fixture, title = name) {
  await dialog.getByLabel('安装插件包', { exact: true }).setInputFiles(file);
  const card = dialog.getByRole('article', { name: title, exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
  return card;
}

async function setup(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ready')).toHaveText('就绪', { timeout: 30_000 });
  const dialog = await center(page);
  return { dialog, card: await install(dialog) };
}

const feedback = (card: Locator, title: string) =>
  card.getByRole('region', { name: `${title} 执行结果`, exact: true });

test('card reports success summary and safely preserves all result shapes without a global alert', async ({
  page,
}) => {
  const { card } = await setup(page);
  await card.getByRole('button', { name: '查询测试状态', exact: true }).click();
  let result = feedback(card, '查询测试状态');
  await expect(result).toHaveAttribute('data-state', 'completed');
  await expect(result).toContainText('查询完成：测试模型已就绪');
  const detail = result.locator('details');
  await expect(detail).not.toHaveAttribute('open', '');
  await detail.getByText('数据详情', { exact: true }).click();
  await expect(detail.locator('pre')).toContainText('"ready": true');
  await expect(detail.locator('pre')).toContainText('<script>unsafe()</script>');
  await expect(detail.locator('script')).toHaveCount(0);
  await expect(page.locator('.plugin-command-notice')).toHaveCount(0);

  for (const [title, expected] of [
    ['返回空值', 'null'],
    ['返回布尔值', 'false'],
    ['返回零', '0'],
    ['返回文本', '完整文字\n第二行'],
  ]) {
    await card.getByRole('button', { name: title, exact: true }).click();
    result = feedback(card, title);
    await expect(result).toHaveAttribute('data-state', 'completed');
    await expect(result.getByRole('status')).toHaveText('执行完成');
    await result.getByText('数据详情', { exact: true }).click();
    await expect(result.locator('pre')).toHaveText(expected);
  }
  await card.getByRole('button', { name: '返回未通过数据', exact: true }).click();
  result = feedback(card, '返回未通过数据');
  await expect(result).toHaveAttribute('data-state', 'completed');
  await expect(result.getByRole('status')).toHaveText('执行完成');
  await result.getByText('数据详情', { exact: true }).click();
  await expect(result.locator('pre')).toContainText('"passed": false');
  await expect(result).not.toContainText('自检通过');
});

test('progress and cancellation persist across manager closure, then allow a successful retry', async ({
  page,
}) => {
  const { card, dialog } = await setup(page);
  const delay = card.getByLabel('命令反馈测试 命令测试等待毫秒', { exact: true });
  await delay.fill('3000');
  await delay.press('Tab');
  await card.getByRole('button', { name: '执行等待测试', exact: true }).click();
  let result = feedback(card, '执行等待测试');
  await expect(result).toHaveAttribute('data-state', 'running');
  await expect(result).toContainText('正在执行分步测试');
  await expect(result.getByRole('progressbar')).toHaveAttribute('max', '3');
  await expect(card.getByRole('button', { name: '查询测试状态', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const reopened = await center(page);
  const current = reopened.getByRole('article', { name, exact: true });
  result = feedback(current, '执行等待测试');
  await expect(result).toHaveAttribute('data-state', 'running');
  await result.getByRole('button', { name: '取消命令', exact: true }).click();
  await expect(result).toHaveAttribute('data-state', 'cancelled');
  await expect(result).not.toContainText('分步测试已完成');
  await current.getByRole('button', { name: '查询测试状态', exact: true }).click();
  await expect(feedback(current, '查询测试状态')).toHaveAttribute('data-state', 'completed');
});

test('unknown progress stays indeterminate and cancellation does not manufacture a percentage', async ({
  page,
}) => {
  const { card } = await setup(page);
  await card.getByRole('button', { name: '执行未知进度测试', exact: true }).click();
  const result = feedback(card, '执行未知进度测试');
  await expect(result).toContainText('正在等待服务响应');
  const progress = result.getByRole('progressbar');
  await expect(progress).not.toHaveAttribute('value', /.*/);
  await expect(progress).not.toHaveAttribute('aria-valuenow', /.*/);
  await expect(result).not.toContainText('%');
  await result.getByRole('button', { name: '取消命令', exact: true }).click();
  await expect(result).toHaveAttribute('data-state', 'cancelled');
});

test('uncooperative cancellation waits for real settlement while another plugin remains usable', async ({
  page,
}) => {
  const { card, dialog } = await setup(page);
  const other = await install(dialog, otherFixture, '命令反馈测试乙');
  await card.getByRole('button', { name: '执行不合作取消测试', exact: true }).click();
  const result = feedback(card, '执行不合作取消测试');
  await expect(result).toContainText('执行暂不响应取消的操作');
  await result.getByRole('button', { name: '取消命令', exact: true }).click();
  await expect(result).toHaveAttribute('data-state', 'cancelling');
  await expect(result).toContainText('等待插件结束当前步骤');
  await expect(result.getByRole('button', { name: '取消命令', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: '查询测试状态', exact: true })).toBeDisabled();
  await other.getByRole('button', { name: '查询测试状态', exact: true }).click();
  await expect(feedback(other, '查询测试状态')).toHaveAttribute('data-state', 'completed');
  await expect(result).toHaveAttribute('data-state', 'cancelled');
  await expect(result).not.toContainText('迟到的成功摘要');
  await expect(result).not.toContainText('迟到的命令结果');
  await expect(card.getByRole('button', { name: '查询测试状态', exact: true })).toBeEnabled();
});

test('command errors stay within their card and do not publish a premature success summary', async ({
  page,
}) => {
  const { card, dialog } = await setup(page);
  await card.getByRole('button', { name: '触发测试错误', exact: true }).click();
  let result = feedback(card, '触发测试错误');
  await expect(result).toHaveAttribute('data-state', 'failed');
  await expect(result.getByRole('alert')).toHaveText('测试失败，请重试');
  await card.getByRole('button', { name: '摘要后触发错误', exact: true }).click();
  result = feedback(card, '摘要后触发错误');
  await expect(result).toHaveAttribute('data-state', 'failed');
  await expect(result.getByRole('alert')).toHaveText('操作在完成前失败');
  await expect(result).not.toContainText('这条成功摘要不应显示');
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const reopened = await center(page);
  await expect(
    feedback(reopened.getByRole('article', { name, exact: true }), '摘要后触发错误'),
  ).toHaveAttribute('data-state', 'failed');
});

test('menu command offers result navigation without opening a modal or stealing focus', async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByText('更多', { exact: true }).click();
  await page.getByRole('button', { name: '查询测试状态', exact: true }).click();
  const notice = page.locator('.plugin-command-notice');
  await expect(notice).toContainText('查询完成：测试模型已就绪');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await notice.getByRole('button', { name: '查看结果', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '插件管理', exact: true });
  const card = reopened.getByRole('article', { name, exact: true });
  await expect(card).toBeFocused();
  await expect(feedback(card, '查询测试状态')).toHaveAttribute('data-state', 'completed');
  await expect(notice).toHaveCount(0);
});

test('panel SDK calls keep raw results without creating host feedback or notifications', async ({
  page,
}) => {
  const { card } = await setup(page);
  await card.getByRole('button', { name: '内部命令测试面板', exact: true }).click();
  const frame = page.frameLocator('iframe[title="内部命令测试面板"]');
  await expect(frame.getByRole('status')).toHaveText('面板已连接');
  await frame.getByRole('button', { name: '执行内部状态查询', exact: true }).click();
  await expect(frame.getByRole('status')).toContainText('"ready":true');
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await expect(page.locator('.plugin-command-notice')).toHaveCount(0);
  const reopened = await center(page);
  await expect(
    reopened.getByRole('article', { name, exact: true }).getByRole('region'),
  ).toHaveCount(0);
});
