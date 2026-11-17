import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('retires an active legacy worker without reloading editors or removing user data', async ({
  page,
}) => {
  const retirement = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  let upgraded = false;
  let serveRetirement = false;
  const shell = (name: string) =>
    `<!doctype html><title>${name}</title><textarea>unsaved translation</textarea>`;
  const oldWorker = `
    self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (event) => {
      if (event.request.mode === 'navigate') {
        event.respondWith(caches.open('index-cache').then(async (cache) =>
          (await cache.match(self.registration.scope)) || fetch(event.request)));
      }
    });
  `;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/sw.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(serveRetirement ? retirement : oldWorker);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(shell(upgraded ? 'Bubblefish 0.4.0' : 'Legacy shell'));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          }),
        );
    });
    await page.evaluate(async (html) => {
      const names = [
        'index-cache',
        'images-cache',
        'wasm-cache',
        'static-resources',
        `workbox-precache-v2-${location.origin}/`,
        `workbox-precache-v2-${location.origin}/another-app/`,
        'bubblefish-plugin-models-example.ocr',
        'unrelated-cache',
      ];
      for (const name of names) {
        const cache = await caches.open(name);
        await cache.put(
          location.origin + '/',
          new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
        );
      }
      localStorage.setItem('bubblefish-next.editor', 'preserved old preference');
      localStorage.setItem('bubblefish.editor', 'preserved current preference');
      const request = indexedDB.open('bubblefish_snapshots', 1);
      await new Promise<void>((resolve, reject) => {
        request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('snapshots', 'readwrite');
          transaction.objectStore('snapshots').put('saved snapshot', 'project');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    }, shell('Cached legacy shell'));
    upgraded = true;
    // The old worker still serves its cached UI even after the server is upgraded.
    await page.reload();
    await expect(page).toHaveTitle('Cached legacy shell');
    await page.locator('textarea').fill('translation being edited');
    const documentToken = await page.evaluate(() => {
      const token = crypto.randomUUID();
      document.documentElement.dataset.editorToken = token;
      return token;
    });
    serveRetirement = true;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Legacy worker was not registered');
      await registration.update();
    });
    await expect
      .poll(() => page.evaluate(async () => !(await navigator.serviceWorker.getRegistration())))
      .toBe(true);
    await expect(page).toHaveTitle('Cached legacy shell');
    await expect(page.locator('textarea')).toHaveValue('translation being edited');
    await expect(page.locator('html')).toHaveAttribute('data-editor-token', documentToken);
    const preserved = await page.evaluate(async () => {
      const snapshot = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bubblefish_snapshots', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('snapshots').objectStore('snapshots').get('project');
          read.onsuccess = () => {
            resolve(read.result);
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      });
      return {
        caches: (await caches.keys()).sort(),
        oldPreference: localStorage.getItem('bubblefish-next.editor'),
        currentPreference: localStorage.getItem('bubblefish.editor'),
        snapshot,
      };
    });
    expect(preserved).toEqual({
      caches: [
        'bubblefish-plugin-models-example.ocr',
        'unrelated-cache',
        `workbox-precache-v2-${origin}/another-app/`,
      ].sort(),
      oldPreference: 'preserved old preference',
      currentPreference: 'preserved current preference',
      snapshot: 'saved snapshot',
    });
    await page.reload();
    await expect(page).toHaveTitle('Bubblefish 0.4.0');
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
