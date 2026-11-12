import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANCE_TAB_ID,
  bottomPanelBounds,
  clampBottomHeight,
  readAssistancePreferences,
  readEditorPreferences,
  readLayout,
  writePreference,
} from '../src/runtime/preferences';

afterEach(() => vi.unstubAllGlobals());

describe('assistance provider preferences', () => {
  it.each([null, 'not json', 'null', '[]', '42', '"provider"', '{}'])(
    'leaves both providers unselected for missing or invalid stored values: %s',
    (stored) => {
      vi.stubGlobal('localStorage', { getItem: () => stored });
      expect(readAssistancePreferences()).toEqual({ ocr: '', translator: '' });
    },
  );

  it('round-trips independent full provider IDs with the application namespace', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const selection = { ocr: 'example.first/provider', translator: 'example.second/provider' };
    writePreference('assistance', JSON.stringify(selection));
    expect(values.get('bubblefish-next.assistance')).toBe(JSON.stringify(selection));
    expect(readAssistancePreferences()).toEqual(selection);
  });

  it.each(['ocr', 'translator'] as const)(
    'remembers an explicit empty %s selection without clearing the other provider',
    (field) => {
      const values = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      });
      writePreference(
        'assistance',
        JSON.stringify({ ocr: 'example.first/ocr', translator: 'example.second/translator' }),
      );
      const selection = { ...readAssistancePreferences(), [field]: '' };
      writePreference('assistance', JSON.stringify(selection));
      expect(readAssistancePreferences()).toEqual(selection);
    },
  );

  it.each([
    [{ ocr: 'example.first/ocr' }, { ocr: 'example.first/ocr', translator: '' }],
    [
      { translator: 'example.second/translator' },
      { ocr: '', translator: 'example.second/translator' },
    ],
    [
      { ocr: false, translator: 'example.second/translator' },
      { ocr: '', translator: 'example.second/translator' },
    ],
    [
      { ocr: 'example.first/ocr', translator: 42 },
      { ocr: 'example.first/ocr', translator: '' },
    ],
    [
      { ocr: null, translator: [] },
      { ocr: '', translator: '' },
    ],
  ])('validates each provider independently: %j', (stored, expected) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored) });
    expect(readAssistancePreferences()).toEqual(expected);
  });

  it('keeps provider preferences optional when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readAssistancePreferences()).toEqual({ ocr: '', translator: '' });
    expect(() => writePreference('assistance', '{"ocr":"example.first/ocr"}')).not.toThrow();
  });
});

describe('editor preferences', () => {
  it.each([null, 'not json', 'null', '[]', '42', '{"hoverPreview":"false","autoLocateMarker":1}'])(
    'uses editor defaults for missing or invalid stored values: %s',
    (stored) => {
      vi.stubGlobal('localStorage', { getItem: () => stored });
      expect(readEditorPreferences()).toEqual({ hoverPreview: true, autoLocateMarker: false });
    },
  );

  it('reads independent boolean choices and writes with the application namespace', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    writePreference('editor', JSON.stringify({ hoverPreview: false, autoLocateMarker: true }));
    expect(values.has('bubblefish-next.editor')).toBe(true);
    expect(readEditorPreferences()).toEqual({ hoverPreview: false, autoLocateMarker: true });
    values.set('bubblefish-next.editor', '{"hoverPreview":false}');
    expect(readEditorPreferences()).toEqual({ hoverPreview: false, autoLocateMarker: false });
  });

  it('keeps settings optional when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readEditorPreferences()).toEqual({ hoverPreview: true, autoLocateMarker: false });
    expect(() => writePreference('editor', '{}')).not.toThrow();
  });
});

describe('bottom-panel layout preferences', () => {
  beforeEach(() => vi.stubGlobal('window', { innerHeight: 1000 }));

  it('restores the search sidebar while retaining the shared panel dimensions', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ sidebar: 'search', leftWidth: 310 }),
    });
    expect(readLayout()).toMatchObject({ sidebar: 'search', leftWidth: 310 });
  });

  it.each([null, 'not json', 'null', '[]', '42'])(
    'opens the built-in tools by default when layout is missing or damaged: %s',
    (stored) => {
      vi.stubGlobal('localStorage', { getItem: () => stored });
      expect(readLayout()).toMatchObject({
        bottomOpen: true,
        bottomHeight: 240,
        selectedBottomTab: ASSISTANCE_TAB_ID,
      });
    },
  );

  it('adds bottom-panel defaults without losing an older saved layout', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          leftOpen: false,
          rightOpen: false,
          sidebar: 'settings',
          leftWidth: 300,
          rightWidth: 500,
          editorHeight: 320,
        }),
    });
    expect(readLayout()).toEqual({
      leftOpen: false,
      rightOpen: false,
      sidebar: 'settings',
      leftWidth: 300,
      rightWidth: 500,
      editorHeight: 320,
      bottomOpen: true,
      bottomHeight: 240,
      selectedBottomTab: ASSISTANCE_TAB_ID,
    });
  });

  it('restores the collapsed panel, height and plugin tab independently', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    writePreference(
      'layout',
      JSON.stringify({
        bottomOpen: false,
        bottomHeight: 320,
        selectedBottomTab: 'example.tools/history',
      }),
    );
    expect(values.has('bubblefish-next.layout')).toBe(true);
    expect(readLayout()).toMatchObject({
      bottomOpen: false,
      bottomHeight: 320,
      selectedBottomTab: 'example.tools/history',
    });
  });

  it.each([
    '{"bottomOpen":"false","bottomHeight":"320","selectedBottomTab":null}',
    '{"bottomOpen":0,"bottomHeight":null,"selectedBottomTab":""}',
    '{"bottomHeight":1e999,"selectedBottomTab":42}',
  ])('rejects invalid bottom-panel field types: %s', (stored) => {
    vi.stubGlobal('localStorage', { getItem: () => stored });
    expect(readLayout()).toMatchObject({
      bottomOpen: true,
      bottomHeight: 240,
      selectedBottomTab: ASSISTANCE_TAB_ID,
    });
  });

  it.each([
    [-100, 150],
    [10000, 350],
  ])('fits stored height %s into the current window', (height, expected) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ bottomHeight: height }) });
    expect(readLayout().bottomHeight).toBe(expected);
  });

  it('fits default tools into short windows and caps the panel in large windows', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('window', { innerHeight: 400 });
    expect(readLayout().bottomHeight).toBe(140);
    expect(bottomPanelBounds(400)).toEqual({ min: 60, max: 140 });
    expect(clampBottomHeight(240, 400)).toBe(140);
    expect(clampBottomHeight(20, 1000)).toBe(150);
    expect(bottomPanelBounds(2000)).toEqual({ min: 200, max: 600 });
    expect(clampBottomHeight(1000, 2000)).toBe(600);
  });

  it('keeps bottom-panel defaults when preference storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readLayout()).toMatchObject({
      bottomOpen: true,
      bottomHeight: 240,
      selectedBottomTab: ASSISTANCE_TAB_ID,
    });
  });
});
