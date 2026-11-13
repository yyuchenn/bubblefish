export interface LayoutPreferences {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  bottomHeight: number;
  selectedBottomTab: string;
  sidebar: 'images' | 'settings' | 'search';
  leftWidth: number;
  rightWidth: number;
  editorHeight: number;
}
export const ASSISTANCE_TAB_ID = 'builtin:assistance';
export function bottomPanelBounds(viewportHeight: number) {
  return {
    min: Math.min(200, Math.floor(viewportHeight * 0.15)),
    max: Math.min(600, Math.floor(viewportHeight * 0.35)),
  };
}
export function clampBottomHeight(height: number, viewportHeight: number) {
  const { min, max } = bottomPanelBounds(viewportHeight);
  return Math.max(min, Math.min(max, height));
}
export interface EditorPreferences {
  hoverPreview: boolean;
  autoLocateMarker: boolean;
}
export interface AssistancePreferences {
  ocr: string;
  translator: string;
}
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`bubblefish.${key}`);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(`bubblefish.${key}`, value);
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
export function readAssistancePreferences(): AssistancePreferences {
  const defaults: AssistancePreferences = { ocr: '', translator: '' };
  try {
    const value: unknown = JSON.parse(readPreference('assistance') ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    const saved = value as Partial<AssistancePreferences>;
    return {
      ocr: typeof saved.ocr === 'string' ? saved.ocr : defaults.ocr,
      translator: typeof saved.translator === 'string' ? saved.translator : defaults.translator,
    };
  } catch {
    return defaults;
  }
}
export function readLayout(): LayoutPreferences {
  const defaults: LayoutPreferences = {
    leftOpen: true,
    rightOpen: true,
    bottomOpen: true,
    bottomHeight: clampBottomHeight(240, window.innerHeight),
    selectedBottomTab: ASSISTANCE_TAB_ID,
    sidebar: 'images',
    leftWidth: 228,
    rightWidth: 338,
    editorHeight: 260,
  };
  try {
    const parsed: unknown = JSON.parse(readPreference('layout') ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const value = parsed as Partial<LayoutPreferences>;
    const size = (n: unknown, fallback: number, min: number, max: number) =>
      typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    return {
      ...defaults,
      leftOpen: value.leftOpen !== false,
      rightOpen: value.rightOpen !== false,
      bottomOpen: typeof value.bottomOpen === 'boolean' ? value.bottomOpen : defaults.bottomOpen,
      bottomHeight: clampBottomHeight(
        typeof value.bottomHeight === 'number' && Number.isFinite(value.bottomHeight)
          ? value.bottomHeight
          : 240,
        window.innerHeight,
      ),
      selectedBottomTab:
        typeof value.selectedBottomTab === 'string' && value.selectedBottomTab.length > 0
          ? value.selectedBottomTab
          : ASSISTANCE_TAB_ID,
      sidebar:
        value.sidebar === 'settings' || value.sidebar === 'search' ? value.sidebar : 'images',
      leftWidth: size(value.leftWidth, 228, 180, 420),
      rightWidth: size(value.rightWidth, 338, 270, 620),
      editorHeight: size(value.editorHeight, 260, 170, Math.max(170, window.innerHeight * 0.65)),
    };
  } catch {
    return defaults;
  }
}
