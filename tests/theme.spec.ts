import { expect, test, type Page } from '@playwright/test';

const themeLabels = { ocean: '海洋', fruit: '果实', dark: '夜间' } as const;
type Theme = keyof typeof themeLabels;
type ColorScheme = 'light' | 'dark';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
}

async function seedTheme(page: Page, theme: string) {
  // Set the preference before application startup, without reseeding it on reload.
  await page.goto('/tests/fixtures/images/page-1.png');
  await page.evaluate((value) => localStorage.setItem('bubblefish.theme', value), theme);
}

async function storedTheme(page: Page) {
  return page.evaluate(() => localStorage.getItem('bubblefish.theme'));
}

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function changeSystemTheme(page: Page, colorScheme: ColorScheme) {
  await page.emulateMedia({ colorScheme });
  // Let the browser deliver the media-query change before checking a fixed preference.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

async function themeCard(page: Page, theme: Theme) {
  const header = page.locator('header.titlebar');
  await header
    .locator('.menu-bar summary')
    .filter({ hasText: /^更多$/ })
    .click();
  await header.getByRole('button', { name: '设置与外观', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置与外观', exact: true });
  await expect(dialog).toBeVisible();
  return dialog.getByRole('button', { name: new RegExp(`^${themeLabels[theme]}`) });
}

for (const [initialScheme, initialTheme, nextScheme, nextTheme] of [
  ['light', 'ocean', 'dark', 'dark'],
  ['dark', 'dark', 'light', 'ocean'],
] as const) {
  test(`a fresh ${initialScheme} system follows live appearance changes without saving a theme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: initialScheme });
    await ready(page);
    await expectTheme(page, initialTheme);
    expect(await storedTheme(page)).toBeNull();

    await changeSystemTheme(page, nextScheme);
    await expectTheme(page, nextTheme);
    expect(await storedTheme(page)).toBeNull();

    await page.reload();
    await expectTheme(page, nextTheme);
    expect(await storedTheme(page)).toBeNull();

    await changeSystemTheme(page, initialScheme);
    await expectTheme(page, initialTheme);
    expect(await storedTheme(page)).toBeNull();
  });
}

for (const theme of ['ocean', 'fruit', 'dark'] as const) {
  test(`a saved ${theme} theme takes priority over system changes and reloads`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await seedTheme(page, theme);
    await ready(page);
    await expectTheme(page, theme);

    for (const colorScheme of ['light', 'dark'] as const) {
      await changeSystemTheme(page, colorScheme);
      await expectTheme(page, theme);
      expect(await storedTheme(page)).toBe(theme);
    }
    await page.reload();
    await expectTheme(page, theme);
    expect(await storedTheme(page)).toBe(theme);
  });
}

test('choosing each theme saves it immediately and preserves it across system changes and reloads', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page);
  for (const [theme, colorScheme] of [
    ['fruit', 'light'],
    ['ocean', 'dark'],
    ['dark', 'light'],
  ] as const) {
    await (await themeCard(page, theme)).click();
    await expectTheme(page, theme);
    expect(await storedTheme(page)).toBe(theme);

    await changeSystemTheme(page, colorScheme);
    await expectTheme(page, theme);
    await page.reload();
    await expectTheme(page, theme);
    expect(await storedTheme(page)).toBe(theme);
  }
});

for (const [colorScheme, theme, nextScheme] of [
  ['light', 'ocean', 'dark'],
  ['dark', 'dark', 'light'],
] as const) {
  test(`clicking the current automatic ${theme} theme makes it an explicit preference`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await ready(page);
    const card = await themeCard(page, theme);
    await expect(card).toHaveClass(/chosen/);
    expect(await storedTheme(page)).toBeNull();
    await card.click();
    expect(await storedTheme(page)).toBe(theme);

    await changeSystemTheme(page, nextScheme);
    await expectTheme(page, theme);
    await page.reload();
    await expectTheme(page, theme);
    expect(await storedTheme(page)).toBe(theme);
  });
}

test('an unknown stored theme follows the system until a valid theme is chosen', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await seedTheme(page, 'unknown-theme');
  await ready(page);
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBe('unknown-theme');

  await changeSystemTheme(page, 'light');
  await expectTheme(page, 'ocean');
  expect(await storedTheme(page)).toBe('unknown-theme');
  await (await themeCard(page, 'fruit')).click();
  await expectTheme(page, 'fruit');
  expect(await storedTheme(page)).toBe('fruit');
  await page.reload();
  await expectTheme(page, 'fruit');
});

test('storage read failures allow system defaults and manual theme changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'bubblefish.theme') throw new DOMException('Storage denied', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page);
  await expectTheme(page, 'dark');
  await changeSystemTheme(page, 'light');
  await expectTheme(page, 'ocean');

  await (await themeCard(page, 'fruit')).click();
  await expectTheme(page, 'fruit');
  await changeSystemTheme(page, 'dark');
  await expectTheme(page, 'fruit');
  expect(errors).toEqual([]);
});

test('storage write failures keep a manual theme in memory without interrupting the app', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'bubblefish.theme') throw new DOMException('Storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page);
  await (await themeCard(page, 'fruit')).click();
  await expectTheme(page, 'fruit');
  expect(await storedTheme(page)).toBeNull();
  await changeSystemTheme(page, 'light');
  await expectTheme(page, 'fruit');

  await page.reload();
  await expectTheme(page, 'ocean');
  expect(await storedTheme(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('a browser without matchMedia defaults to ocean and still accepts manual themes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
  });
  await ready(page);
  await expectTheme(page, 'ocean');
  expect(await storedTheme(page)).toBeNull();
  await (await themeCard(page, 'dark')).click();
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBe('dark');
});
