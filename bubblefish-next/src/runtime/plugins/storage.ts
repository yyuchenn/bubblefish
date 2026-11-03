import { defaultConfig, resourcePath } from './package';
import type { InstalledPlugin, PluginFiles, PluginStorage, JsonValue } from './types';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bubblefish-next-plugins', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('plugins', { keyPath: 'manifest.id' });
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Plugin storage transaction aborted'));
  });
}
export class BrowserPluginStorage implements PluginStorage {
  async list() {
    const database = await db();
    try {
      return (await result(
        database.transaction('plugins').objectStore('plugins').getAll(),
      )) as InstalledPlugin[];
    } finally {
      database.close();
    }
  }
  async install(pkg: PluginFiles) {
    const database = await db();
    try {
      const transaction = database.transaction(['plugins', 'files'], 'readwrite');
      const done = complete(transaction);
      const installed: InstalledPlugin = {
        manifest: pkg.manifest,
        enabled: false,
        config: defaultConfig(pkg.manifest),
      };
      transaction.objectStore('plugins').add(installed);
      for (const [path, bytes] of pkg.files)
        transaction
          .objectStore('files')
          .put(new Blob([new Uint8Array(bytes)]), [pkg.manifest.id, path]);
      await done;
      return installed;
    } finally {
      database.close();
    }
  }
  async remove(pluginId: string) {
    const database = await db();
    try {
      const transaction = database.transaction(['plugins', 'files'], 'readwrite');
      const done = complete(transaction);
      transaction.objectStore('plugins').delete(pluginId);
      const cursor = transaction
        .objectStore('files')
        .openCursor(IDBKeyRange.bound([pluginId, ''], [pluginId, '\uffff']));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) {
          entry.delete();
          entry.continue();
        }
      };
      await done;
    } finally {
      database.close();
    }
  }
  async read(pluginId: string, path: string): Promise<ArrayBuffer> {
    resourcePath(path);
    const database = await db();
    try {
      const blob = (await result(
        database.transaction('files').objectStore('files').get([pluginId, path]),
      )) as Blob | undefined;
      if (!blob) throw new Error(`Plugin resource not found: ${path}`);
      return await blob.arrayBuffer();
    } finally {
      database.close();
    }
  }
  async update(pluginId: string, patch: { enabled?: boolean; config?: Record<string, JsonValue> }) {
    const database = await db();
    try {
      const transaction = database.transaction('plugins', 'readwrite');
      const done = complete(transaction);
      const store = transaction.objectStore('plugins');
      const request = store.get(pluginId);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, ...patch });
        else transaction.abort();
      };
      await done;
    } finally {
      database.close();
    }
  }
}
export class NativePluginStorage implements PluginStorage {
  private async invoke<T>(
    command: string,
    args?: Record<string, unknown> | ArrayBuffer,
    headers?: Record<string, string>,
  ): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args, headers ? { headers } : undefined);
  }
  list() {
    return this.invoke<InstalledPlugin[]>('plugin_list');
  }
  async install(pkg: PluginFiles) {
    const { token } = await this.invoke<{ token: string }>('plugin_install_begin', {
      manifest: pkg.manifest,
    });
    try {
      for (const [path, data] of pkg.files)
        await this.invoke('plugin_install_file', new Uint8Array(data).buffer, {
          'x-bf-options': encodeURIComponent(JSON.stringify({ token, path })),
        });
      const installed = await this.invoke<InstalledPlugin>('plugin_install_commit', { token });
      return installed;
    } catch (error) {
      await this.invoke('plugin_install_abort', { token }).catch(() => {});
      throw error;
    }
  }
  async remove(pluginId: string) {
    await this.invoke('plugin_remove', { pluginId });
  }
  read(pluginId: string, path: string) {
    resourcePath(path);
    return this.invoke<ArrayBuffer>('plugin_read_file', { pluginId, path });
  }
  async update(pluginId: string, patch: { enabled?: boolean; config?: Record<string, JsonValue> }) {
    await this.invoke('plugin_set_state', { pluginId, ...patch });
  }
}
