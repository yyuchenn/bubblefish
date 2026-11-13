import { expect, test } from '@playwright/test';

test('local model files persist as IndexedDB chunks across reload and remain isolated by plugin', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  const original = await page.evaluate(async () => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/plugins/local-resources.ts`
    );
    const store = new module.BrowserLocalResourceStorage();
    const bytes = new Uint8Array(4 * 1024 * 1024 + 17);
    bytes[0] = 11;
    bytes[4 * 1024 * 1024] = 23;
    bytes[bytes.length - 1] = 37;
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const { token } = await store.beginImport('model.test', 'panel', {
      id: 'fp32',
      files: [{ path: 'encoder.onnx', byteLength: bytes.length, sha256: digest }],
    });
    await store.writeChunk(
      'model.test',
      'panel',
      token,
      'encoder.onnx',
      0,
      bytes.slice(0, 4 * 1024 * 1024).buffer,
    );
    await store.writeChunk(
      'model.test',
      'panel',
      token,
      'encoder.onnx',
      4 * 1024 * 1024,
      bytes.slice(4 * 1024 * 1024).buffer,
    );
    await store.commitImport('model.test', 'panel', token);
    await store.releaseOwner('model.test', 'panel');
    return { digest, bytes: bytes.length };
  });
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  const restored = await page.evaluate(async () => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/plugins/local-resources.ts`
    );
    const store = new module.BrowserLocalResourceStorage();
    const sets = await store.list('model.test'),
      other = await store.list('other.plugin');
    const bytes = await store.read('model.test', 'fp32', 'encoder.onnx');
    let denied = false;
    try {
      await store.read('other.plugin', 'fp32', 'encoder.onnx');
    } catch {
      denied = true;
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    await store.removePlugin('model.test');
    return {
      sets,
      other,
      denied,
      digest,
      bytes: bytes.byteLength,
      removed: await store.list('model.test'),
    };
  });
  expect(restored).toMatchObject({
    digest: original.digest,
    bytes: original.bytes,
    other: [],
    denied: true,
    removed: [],
  });
  expect(restored.sets).toHaveLength(1);
  expect(restored.sets[0]).toMatchObject({
    id: 'fp32',
    files: [{ path: 'encoder.onnx', sha256: original.digest, byteLength: original.bytes }],
  });
});

test('a failed replacement keeps the previous ready catalog and removes incomplete IndexedDB chunks', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  const result = await page.evaluate(async () => {
    const module = await import(
      /* @vite-ignore */ `${location.origin}/src/runtime/plugins/local-resources.ts`
    );
    const store = new module.BrowserLocalResourceStorage(),
      original = new TextEncoder().encode('correct model');
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', original)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const input = {
      id: 'fp32',
      files: [{ path: 'encoder.onnx', byteLength: original.byteLength, sha256: digest }],
    };
    const first = await store.beginImport('model.test', 'panel', input);
    await store.writeChunk('model.test', 'panel', first.token, 'encoder.onnx', 0, original.buffer);
    await store.commitImport('model.test', 'panel', first.token);
    const second = await store.beginImport('model.test', 'panel', input);
    await store.writeChunk(
      'model.test',
      'panel',
      second.token,
      'encoder.onnx',
      0,
      new TextEncoder().encode('invalid model').buffer,
    );
    let error = '';
    try {
      await store.commitImport('model.test', 'panel', second.token);
    } catch (failure) {
      error = String(failure);
    }
    const text = new TextDecoder().decode(await store.read('model.test', 'fp32', 'encoder.onnx'));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bubblefish-local-resources', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const counts = await new Promise<{ pending: number; chunks: number }>((resolve) => {
      const tx = db.transaction(['imports', 'chunks']),
        pending = tx.objectStore('imports').count(),
        chunks = tx.objectStore('chunks').count();
      tx.oncomplete = () => resolve({ pending: pending.result, chunks: chunks.result });
    });
    db.close();
    await store.removePlugin('model.test');
    return { error, text, counts };
  });
  expect(result.error).toContain('SHA-256');
  expect(result.text).toBe('correct model');
  expect(result.counts).toEqual({ pending: 0, chunks: 1 });
});
