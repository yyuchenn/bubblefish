import { expect, type Page } from '@playwright/test';

/** Measure the stable sheet without scrolling it or changing pointer state. */
export async function canvasSheetBounds(page: Page) {
  const sheet = await page
    .getByRole('application', { name: '图片标注画布', exact: true })
    .locator('.canvas-sheet')
    .elementHandle({ timeout: 7_000 });
  try {
    await sheet.waitForElementState('visible', { timeout: 7_000 });
    await sheet.waitForElementState('stable', { timeout: 7_000 });
    const bounds = await sheet.boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0)
      throw new Error('The canvas sheet has no measurable bounds.');
    return bounds;
  } finally {
    await sheet.dispose();
  }
}

/** Create a page's first marker after the canvas has finished fitting its sheet. */
export async function addFirstCanvasPoint(page: Page): Promise<void> {
  const canvas = page.getByRole('application', { name: '图片标注画布', exact: true });
  const markers = canvas.locator('.canvas-marker');
  await expect(markers).toHaveCount(0);
  await canvas.locator('.canvas-sheet').click();
  await expect(markers).toHaveCount(1);
}
