import { describe, expect, it, vi } from 'vitest';
import {
  observePanelAppearance,
  readPanelAppearance,
} from '../src/runtime/plugins/panel-appearance';
import type { PluginPanelAppearance } from '../src/generated/plugins';

function environment() {
  const values: Record<string, string> = {
    '--surface': '#fffaf4',
    '--surface2': '#fff5e9',
    '--surface3': '#ffead4',
    '--text': '#714432',
    '--strong': '#532e1e',
    '--muted': '#ac8a73',
    '--line': '#f1dfcd',
    '--accent': '#e38142',
    '--accent-soft': '#fff0e0',
    '--danger': '#d65361',
    '--control-radius': '7px',
  };
  let scheme = 'light',
    fontSize = '13px',
    fontFamily = 'Inter, system-ui';
  let notify!: () => void;
  const disconnect = vi.fn(),
    observe = vi.fn();
  class Observer {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe = observe;
    disconnect = disconnect;
  }
  const events = new Map<string, () => void>(),
    mediaEvents = new Map<string, () => void>();
  const media = {
    // An opposite OS preference must not determine a panel's appearance.
    matches: true,
    addEventListener: (name: string, callback: () => void) => mediaEvents.set(name, callback),
    removeEventListener: (name: string) => mediaEvents.delete(name),
  };
  const body = {};
  const document = {
    body,
    defaultView: {
      getComputedStyle: (node: unknown) =>
        node === body
          ? { fontSize, fontFamily }
          : {
              getPropertyValue: (name: string) => values[name] ?? '',
              colorScheme: scheme,
              fontFamily,
            },
      MutationObserver: Observer,
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
      removeEventListener: (name: string) => events.delete(name),
      matchMedia: () => media,
    },
  };
  const root = { ownerDocument: document, dataset: { theme: 'fruit' } } as unknown as HTMLElement;
  return {
    root,
    values,
    observe,
    disconnect,
    events,
    mediaEvents,
    notify: () => notify(),
    setScheme: (value: string) => {
      scheme = value;
    },
    setFont: (size: string, family: string) => {
      fontSize = size;
      fontFamily = family;
    },
  };
}

describe('host panel appearance snapshots', () => {
  it('uses the real host cascade and body typography rather than OS preference or a second palette', () => {
    const env = environment();
    const appearance = readPanelAppearance(4, env.root);
    expect(appearance).toMatchObject({
      revision: 4,
      theme: 'fruit',
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
        radius: '7px',
      },
    });
    env.values['--surface'] = '#123456';
    env.setFont('15px', 'Custom Family');
    expect(readPanelAppearance(5, env.root).tokens).toMatchObject({
      background: '#123456',
      fontSize: '15px',
      fontFamily: 'Custom Family',
    });
  });
  it('follows an explicitly dark host and supplies complete fallbacks', () => {
    const env = environment();
    env.root.dataset.theme = 'dark';
    env.setScheme('dark');
    delete env.values['--surface'];
    delete env.values['--control-radius'];
    expect(readPanelAppearance(1, env.root)).toMatchObject({
      colorScheme: 'dark',
      tokens: { background: '#fff', radius: '6px' },
    });
    env.root.dataset.theme = '';
    env.setScheme('light');
    expect(readPanelAppearance(2, env.root).theme).toBe('ocean');
  });
  it('publishes only changed snapshots with monotonic revisions', () => {
    const env = environment();
    const received: PluginPanelAppearance[] = [];
    const dispose = observePanelAppearance((appearance) => received.push(appearance), env.root);
    expect(received.map((item) => item.revision)).toEqual([1]);
    expect(env.observe).toHaveBeenCalledTimes(2);
    env.notify();
    env.mediaEvents.get('change')?.();
    expect(received).toHaveLength(1);
    env.root.dataset.theme = 'dark';
    env.setScheme('dark');
    env.values['--surface'] = '#1d2635';
    env.notify();
    env.setFont('16px', 'New Family');
    env.events.get('resize')?.();
    expect(received.map((item) => item.revision)).toEqual([1, 2, 3]);
    expect(received[2]).toMatchObject({
      theme: 'dark',
      colorScheme: 'dark',
      tokens: { background: '#1d2635', fontSize: '16px' },
    });
    dispose();
  });
  it('removes listeners and ignores already queued callbacks on panel close', () => {
    const env = environment(),
      callback = vi.fn();
    const dispose = observePanelAppearance(callback, env.root);
    const queuedResize = env.events.get('resize')!;
    dispose();
    env.root.dataset.theme = 'dark';
    env.notify();
    queuedResize();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(env.disconnect).toHaveBeenCalledTimes(1);
    expect(env.events.size).toBe(0);
    expect(env.mediaEvents.size).toBe(0);
  });
});
