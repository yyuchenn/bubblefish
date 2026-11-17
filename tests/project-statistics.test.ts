import { describe, expect, it } from 'vitest';
import type { Marker, ProjectDocument, RichText } from '../src/generated/core';
import { projectStatistics } from '../src/runtime/project-statistics';

function marker(id: string, translation: RichText, bunnyCache?: Marker['bunnyCache']): Marker {
  return {
    id,
    geometry: { type: 'point', x: 0.3, y: 0.3 },
    translation,
    style: { overlayText: false, horizontal: false },
    ...(bunnyCache === undefined ? {} : { bunnyCache }),
  };
}

function translated(id: string, text: string): Marker {
  return marker(id, { runs: [{ text, marks: [] }] });
}

function project(pages: Marker[][]): ProjectDocument {
  return {
    id: 'project',
    name: 'statistics',
    sourceLanguage: 'japanese',
    targetLanguage: 'simplifiedChinese',
    images: pages.map((markers, index) => ({
      id: `image-${index}`,
      assetId: `asset-${index}`,
      filename: `page-${index}.png`,
      width: 600,
      height: 900,
      markers,
    })),
  };
}

describe('project statistics', () => {
  it('returns zero counts for a project without images or without markers', () => {
    const zero = { totalMarkers: 0, nonEmptyMarkers: 0, totalCharacters: 0 };
    expect(projectStatistics(project([]))).toEqual(zero);
    expect(projectStatistics(project([[], []]))).toEqual(zero);
  });

  it('totals markers and translated characters across every image', () => {
    const document = project([
      [marker('empty', { runs: [] }), translated('blank', ' \n'), translated('chinese', '你好')],
      [translated('latin', 'abc!'), translated('emoji', 'x😀')],
      [],
    ]);
    expect(projectStatistics(document)).toEqual({
      totalMarkers: 5,
      nonEmptyMarkers: 3,
      totalCharacters: 8,
    });
  });

  it('treats empty runs and JavaScript whitespace as empty translations', () => {
    const document = project([
      [
        marker('no-runs', { runs: [] }),
        translated('empty-run', ''),
        translated(
          'whitespace',
          '\t\n\r \u00a0\u1680\u2000\u2003\u2028\u2029\u202f\u205f\u3000\ufeff',
        ),
      ],
    ]);
    expect(projectStatistics(document)).toEqual({
      totalMarkers: 3,
      nonEmptyMarkers: 0,
      totalCharacters: 0,
    });
  });

  it('combines rich-text runs and counts their text once regardless of formatting', () => {
    const document = project([
      [
        marker('formatted', {
          runs: [
            { text: '你', marks: ['bold', 'italic'] },
            { text: '好 ', marks: ['bold'] },
            { text: 'A,', marks: ['strike'] },
            { text: '\n', marks: [] },
            { text: '😀', marks: ['emphasis'] },
          ],
        }),
      ],
    ]);
    expect(projectStatistics(document)).toEqual({
      totalMarkers: 1,
      nonEmptyMarkers: 1,
      totalCharacters: 5,
    });
  });

  it('counts code points rather than UTF-16 units or grapheme clusters', () => {
    expect(projectStatistics(project([[translated('unicode', 'e\u0301é😀𠀀!')]]))).toEqual({
      totalMarkers: 1,
      nonEmptyMarkers: 1,
      totalCharacters: 6,
    });
    expect(projectStatistics(project([[translated('joiner', '👨‍👩')]])).totalCharacters).toBe(3);
  });

  it('joins surrogate pairs split across formatting runs before counting', () => {
    const document = project([
      [
        marker('split-emoji', {
          runs: [
            { text: '\ud83d', marks: ['bold'] },
            { text: '\ude00', marks: [] },
          ],
        }),
      ],
    ]);
    expect(projectStatistics(document)).toEqual({
      totalMarkers: 1,
      nonEmptyMarkers: 1,
      totalCharacters: 1,
    });
  });

  it('ignores assistance text and preserved legacy source without changing the document', () => {
    const document = project([
      [
        marker(
          'untranslated',
          { runs: [], raw: '<b>legacy source</b>' },
          {
            originalText: '已有 OCR 原文',
            machineTranslation: '已有机器译文',
          },
        ),
        marker(
          'translated',
          { runs: [{ text: '译文', marks: [] }], raw: 'do not count' },
          {
            originalText: 'another source',
            machineTranslation: 'another suggestion',
          },
        ),
      ],
    ]);
    const before = structuredClone(document);
    expect(projectStatistics(document)).toEqual({
      totalMarkers: 2,
      nonEmptyMarkers: 1,
      totalCharacters: 2,
    });
    expect(document).toEqual(before);
  });
});
