import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEditorPreferences, writePreference } from '../src/runtime/preferences';

afterEach(() => vi.unstubAllGlobals());

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
