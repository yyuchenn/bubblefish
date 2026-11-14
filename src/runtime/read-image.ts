import type { PluginImageRegion } from '../generated/plugins';
import { newId } from './plugins/types';

/** Decode and PNG encoding happen in a disposable worker, keeping large images off the UI thread. */
export function readImageRegion(
  file: Blob,
  region: PluginImageRegion,
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  for (const value of [region.x, region.y, region.width, region.height])
    if (!Number.isFinite(value)) throw new Error('裁剪区域必须是有限数值');
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1 ||
    region.y + region.height > 1
  )
    throw new Error('裁剪区域必须在 0 到 1 的归一化图片坐标内');
  const worker = new Worker(new URL('./crop-worker.ts', import.meta.url), {
    type: 'module',
    name: 'plugin-image-read',
  });
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('图片裁剪超时'));
    }, 30000);
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (error) => {
      finish();
      reject(new Error(error.message || '图片裁剪进程失败'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('图片裁剪返回无效数据'));
    };
    worker.postMessage({ id: newId(), file, geometry: { type: 'rectangle', ...region } });
  });
}

/** Determine the encoded media type from bytes rather than a plugin supplied extension. */
export function encodedImageMime(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
    return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  )
    return 'image/webp';
  return 'application/octet-stream';
}
