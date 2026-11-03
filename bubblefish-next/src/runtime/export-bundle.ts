import type { ProjectDocument } from '../generated/core';
import { checksumKey, type AssetStore } from './assets';
import type { CoreTransport } from './transports';

export function safeFilename(value: string) {
  return (
    value
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120) || 'image.png'
  );
}
/** The caller pins this document's immutable asset versions until the worker finishes. */
export async function encodeBundle(
  document: ProjectDocument,
  assets: AssetStore,
  transport: CoreTransport,
) {
  if (!transport.encodeProject) throw new Error('当前核心不支持资源包导出');
  const copy: ProjectDocument = structuredClone(document);
  copy.images.forEach((image, index) => {
    image.filename = `${String(index + 1).padStart(6, '0')}_${safeFilename(image.filename)}`;
  });
  const bf = new Uint8Array(await transport.encodeProject(copy, 'bf')).buffer;
  const worker = new Worker(new URL('./bundle-worker.ts', import.meta.url), { type: 'module' });
  const chunks: ArrayBuffer[] = [];
  let fail!: (error: Error) => void;
  const complete = new Promise<Uint8Array>((resolve, reject) => {
    fail = reject;
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      else {
        chunks.push(data.bytes);
        if (data.final)
          void new Blob(chunks)
            .arrayBuffer()
            .then((bytes) => resolve(new Uint8Array(bytes)), reject);
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || '资源包导出进程已停止'));
  });
  // Suppress an early worker error until the producer reaches the same result.
  void complete.catch(() => {});
  try {
    worker.postMessage({ name: `${safeFilename(document.name)}.bf`, bytes: bf }, [bf]);
    for (const [index, image] of document.images.entries()) {
      const bytes = await (await assets.file(image.assetId)).arrayBuffer();
      const probe = await transport.probeImage(new Uint8Array(bytes));
      if (
        (image.checksum && checksumKey(image.checksum) !== checksumKey(probe.checksum)) ||
        image.width !== probe.width ||
        image.height !== probe.height
      )
        throw new Error(`图片内容已在应用外变化：${image.filename}`);
      worker.postMessage({ name: `images/${copy.images[index].filename}`, bytes }, [bytes]);
    }
    worker.postMessage({ end: true });
    return await complete;
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    worker.terminate();
  }
}
