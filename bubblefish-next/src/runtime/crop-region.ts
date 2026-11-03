import type { Geometry } from '../generated/core';

/** Point OCR keeps the original app's 10% region, with a minimum of 50 px. */
export function cropRegion(geometry: Geometry, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('图片尺寸无效');
  const rectangle = geometry.type === 'rectangle';
  const w = rectangle
    ? Math.max(1, Math.floor(geometry.width * width))
    : Math.max(50, Math.floor(width * 0.1));
  const h = rectangle
    ? Math.max(1, Math.floor(geometry.height * height))
    : Math.max(50, Math.floor(height * 0.1));
  const x = Math.min(
    width - 1,
    Math.max(0, Math.floor(geometry.x * width) - (rectangle ? 0 : Math.floor(w / 2))),
  );
  const y = Math.min(
    height - 1,
    Math.max(0, Math.floor(geometry.y * height) - (rectangle ? 0 : Math.floor(h / 2))),
  );
  return { x, y, width: Math.min(w, width - x), height: Math.min(h, height - y) };
}
