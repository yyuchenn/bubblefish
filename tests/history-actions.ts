import type { Page } from '@playwright/test';

export async function historyFromMenu(page: Page, direction: 'undo' | 'redo') {
  const header = page.locator('header.titlebar');
  await header
    .locator('.menu-bar summary')
    .filter({ hasText: /^编辑$/ })
    .click();
  await header.getByRole('button', { name: direction === 'undo' ? /^撤销/ : /^重做/ }).click();
}
