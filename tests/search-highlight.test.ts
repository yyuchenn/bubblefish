import { describe, expect, it } from 'vitest';
import {
  textOffsetToEditorPosition,
  validSearchRange,
  type SearchHighlight,
} from '../src/runtime/search-highlight';

describe('search highlight ranges', () => {
  it('maps UTF-16 text offsets to paragraph positions, including empty paragraphs', () => {
    const text = 'a😀\n\nb';
    expect([0, 1, 3, 4, 5, 6].map((offset) => textOffsetToEditorPosition(text, offset))).toEqual([
      1, 2, 4, 6, 8, 9,
    ]);
    expect(textOffsetToEditorPosition('', 0)).toBe(1);
  });

  it('accepts zero-width ranges and rejects stale or malformed ranges', () => {
    const highlight: SearchHighlight = {
      projectId: 'project',
      imageId: 'image',
      markerId: 'marker',
      field: 'translation',
      text: '译文😀',
      from: 2,
      to: 2,
    };
    expect(validSearchRange(highlight, '译文😀')).toBe(true);
    expect(validSearchRange(highlight, '新译文😀')).toBe(false);
    expect(validSearchRange({ ...highlight, from: -1 }, highlight.text)).toBe(false);
    expect(validSearchRange({ ...highlight, to: 5 }, highlight.text)).toBe(false);
    expect(validSearchRange({ ...highlight, from: 3, to: 2 }, highlight.text)).toBe(false);
    expect(validSearchRange({ ...highlight, from: 0.5 }, highlight.text)).toBe(false);
  });
});
