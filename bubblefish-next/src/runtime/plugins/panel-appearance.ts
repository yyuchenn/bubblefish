import type { PluginPanelAppearance } from '../../generated/plugins';

/** Resolve the application's actual cascade instead of maintaining a second palette. */
export function readPanelAppearance(
  revision: number,
  root: HTMLElement = document.documentElement,
): PluginPanelAppearance {
  const view = root.ownerDocument.defaultView;
  if (!view) throw new Error('Cannot read the application theme without a window');
  const style = view.getComputedStyle(root);
  const body = view.getComputedStyle(root.ownerDocument.body ?? root);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const theme = root.dataset.theme || 'ocean';
  const scheme = style.colorScheme.trim();
  return {
    revision,
    theme,
    colorScheme: scheme === 'dark' || (scheme !== 'light' && theme === 'dark') ? 'dark' : 'light',
    tokens: {
      background: color('--surface', '#fff'),
      surface: color('--surface2', '#f8fafc'),
      surfaceHover: color('--surface3', '#eef2f7'),
      text: color('--text', '#334155'),
      strong: color('--strong', '#172b43'),
      muted: color('--muted', '#8a98aa'),
      border: color('--line', '#e4e9f0'),
      accent: color('--accent', '#3982df'),
      accentSoft: color('--accent-soft', '#eaf3ff'),
      danger: color('--danger', '#d65361'),
      fontFamily: body.fontFamily || style.fontFamily || 'system-ui, sans-serif',
      fontSize: body.fontSize || '13px',
      radius: color('--control-radius', '6px'),
    },
  };
}

/** Emit complete, monotonically numbered snapshots without touching the frame document. */
export function observePanelAppearance(
  callback: (appearance: PluginPanelAppearance) => void,
  root: HTMLElement = document.documentElement,
) {
  const view = root.ownerDocument.defaultView;
  if (!view) throw new Error('Cannot observe the application theme without a window');
  let revision = 0,
    last = '',
    disposed = false;
  const refresh = () => {
    if (disposed) return;
    const appearance = readPanelAppearance(0, root);
    const fingerprint = JSON.stringify(appearance);
    if (fingerprint === last) return;
    last = fingerprint;
    callback({ ...appearance, revision: ++revision });
  };
  const observer = new view.MutationObserver(refresh);
  const options = { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] };
  observer.observe(root, options);
  if (root.ownerDocument.body) observer.observe(root.ownerDocument.body, options);
  view.addEventListener('resize', refresh);
  const preference = view.matchMedia('(prefers-color-scheme: dark)');
  preference.addEventListener('change', refresh);
  refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    view.removeEventListener('resize', refresh);
    preference.removeEventListener('change', refresh);
  };
}
