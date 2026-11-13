import { describe, expect, it } from 'vitest';
import { cropRegion } from '../src/runtime/crop-region';

describe('OCR crop coordinates', () => {
  it('converts normalized rectangles and clips them to the image', () => {
    expect(
      cropRegion({ type: 'rectangle', x: 0.9, y: 0.8, width: 0.2, height: 0.4 }, 1000, 2000),
    ).toEqual({ x: 900, y: 1600, width: 100, height: 400 });
  });
  it('uses the legacy point region and supports tiny images and edge anchors', () => {
    expect(cropRegion({ type: 'point', x: 0.5, y: 0.5 }, 1000, 2000)).toEqual({
      x: 450,
      y: 900,
      width: 100,
      height: 200,
    });
    expect(cropRegion({ type: 'point', x: 1, y: 1 }, 10, 10)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });
});
