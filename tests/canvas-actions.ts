import { expect, type Page } from '@playwright/test';

/** Create a page's first marker after the canvas has finished fitting its sheet. */
export async function addFirstCanvasPoint(page: Page): Promise<void> {
  const canvas = page.getByRole('application', { name: '图片标注画布', exact: true });
  const markers = canvas.locator('.canvas-marker');
  await expect(markers).toHaveCount(0);
  await canvas.locator('.canvas-sheet').click();
  await expect(markers).toHaveCount(1);
}
