import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { testServerUrl } from './tests/server';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/ms-playwright');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  outputDir: '.cache/playwright-results',
  globalSetup: './tests/global-setup.ts',
  reporter: [['list'], ['html', { outputFolder: '.cache/playwright-report', open: 'never' }]],
  use: {
    baseURL: testServerUrl,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
