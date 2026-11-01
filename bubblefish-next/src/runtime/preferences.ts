export interface LayoutPreferences {
  leftOpen: boolean;
  rightOpen: boolean;
  sidebar: 'images' | 'settings';
  leftWidth: number;
  rightWidth: number;
  editorHeight: number;
}
export interface EditorPreferences {
  hoverPreview: boolean;
  autoLocateMarker: boolean;
}
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`bubblefish-next.${key}`);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(`bubblefish-next.${key}`, value);
  } catch {
    /* Preferences are optional. */
  }
}
export function readEditorPreferences(): EditorPreferences {
  const defaults: EditorPreferences = { hoverPreview: true, autoLocateMarker: false };
  try {
    const value: unknown = JSON.parse(readPreference('editor') ?? '{}');
    if (!value || typeof value !== 'object') return defaults;
    const saved = value as Partial<EditorPreferences>;
    return {
      hoverPreview:
        typeof saved.hoverPreview === 'boolean' ? saved.hoverPreview : defaults.hoverPreview,
      autoLocateMarker:
        typeof saved.autoLocateMarker === 'boolean'
          ? saved.autoLocateMarker
          : defaults.autoLocateMarker,
    };
  } catch {
    return defaults;
  }
}
export function readLayout(): LayoutPreferences {
  const defaults: LayoutPreferences = {
    leftOpen: true,
    rightOpen: true,
    sidebar: 'images',
    leftWidth: 228,
    rightWidth: 338,
    editorHeight: 260,
  };
  try {
    const value = JSON.parse(readPreference('layout') ?? '{}') as Partial<LayoutPreferences>;
    const size = (n: unknown, fallback: number, min: number, max: number) =>
      typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    return {
      ...defaults,
      leftOpen: value.leftOpen !== false,
      rightOpen: value.rightOpen !== false,
      sidebar: value.sidebar === 'settings' ? 'settings' : 'images',
      leftWidth: size(value.leftWidth, 228, 180, 420),
      rightWidth: size(value.rightWidth, 338, 270, 620),
      editorHeight: size(value.editorHeight, 260, 170, Math.max(170, window.innerHeight * 0.65)),
    };
  } catch {
    return defaults;
  }
}
