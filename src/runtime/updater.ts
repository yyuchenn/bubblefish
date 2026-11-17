import { get, writable } from 'svelte/store';
import { APP_VERSION } from './app-identity';
import { platform } from './platform';
import { readPreference, writePreference } from './preferences';

export type UpdateSource = 'gitee' | 'github';
export interface UpdateRelease {
  id: string;
  version: string;
  notes?: string;
  date?: string;
  source: UpdateSource;
}
export interface UpdaterSnapshot {
  revision: number;
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'installing'
    | 'error';
  currentVersion: string;
  supported: boolean;
  unsupportedReason?: string;
  release?: UpdateRelease;
  ready?: UpdateRelease;
  progress?: { downloaded: number; total?: number };
  lastChecked?: string;
  error?: string;
}
export interface UpdateSettings {
  autoCheck: boolean;
  autoDownload: boolean;
  installOnExit: boolean;
  source: UpdateSource;
  lastChecked?: string;
}
export interface UpdaterView extends UpdaterSnapshot {
  initialized: boolean;
  settings: UpdateSettings;
}
export interface FinishExitOptions {
  mode: 'quit' | 'install-restart';
  skipUpdate: boolean;
  installOnExit: boolean;
}
export interface UpdaterTransport {
  state(): Promise<UpdaterSnapshot>;
  check(source: UpdateSource): Promise<UpdaterSnapshot>;
  download(releaseId: string): Promise<UpdaterSnapshot>;
  listen(handler: (snapshot: UpdaterSnapshot) => void): Promise<() => void>;
  finishExit(options: FinishExitOptions): Promise<void>;
}
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
export const RELEASES_URL = 'https://github.com/yyuchenn/bubblefish/releases';
const defaults: UpdateSettings = {
  autoCheck: true,
  autoDownload: true,
  installOnExit: true,
  source: 'gitee',
};

function settings(): UpdateSettings {
  try {
    const value: unknown = JSON.parse(readPreference('updater') ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
    const saved = value as Partial<UpdateSettings>;
    return {
      autoCheck: typeof saved.autoCheck === 'boolean' ? saved.autoCheck : defaults.autoCheck,
      autoDownload:
        typeof saved.autoDownload === 'boolean' ? saved.autoDownload : defaults.autoDownload,
      installOnExit:
        typeof saved.installOnExit === 'boolean' ? saved.installOnExit : defaults.installOnExit,
      source: saved.source === 'github' ? 'github' : 'gitee',
      ...(typeof saved.lastChecked === 'string' && Number.isFinite(Date.parse(saved.lastChecked))
        ? { lastChecked: saved.lastChecked }
        : {}),
    };
  } catch {
    return { ...defaults };
  }
}

export function nativeUpdaterTransport(): UpdaterTransport {
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  return {
    state: () => invoke('updater_state'),
    check: (source) => invoke('updater_check', { source }),
    download: (releaseId) => invoke('updater_download', { releaseId }),
    async listen(handler) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<UpdaterSnapshot>('bf://updater-state', (event) => handler(event.payload));
    },
    finishExit: (options) => invoke('platform_finish_exit', { ...options }),
  };
}

/** The browser has no update timer or native transport calls. */
export class SoftwareUpdater {
  readonly desktop: boolean;
  private store;
  readonly subscribe;
  private transport: UpdaterTransport;
  private initialized?: Promise<void>;
  private stop?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private downloading?: Promise<void>;
  private disposed = false;
  private events = 0;
  private acceptedRevision = -1;
  private lastAttempt = 0;

