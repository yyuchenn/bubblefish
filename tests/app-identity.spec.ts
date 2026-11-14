import { expect, test } from '@playwright/test';

test('shows the Bubblefish identity and release version throughout the workspace', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(page).toHaveTitle('Bubblefish');
  await expect(page.locator('.brand > span')).toHaveText('Bubblefish');
  await expect(page.locator('.welcome .eyebrow')).toHaveText('BUBBLEFISH');
  const header = page.locator('header.titlebar');
  await header
    .locator('.menu-bar summary')
    .filter({ hasText: /^更多$/ })
    .click();
  await header.getByRole('button', { name: '设置与外观', exact: true }).click();
  await expect(page.locator('.settings-note')).toContainText('Bubblefish 0.4.0');
});

test('uses fresh canonical stores while leaving the previous next databases intact', async ({
  page,
}) => {
  // A static document avoids application startup creating any databases first.
  await page.goto('/tests/fixtures/images/page-1.png');
  const result = await page.evaluate(async () => {
    const oldNames = [
      'bubblefish-next',
      'bubblefish-next-plugins',
      'bubblefish-next-local-resources',
    ];
    function oldDatabase(name: string) {
      return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('sentinel');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    for (const name of oldNames) {
      const db = await oldDatabase(name);
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('sentinel', 'readwrite');
        transaction.objectStore('sentinel').put('previous installation', 'data');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    }
    const { snapshots } = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/snapshots.ts`
    );
    const { BrowserPluginStorage } = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/plugins/storage.ts`
    );
    const { BrowserLocalResourceStorage } = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/plugins/local-resources.ts`
    );
    const fresh = {
      snapshots: await snapshots.list(),
      plugins: await new BrowserPluginStorage().list(),
      resources: await new BrowserLocalResourceStorage().list('test.plugin'),
    };
    const previous = [];
    for (const name of oldNames) {
      const db = await oldDatabase(name);
      previous.push(
        await new Promise((resolve, reject) => {
          const request = db.transaction('sentinel').objectStore('sentinel').get('data');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
      );
      db.close();
    }
    return {
      fresh,
      previous,
      names: (await indexedDB.databases()).map((entry) => entry.name),
    };
  });
  expect(result.fresh).toEqual({ snapshots: [], plugins: [], resources: [] });
  expect(result.previous).toEqual(Array(3).fill('previous installation'));
  expect(result.names).toEqual(
    expect.arrayContaining(['bubblefish', 'bubblefish-plugins', 'bubblefish-local-resources']),
  );
});
