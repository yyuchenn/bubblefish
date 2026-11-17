import { expect, test, type Page } from '@playwright/test';

const section = (page: Page) => page.getByRole('region', { name: '软件更新' });
const calls = (page: Page) => page.getByRole('list', { name: '原生调用记录' });
async function available(page: Page) {
  await section(page).getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(section(page).getByRole('status')).toHaveText('正在检查更新…');
  await page.getByRole('button', { name: '返回新版本', exact: true }).click();
  await expect(section(page).getByRole('status')).toHaveText('发现新版本 0.4.1');
}
async function ready(page: Page) {
  await available(page);
  await section(page).getByRole('button', { name: '下载更新', exact: true }).click();
  await page.getByRole('button', { name: '完成下载', exact: true }).click();
  await expect(section(page).getByRole('status')).toHaveText('更新 0.4.1 已下载并验证');
}

test('manual checking, fallback source, plain notes and actual download progress use the shared updater', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/updater/index.html');
  await expect(section(page)).toContainText('尚未检查更新');
  await available(page);
  await expect(section(page)).toContainText('来源：GitHub');
  await expect(section(page)).toContainText('<b>Plain release notes</b>');
  await expect(section(page).locator('b')).toHaveCount(0);
  await expect(calls(page)).toContainText('check:gitee');
  await section(page).getByRole('button', { name: '下载更新', exact: true }).click();
  await page.getByRole('button', { name: '未知大小进度', exact: true }).click();
  await expect(section(page).getByRole('progressbar')).not.toHaveAttribute('value');
  await expect(section(page)).toContainText('已下载 8 KiB');
  await page.getByRole('button', { name: '已知大小进度', exact: true }).click();
  await expect(section(page).getByRole('progressbar')).toHaveAttribute('value', '50');
  await page.getByRole('button', { name: '验证下载', exact: true }).click();
  await expect(section(page).getByRole('status')).toHaveText('正在验证更新签名…');
  await page.getByRole('button', { name: '完成下载', exact: true }).click();
  await expect(
    section(page).getByRole('button', { name: '安装并重启', exact: true }),
  ).toBeEnabled();
  await expect(calls(page)).not.toContainText('native:');
  await page.reload();
  await expect(section(page)).toContainText('更新 0.4.1 已下载并验证');
});

test('installation cancellation and failure preserve the editor, then allow an explicit skip-update quit', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/updater/index.html');
  await ready(page);
  await page.getByRole('textbox', { name: '未保存译文' }).fill('输入中的译文保持不变');
  await page.getByRole('combobox', { name: '项目退出选择' }).selectOption('cancel');
  await section(page).getByRole('button', { name: '安装并重启', exact: true }).click();
  await expect(calls(page)).toContainText('resume-plugins:false');
  await expect(calls(page)).not.toContainText('native:');
  await expect(page.getByRole('textbox', { name: '未保存译文' })).toHaveValue(
    '输入中的译文保持不变',
  );
  await page.getByRole('combobox', { name: '项目退出选择' }).selectOption('save');
  await page.getByRole('checkbox', { name: '模拟安装失败' }).check();
  await section(page).getByRole('button', { name: '安装并重启', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('安装程序启动失败');
  await expect(calls(page)).toContainText('resume-plugins:true');
  await expect(page.getByRole('textbox', { name: '未保存译文' })).toBeEditable();
  await page.getByRole('button', { name: '跳过更新并退出', exact: true }).click();
  await expect(calls(page)).toContainText('native:quit:true');
  await expect(page.getByRole('status').filter({ hasText: '退出已提交' })).toBeVisible();
});

test('independent preferences persist and unsupported builds keep checks available without installation', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/updater/index.html?unsupported');
  await expect(section(page)).toContainText('开发构建仅支持检查更新');
  await section(page)
    .getByRole('checkbox', { name: /^自动下载更新/ })
    .check();
  await section(page)
    .getByRole('checkbox', { name: /^退出时安装/ })
    .uncheck();
  await available(page);
  await expect(section(page).getByRole('button', { name: '下载更新', exact: true })).toBeDisabled();
  await expect(calls(page)).not.toContainText('download:');
  await page.reload();
  await expect(section(page).getByRole('checkbox', { name: /^自动检查更新/ })).not.toBeChecked();
  await expect(section(page).getByRole('checkbox', { name: /^自动下载更新/ })).toBeChecked();
  await expect(section(page).getByRole('checkbox', { name: /^退出时安装/ })).not.toBeChecked();
});

test('browser settings provide release information without native update controls or checks', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/updater/index.html?browser');
  await expect(section(page)).toContainText('当前版本 0.4.0');
  await expect(section(page).getByRole('link', { name: '查看发布记录' })).toHaveAttribute(
    'href',
    'https://github.com/yyuchenn/bubblefish/releases',
  );
  await expect(section(page).getByRole('button')).toHaveCount(0);
  await expect(calls(page).locator('li')).toHaveCount(0);
});

test('a newer available release remains downloadable while a previous verified update is staged', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/updater/index.html');
  await ready(page);
  await page.goto('/tests/fixtures/updater/index.html?newer');
  await section(page).getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '返回新版本', exact: true }).click();
  await expect(section(page).getByRole('status')).toHaveText('发现新版本 0.4.2；已下载 0.4.1');
  await expect(section(page).getByRole('button', { name: '下载更新', exact: true })).toBeEnabled();
  await expect(
    section(page).getByRole('button', { name: '安装 0.4.1 并重启', exact: true }),
  ).toBeEnabled();
});