  constructor(options: { desktop?: boolean; transport?: UpdaterTransport } = {}) {
    this.desktop = options.desktop ?? platform.desktop;
    this.transport = options.transport ?? nativeUpdaterTransport();
    const saved = settings();
    this.store = writable<UpdaterView>({
      revision: 0,
      phase: 'idle',
      currentVersion: APP_VERSION,
      supported: false,
      settings: saved,
      lastChecked: saved.lastChecked,
      initialized: false,
    });
    this.subscribe = this.store.subscribe;
  }
  get value() {
    return get(this.store);
  }
  private accept(snapshot: UpdaterSnapshot) {
    if (this.disposed || snapshot.revision < this.acceptedRevision) return false;
    this.acceptedRevision = snapshot.revision;
    this.store.update((value) => ({
      ...snapshot,
      settings: value.settings,
      initialized: value.initialized,
      lastChecked: snapshot.lastChecked ?? value.settings.lastChecked,
    }));
    return true;
  }
  private fail(error: unknown) {
    if (this.disposed) return;
    this.store.update((value) => ({
      ...value,
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    return (this.initialized = (async () => {
      if (this.disposed) return;
      if (!this.desktop) {
        this.store.update((value) => ({ ...value, initialized: true }));
        return;
      }
      try {
        const stop = await this.transport.listen((snapshot) => {
          if (this.accept(snapshot)) this.events++;
        });
        if (this.disposed) return stop();
        this.stop = stop;
        const events = this.events;
        const revision = this.acceptedRevision;
        try {
          const initial = await this.transport.state();
          if (events === this.events) this.accept(initial);
        } catch (error) {
          if (events === this.events && revision === this.acceptedRevision) this.fail(error);
        }
      } catch (error) {
        this.fail(error);
      }
      if (this.disposed) return;
      this.store.update((value) => ({ ...value, initialized: true }));
      const last = this.value.settings.lastChecked;
      if (
        this.value.settings.autoCheck &&
        (!last || Date.now() - Date.parse(last) >= UPDATE_INTERVAL)
      )
        await this.check();
      else this.schedule();
    })());
  }
  updateSettings(patch: Partial<Omit<UpdateSettings, 'lastChecked'>>) {
    if (this.disposed) return;
    const next = { ...this.value.settings, ...patch };
    this.store.update((value) => ({ ...value, settings: next }));
    writePreference('updater', JSON.stringify(next));
    if (this.value.initialized) this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.desktop || this.disposed || !this.value.settings.autoCheck) return;
    const last = Date.parse(this.value.settings.lastChecked ?? '') || 0;
    const delay = Math.max(0, Math.max(last, this.lastAttempt) + UPDATE_INTERVAL - Date.now());
    this.timer = setTimeout(() => void this.check(), Math.min(delay, UPDATE_INTERVAL));
  }
  /** Manual checks always bypass the automatic interval and disabled automatic checks. */
  check(): Promise<void> {
    if (!this.desktop || this.disposed) return Promise.resolve();
    if (this.checking) return this.checking;
    if (this.downloading) return this.downloading;
    this.lastAttempt = Date.now();
    this.store.update((value) => ({ ...value, phase: 'checking', error: undefined }));
    return (this.checking = (async () => {
      const events = this.events;
      const revision = this.acceptedRevision;
      try {
        const snapshot = await this.transport.check(this.value.settings.source);
        if (this.disposed) return;
        if (events === this.events) this.accept(snapshot);
        if (snapshot.phase === 'error') return;
        const lastChecked = snapshot.lastChecked ?? new Date().toISOString();
        const next = { ...this.value.settings, lastChecked };
        this.store.update((value) => ({ ...value, settings: next, lastChecked }));
        writePreference('updater', JSON.stringify(next));
        if (
          snapshot.release &&
          snapshot.release.id !== snapshot.ready?.id &&
          this.value.settings.autoDownload &&
          snapshot.supported
        )
          await this.download();
      } catch (error) {
        if (events === this.events && revision === this.acceptedRevision) this.fail(error);
      } finally {
        this.checking = undefined;
        this.schedule();
      }
    })());
  }
  download(): Promise<void> {
    if (!this.desktop || this.disposed) return Promise.resolve();
    if (!this.value.supported) return Promise.resolve();
    if (this.downloading) return this.downloading;
    const release = this.value.release;
    if (!release || this.value.ready?.id === release.id) return Promise.resolve();
    this.store.update((value) => ({
      ...value,
      phase: 'downloading',
      error: undefined,
      progress: { downloaded: 0 },
    }));
    return (this.downloading = (async () => {
      const events = this.events;
      const revision = this.acceptedRevision;
      try {
        const snapshot = await this.transport.download(release.id);
        if (!this.disposed && events === this.events) this.accept(snapshot);
      } catch (error) {
        if (events === this.events && revision === this.acceptedRevision) this.fail(error);
      } finally {
        this.downloading = undefined;
      }
    })());
  }
  finishExit(mode: FinishExitOptions['mode'], skipUpdate = false) {
    if (!this.desktop || this.disposed)
      return Promise.reject(new Error('退出与安装更新仅适用于正在运行的桌面应用'));
    return this.transport.finishExit({
      mode,
      skipUpdate,
      installOnExit: this.value.settings.installOnExit,
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.stop?.();
  }
}
