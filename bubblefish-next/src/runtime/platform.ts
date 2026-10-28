/** Native paths are lazy: choosing a 300-page directory does not load 300 images. */
export interface PickedFile {
  name: string;
  path?: string;
  file?: File;
}
export interface LoadedFile extends PickedFile {
  file: File;
}
export interface SaveOptions {
  suggestedName: string;
  path?: string;
  saveAs?: boolean;
  format: 'bf' | 'labelplus';
}
export interface SaveResult {
  path?: string;
  cancelled: boolean;
}
export type CloseChoice = 'save' | 'discard' | 'cancel';
export interface WindowChromeState {
  platform: 'windows' | 'macos' | 'linux';
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
  revision: number;
}
export interface NativeMenuState {
  enabled: boolean;
  hasProject: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  recentFiles: string[];
  leftOpen: boolean;
  rightOpen: boolean;
}

async function native() {
  return import('@tauri-apps/api/core');
}
function basename(path: string) {
  return path.split(/[/\\]/).pop() || path;
}
function mime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
      } as Record<string, string>
    )[ext || ''] || 'application/octet-stream'
  );
}
function choose(accept: string, multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Array.from(input.files || [], (file) => ({ name: file.name, file })));
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    input.click();
  });
}
async function picked(kind: 'images' | 'project'): Promise<PickedFile[]> {
  if (!__DESKTOP__)
    return choose(
      kind === 'images' ? '.png,.jpg,.jpeg,.gif,.webp,.bmp' : '.bf,.txt,.lp',
      kind === 'images',
    );
  const { invoke } = await native();
  const paths = await invoke<string[]>('platform_pick', { kind });
  return paths.map((path) => ({ path, name: basename(path) }));
}
async function listen<T>(event: string, handler: (value: T) => void) {
  if (!__DESKTOP__) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, (event) => handler(event.payload));
}

export const platform = {
  desktop: __DESKTOP__,
  async windowInfo(): Promise<WindowChromeState | null> {
    return __DESKTOP__ ? (await native()).invoke<WindowChromeState>('platform_window_info') : null;
  },
  async listenWindowState(handler: (state: WindowChromeState) => void): Promise<() => void> {
    return listen<WindowChromeState>('bf://window-state', handler);
  },
  async minimizeWindow(): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_window_minimize');
  },
  async toggleMaximizeWindow(): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_window_toggle_maximize');
  },
  async setWindowTitle(title: string): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_window_set_title', { title });
  },
  async pickImages(): Promise<PickedFile[]> {
    return picked('images');
  },
  async pickProject(): Promise<PickedFile | null> {
    return (await picked('project'))[0] || null;
  },
  async readFile(path: string): Promise<LoadedFile> {
    if (!__DESKTOP__) throw new Error('File paths are available in the desktop app');
    const { invoke } = await native();
    const bytes = await invoke<ArrayBuffer>('platform_read', { path });
    const name = basename(path);
    return { path, name, file: new File([bytes], name, { type: mime(name) }) };
  },
  async scanImages(projectPath: string): Promise<PickedFile[]> {
    if (!__DESKTOP__) return [];
    const { invoke } = await native();
    const paths = await invoke<string[]>('platform_scan_images', { projectPath });
    return paths.map((path) => ({ path, name: basename(path) }));
  },
  async imageUrl(path: string): Promise<string> {
    if (!__DESKTOP__) throw new Error('Use URL.createObjectURL for browser files');
    const { invoke, convertFileSrc } = await native();
    await invoke('platform_allow_image', { path });
    return convertFileSrc(path);
  },
  async save(bytes: Uint8Array, options: SaveOptions): Promise<SaveResult> {
    if (__DESKTOP__) {
      const { invoke } = await native();
      return invoke<SaveResult>('platform_save', bytes, {
        headers: { 'x-bf-options': encodeURIComponent(JSON.stringify(options)) },
      });
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], {
        type: options.format === 'bf' ? 'application/x-bubblefish' : 'text/plain;charset=utf-8',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = options.suggestedName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { cancelled: false };
  },
  async recentFiles(): Promise<string[]> {
    return __DESKTOP__ ? (await native()).invoke('platform_recent') : [];
  },
  async rememberFile(path: string): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_remember', { path });
  },
  async listenActions(handler: (action: string) => void): Promise<() => void> {
    return listen<string>('bf://action', handler);
  },
  async syncMenu(menu: NativeMenuState): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_sync_menu', { menu });
  },
  async listenOpen(handler: (paths: string[]) => void): Promise<() => void> {
    if (!__DESKTOP__) return () => {};
    const drain = async () => {
      const paths = await (await native()).invoke<string[]>('platform_take_open');
      if (paths.length) handler(paths);
    };
    const unlisten = await listen<void>('bf://open', () => {
      void drain();
    });
    const pending = await (await native()).invoke<string[]>('platform_take_open');
    if (pending.length) handler(pending);
    return unlisten;
  },
  async listenClose(handler: () => Promise<void>): Promise<() => void> {
    return listen<void>('bf://close-requested', () => {
      void handler();
    });
  },
  async confirmClose(name: string): Promise<CloseChoice> {
    if (__DESKTOP__)
      return (await native()).invoke<CloseChoice>('platform_confirm_close', { name });
    if (window.confirm(`“${name}”尚未保存。是否保存后关闭？`)) return 'save';
    return window.confirm('放弃尚未保存的修改并关闭？') ? 'discard' : 'cancel';
  },
  async closeWindow(): Promise<void> {
    if (__DESKTOP__) await (await native()).invoke('platform_close');
  },
};
