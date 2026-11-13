import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { injectPanelTheme, PANEL_THEME_MARKER } from '../src/runtime/plugins/panel-theme-html';
import type { PluginPanelAppearance } from '../src/generated/plugins';

const bootstrap = readFileSync('src/runtime/plugins/panel-theme-bootstrap.js', 'utf8');
const appearance = (revision = 1, theme = 'fruit'): PluginPanelAppearance => ({
  revision,
  theme,
  colorScheme: 'light',
  tokens: {
    background: '#fffaf4',
    surface: '#fff5e9',
    surfaceHover: '#ffead4',
    text: '#714432',
    strong: '#532e1e',
    muted: '#ac8a73',
    border: '#f1dfcd',
    accent: '#e38142',
    accentSoft: '#fff0e0',
    danger: '#d65361',
    fontFamily: 'Inter, system-ui',
    fontSize: '13px',
    radius: '6px',
  },
});

function bridge() {
  const parent = {};
  const listeners = new Map<string, (event: unknown) => void>();
  const properties = new Map<string, { value: string; priority?: string }>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty(name: string, value: string, priority?: string) {
        properties.set(name, { value, priority });
      },
    },
  };
  const sent: unknown[] = [];
  const api = {
    close() {
      throw new Error('API port must not be touched');
    },
  };
  const theme = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage(value: unknown) {
      sent.push(value);
    },
    start() {},
    close() {},
  };
  vm.runInNewContext(bootstrap, {
    document: { documentElement: root },
    window: {
      parent,
      addEventListener(name: string, listener: (event: unknown) => void) {
        listeners.set(name, listener);
      },
    },
  });
  const connect = (value: unknown, source = parent) =>
    listeners.get('message')!({
      source,
      data: { type: 'bubblefish:connect', apiVersion: 1, appearance: value },
      ports: [api, theme],
    });
  return { root, sent, theme, properties, connect };
}

describe('panel theme decoration', () => {
  it('preserves the actual head, doctype and plugin content while installing before plugin scripts', () => {
    const source =
      '<!DoCtYpE html><HTML lang="zh-CN"><!-- <head> fake --><HEAD data-note="a > b"><script>window.legacy=true</script></HEAD><body style="margin:24px"><p>原文</p></body></HTML>';
    const result = injectPanelTheme(source);
    expect(
      result.startsWith(
        '<!DoCtYpE html><HTML lang="zh-CN"><!-- <head> fake --><HEAD data-note="a > b">',
      ),
    ).toBe(true);
    expect(result.indexOf(PANEL_THEME_MARKER)).toBeLessThan(result.indexOf('window.legacy=true'));
    expect(result).toContain('<body style="margin:24px"><p>原文</p></body>');
    expect(injectPanelTheme(result)).toBe(result);
  });
  it.each([
    '<p>Settings</p>',
    '\uFEFF<!doctype html><body><p>设置</p></body>',
    '<script>const text="<head>";</script><p>状态</p>',
    '<!-- <head> --><p>设置</p>',
  ])('supports legacy fragments without mistaking plugin text for a head: %s', (source) => {
    const result = injectPanelTheme(source);
    expect(result.indexOf(PANEL_THEME_MARKER)).toBeLessThan(result.indexOf('<p>'));
    expect(result.split(PANEL_THEME_MARKER)).toHaveLength(2);
    expect(injectPanelTheme(result)).toBe(result);
  });
  it('ships fixed assets without embedding a theme snapshot or installation data', () => {
    const result = injectPanelTheme('<p>Settings</p>');
    expect(result).toContain('appearance-ready');
    expect(result).toContain('--bf-panel-background');
    expect(result).toContain('event.ports[1]');
    expect(result).not.toContain('#fffaf4');
  });
});

describe('SDK-independent appearance bridge', () => {
  it('only accepts the parent connection and leaves API port zero untouched', () => {
    const host = bridge();
    host.connect(appearance(), {});
    expect(host.sent).toEqual([]);
    expect(host.properties.size).toBe(0);
    host.connect(appearance());
    expect(host.sent).toEqual([{ type: 'appearance-ready', revision: 1 }]);
    expect(host.root.dataset.bfTheme).toBe('fruit');
    expect(host.properties.get('color-scheme')).toEqual({ value: 'light', priority: 'important' });
    expect(host.properties.get('--bf-panel-font-size')?.value).toBe('13px');
  });
  it('applies live updates in place and ignores old revisions', () => {
    const host = bridge();
    host.connect(appearance());
    host.theme.onmessage!({
      data: { type: 'appearance', appearance: { ...appearance(3, 'dark'), colorScheme: 'dark' } },
    });
    host.theme.onmessage!({ data: { type: 'appearance', appearance: appearance(2, 'ocean') } });
    expect(host.root.dataset.bfTheme).toBe('dark');
    expect(host.properties.get('color-scheme')?.value).toBe('dark');
    expect(host.sent.at(-1)).toEqual({ type: 'appearance-ready', revision: 3 });
  });
  it('validates required tokens and applies only the fixed property whitelist', () => {
    const host = bridge();
    host.connect({ ...appearance(), colorScheme: 'light dark' });
    host.connect({ ...appearance(), revision: -1 });
    host.connect({ ...appearance(), tokens: {} });
    expect(host.sent).toEqual([]);
    const data = appearance();
    host.connect({ ...data, tokens: { ...data.tokens, hostile: 'url(https://example.test)' } });
    expect(host.properties.has('hostile')).toBe(false);
    expect(host.properties.size).toBe(14);
    host.theme.onmessage!({
      data: {
        type: 'appearance',
        appearance: { ...appearance(2), tokens: { ...data.tokens, text: null } },
      },
    });
    expect(host.sent).toEqual([{ type: 'appearance-ready', revision: 1 }]);
  });
});
