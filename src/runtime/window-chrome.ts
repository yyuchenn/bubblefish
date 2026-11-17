import type { WindowChromeState } from './platform';

interface WindowChromePort {
  windowInfo(): Promise<WindowChromeState | null>;
  listenWindowState(handler: (state: WindowChromeState) => void): Promise<() => void>;
}

/** Subscribe before querying so a delayed initial reply cannot replace a newer OS event. */
export function observeWindowChrome(
  port: WindowChromePort,
  initial: WindowChromeState | null,
  onchange: (state: WindowChromeState) => void,
  onerror: (error: unknown) => void,
): () => void {
  let disposed = false;
  let revision = initial?.revision ?? -1;
  let unlisten: (() => void) | undefined;
  const accept = (state: WindowChromeState | null) => {
    if (disposed || !state || state.revision <= revision) return;
    revision = state.revision;
    onchange(state);
  };
  void (async () => {
    try {
      const stop = await port.listenWindowState(accept);
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      accept(await port.windowInfo());
    } catch (error) {
      unlisten?.();
      unlisten = undefined;
      if (!disposed) onerror(error);
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
