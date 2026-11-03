/// <reference lib="webworker" />
import { cropRegion } from './crop-region';
import type { Geometry } from '../generated/core';

self.onmessage = async ({ data }: MessageEvent<{ id: string; file: Blob; geometry: Geometry }>) => {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(data.file);
    const region = cropRegion(data.geometry, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(region.width, region.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片裁剪画布');
    context.drawImage(
      bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    const bytes = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    self.postMessage(
      { id: data.id, bytes, width: region.width, height: region.height },
      { transfer: [bytes] },
    );
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap?.close();
  }
};
