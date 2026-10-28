import { describe, expect, it, vi } from 'vitest';
import { observeWindowChrome } from '../src/runtime/window-chrome';
import type { WindowChromeState } from '../src/runtime/platform';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const state = (revision: number, maximized = false): WindowChromeState => ({
  platform: 'windows',
  maximized,
  fullscreen: false,
  focused: true,
  revision,
});
const settle = () => new Promise((done) => setTimeout(done, 0));

describe('native window state subscription', () => {
  it('subscribes before querying and discards a delayed initial reply behind a native event', async () => {
    const response = deferred<WindowChromeState>();
    let emit!: (value: WindowChromeState) => void;
    const unlisten = vi.fn(),
      changed = vi.fn(),
      failed = vi.fn();
    const order: string[] = [];
    const dispose = observeWindowChrome(
      {
        listenWindowState: async (handler) => {
          order.push('listen');
          emit = handler;
          return unlisten;
        },
        windowInfo: async () => {
          order.push('query');
          return response.promise;
        },
      },
      state(1),
      changed,
      failed,
    );
    await settle();
    expect(order).toEqual(['listen', 'query']);
    emit(state(3, true));
    response.resolve(state(2));
    await settle();
    expect(changed).toHaveBeenCalledExactlyOnceWith(state(3, true));
    emit(state(3));
    expect(changed).toHaveBeenCalledTimes(1);
    dispose();
    emit(state(4));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('releases a listener that finishes registering after the component is removed', async () => {
    const registered = deferred<() => void>();
    const unlisten = vi.fn(),
      query = vi.fn(),
      changed = vi.fn();
    const dispose = observeWindowChrome(
      { listenWindowState: () => registered.promise, windowInfo: query },
      null,
      changed,
      vi.fn(),
    );
    dispose();
    registered.resolve(unlisten);
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('reports initialization errors and releases partially initialized subscriptions', async () => {
    const unlisten = vi.fn(),
      failed = vi.fn();
    const error = new Error('window query failed');
    const dispose = observeWindowChrome(
      {
        listenWindowState: async () => unlisten,
        windowInfo: async () => {
          throw error;
        },
      },
      state(0),
      vi.fn(),
      failed,
    );
    await settle();
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(unlisten).toHaveBeenCalledTimes(1);
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
