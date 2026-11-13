import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SoftwareUpdater,
  UPDATE_INTERVAL,
  type UpdateSettings,
  type UpdaterSnapshot,
  type UpdaterTransport,
} from '../src/runtime/updater';

const release = { id: 'release-041', version: '0.4.1', source: 'github' as const };
const snapshot = (patch: Partial<UpdaterSnapshot> = {}): UpdaterSnapshot => ({
  revision: 0,
  phase: 'idle',
  currentVersion: '0.4.0',
  supported: true,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let values: Map<string, string>;
let updaters: SoftwareUpdater[];
function create(saved?: Partial<UpdateSettings>, desktop = true) {
  if (saved) values.set('bubblefish.updater', JSON.stringify(saved));
  let receive: ((value: UpdaterSnapshot) => void) | undefined;
  const stop = vi.fn();
  const transport: UpdaterTransport = {
    state: vi.fn(async () => snapshot()),
    check: vi.fn(async () => snapshot()),
    download: vi.fn(async () => snapshot({ phase: 'ready', release, ready: release })),
    listen: vi.fn(async (handler) => {
      receive = handler;
      return stop;
    }),
    finishExit: vi.fn(async () => {}),
  };
  const updater = new SoftwareUpdater({ desktop, transport });
  updaters.push(updater);
  return { updater, transport, emit: (value: UpdaterSnapshot) => receive?.(value), stop };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  values = new Map();
  updaters = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => {
  updaters.forEach((updater) => updater.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('software updater', () => {
  it('defaults to independent automatic checking, downloading and install-on-exit', async () => {
    const { updater, transport } = create();
    vi.mocked(transport.check).mockResolvedValue(snapshot({ phase: 'available', release }));
    await updater.initialize();
    expect(updater.value.settings).toMatchObject({
      autoCheck: true,
      autoDownload: true,
      installOnExit: true,
      source: 'gitee',
    });
    expect(transport.check).toHaveBeenCalledWith('gitee');
    expect(transport.download).toHaveBeenCalledWith(release.id);
    expect(updater.value.ready?.version).toBe('0.4.1');
    expect(transport.finishExit).not.toHaveBeenCalled();
  });

  it('respects the persisted 24-hour interval but manual checks bypass it', async () => {
    const lastChecked = new Date(Date.now() - UPDATE_INTERVAL + 1000).toISOString();
    const { updater, transport } = create({ autoCheck: true, autoDownload: false, lastChecked });
    await updater.initialize();
    expect(transport.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.check).toHaveBeenCalledTimes(1);
    await updater.check();
    expect(transport.check).toHaveBeenCalledTimes(2);
    expect(JSON.parse(values.get('bubblefish.updater')!).lastChecked).toBe(
      new Date().toISOString(),
    );
  });

  it('keeps manual checking and auto-download independent of automatic checking', async () => {
    const { updater, transport } = create({
      autoCheck: false,
      autoDownload: true,
      installOnExit: false,
    });
    vi.mocked(transport.check).mockResolvedValue(snapshot({ phase: 'available', release }));
    await updater.initialize();
    expect(transport.check).not.toHaveBeenCalled();
    await updater.check();
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(updater.value.settings).toMatchObject({
      autoCheck: false,
      autoDownload: true,
      installOnExit: false,
    });
    await updater.finishExit('quit');
    expect(transport.finishExit).toHaveBeenCalledWith({
      mode: 'quit',
      skipUpdate: false,
      installOnExit: false,
    });
  });

  it('shares concurrent checks and downloads and reports unknown-size progress without inventing a total', async () => {
    const { updater, transport, emit } = create({ autoCheck: false, autoDownload: false });
    await updater.initialize();
    const checked = deferred<UpdaterSnapshot>();
    vi.mocked(transport.check).mockReturnValue(checked.promise);
    const first = updater.check();
    const second = updater.check();
    expect(second).toBe(first);
    checked.resolve(snapshot({ phase: 'available', release }));
    await first;
    const downloaded = deferred<UpdaterSnapshot>();
    vi.mocked(transport.download).mockReturnValue(downloaded.promise);
    const third = updater.download();
    expect(updater.download()).toBe(third);
    emit(snapshot({ phase: 'downloading', release, progress: { downloaded: 8192 } }));
    expect(updater.value.progress).toEqual({ downloaded: 8192 });
    downloaded.resolve(snapshot({ phase: 'ready', release, ready: release }));
    await third;
    expect(transport.check).toHaveBeenCalledTimes(1);
    expect(transport.download).toHaveBeenCalledTimes(1);
  });

  it('preserves the real version and staged release when a check fails, without a hot retry loop', async () => {
    const { updater, transport } = create();
    vi.mocked(transport.state).mockResolvedValue(snapshot({ phase: 'ready', ready: release }));
    vi.mocked(transport.check).mockRejectedValue(new Error('offline'));
    await updater.initialize();
    expect(updater.value).toMatchObject({
      phase: 'error',
      currentVersion: '0.4.0',
      ready: release,
      error: 'offline',
    });
    expect(values.has('bubblefish.updater')).toBe(false);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL - 1);
    expect(transport.check).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer native event ahead of a delayed startup state query', async () => {
    const { updater, transport, emit } = create({ autoCheck: false });
    const initial = deferred<UpdaterSnapshot>();
    vi.mocked(transport.state).mockReturnValue(initial.promise);
    const started = updater.initialize();
    await Promise.resolve();
    emit(snapshot({ phase: 'ready', ready: release }));
    initial.resolve(snapshot());
    await started;
    expect(updater.value.ready).toEqual(release);
  });

  it('keeps a newer ready event when the initial state RPC rejects late', async () => {
    const { updater, transport, emit } = create({ autoCheck: false });
    const initial = deferred<UpdaterSnapshot>();
    vi.mocked(transport.state).mockReturnValue(initial.promise);
    const started = updater.initialize();
    await Promise.resolve();
    expect(transport.state).toHaveBeenCalledOnce();
    emit(snapshot({ revision: 4, phase: 'ready', ready: release }));
    initial.reject(new Error('outdated initial state failure'));
    await started;
    expect(updater.value).toMatchObject({
      revision: 4,
      phase: 'ready',
      ready: release,
      initialized: true,
    });
    expect(updater.value.error).toBeUndefined();
  });

  it('cannot regress active download progress when an earlier check reply arrives late', async () => {
    const { updater, transport, emit } = create({ autoCheck: false, autoDownload: false });
    await updater.initialize();
    const checked = deferred<UpdaterSnapshot>();
    const downloaded = deferred<UpdaterSnapshot>();
    vi.mocked(transport.check).mockReturnValue(checked.promise);
    vi.mocked(transport.download).mockReturnValue(downloaded.promise);
    const checking = updater.check();
    emit(snapshot({ phase: 'available', release }));
    const downloading = updater.download();
    emit(snapshot({ phase: 'downloading', release, progress: { downloaded: 8192 } }));
    checked.resolve(snapshot({ phase: 'available', release }));
    await checking;
    expect(updater.value).toMatchObject({ phase: 'downloading', progress: { downloaded: 8192 } });
    emit(snapshot({ phase: 'ready', release, ready: release }));
    downloaded.resolve(snapshot({ phase: 'ready', release, ready: release }));
    await downloading;
    expect(updater.value.phase).toBe('ready');
  });

  it('ignores out-of-order native events after a newer verified state', async () => {
    const { updater, emit } = create({ autoCheck: false });
    await updater.initialize();
    emit(snapshot({ revision: 3, phase: 'downloading', release, progress: { downloaded: 8192 } }));
    emit(snapshot({ revision: 4, phase: 'ready', release, ready: release }));
    emit(snapshot({ revision: 3, phase: 'downloading', release, progress: { downloaded: 4096 } }));
    expect(updater.value).toMatchObject({ revision: 4, phase: 'ready', ready: release });
    expect(updater.value.progress).toBeUndefined();
  });

  it.each(['check', 'download'] as const)(
    'ignores a late rejected %s RPC after a newer verified event',
    async (method) => {
      const { updater, transport, emit } = create({ autoCheck: false, autoDownload: false });
      await updater.initialize();
      if (method === 'download') {
        vi.mocked(transport.check).mockResolvedValue(
          snapshot({ revision: 1, phase: 'available', release }),
        );
        await updater.check();
      }
      const pending = deferred<UpdaterSnapshot>();
      vi.mocked(transport[method]).mockReturnValue(pending.promise);
      const running = method === 'check' ? updater.check() : updater.download();
      emit(snapshot({ revision: 4, phase: 'ready', release, ready: release }));
      pending.reject(new Error('outdated RPC failure'));
      await running;
      expect(updater.value).toMatchObject({ revision: 4, phase: 'ready', ready: release });
      expect(updater.value.error).toBeUndefined();
    },
  );

  it('does not persist a late successful check after disposal', async () => {
    const { updater, transport } = create({ autoCheck: false, autoDownload: false });
    await updater.initialize();
    const before = values.get('bubblefish.updater');
    const checked = deferred<UpdaterSnapshot>();
    vi.mocked(transport.check).mockReturnValue(checked.promise);
    const checking = updater.check();
    updater.dispose();
    checked.resolve(snapshot({ lastChecked: new Date().toISOString() }));
    await checking;
    expect(values.get('bubblefish.updater')).toBe(before);
  });

  it('retains the preferred source while displaying the actual fallback source', async () => {
    const { updater, transport } = create({
      autoCheck: false,
      autoDownload: false,
      source: 'gitee',
    });
    vi.mocked(transport.check).mockResolvedValue(snapshot({ phase: 'available', release }));
    await updater.initialize();
    await updater.check();
    expect(updater.value.settings.source).toBe('gitee');
    expect(updater.value.release?.source).toBe('github');
  });

  it('checks unsupported development builds without automatically downloading installers', async () => {
    const { updater, transport } = create();
    vi.mocked(transport.check).mockResolvedValue(
      snapshot({ phase: 'available', release, supported: false, unsupportedReason: 'debug build' }),
    );
    await updater.initialize();
    expect(transport.check).toHaveBeenCalledTimes(1);
    expect(transport.download).not.toHaveBeenCalled();
  });

  it('preserves an earlier verified update when downloading its replacement fails', async () => {
    const newer = { ...release, id: 'release-042', version: '0.4.2' };
    const { updater, transport } = create({ autoCheck: false, autoDownload: false });
    vi.mocked(transport.state).mockResolvedValue(snapshot({ phase: 'ready', ready: release }));
    vi.mocked(transport.check).mockResolvedValue(
      snapshot({ phase: 'available', ready: release, release: newer }),
    );
    vi.mocked(transport.download).mockRejectedValue(new Error('replacement failed'));
    await updater.initialize();
    await updater.check();
    await updater.download();
    expect(updater.value).toMatchObject({ phase: 'error', release: newer, ready: release });
    expect(transport.download).toHaveBeenCalledWith(newer.id);
  });

  it('never invokes native services or starts a check timer in the browser', async () => {
    const { updater, transport } = create(undefined, false);
    await updater.initialize();
    await updater.check();
    await updater.download();
    await expect(updater.finishExit('quit')).rejects.toThrow('桌面应用');
    updater.updateSettings({ source: 'github' });
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL * 2);
    for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
  });

  it('disposes its listener and scheduled work', async () => {
    const { updater, transport, emit, stop } = create({ autoCheck: false });
    await updater.initialize();
    updater.updateSettings({ autoCheck: true });
    updater.dispose();
    emit(snapshot({ phase: 'ready', ready: release }));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL * 2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(transport.check).not.toHaveBeenCalled();
    expect(updater.value.ready).toBeUndefined();
  });
});
