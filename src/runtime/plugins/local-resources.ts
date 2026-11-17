import { sha256 } from '@noble/hashes/sha256';
import type {
  PluginLocalResourceFile,
  PluginLocalResourceImport,
  PluginLocalResourceImportToken,
  PluginLocalResourceSet,
} from '../../generated/plugins';
import { resourcePath } from './package';
import { newId } from './types';

export const LOCAL_RESOURCE_CHUNK_BYTES = 4 * 1024 * 1024;
export const LOCAL_RESOURCE_MAX_BYTES = 512 * 1024 * 1024;
const IMPORT_LIFETIME = 24 * 60 * 60 * 1000;
export interface LocalResourceStorage {
  beginImport(
    pluginId: string,
    owner: string,
    input: PluginLocalResourceImport,
  ): Promise<PluginLocalResourceImportToken>;
  writeChunk(
    pluginId: string,
    owner: string,
    token: string,
    path: string,
    offset: number,
    bytes: ArrayBuffer,
  ): Promise<void>;
  commitImport(pluginId: string, owner: string, token: string): Promise<PluginLocalResourceSet>;
  abortImport(pluginId: string, owner: string, token: string): Promise<void>;
  list(pluginId: string): Promise<PluginLocalResourceSet[]>;
  read(pluginId: string, id: string, path: string): Promise<ArrayBuffer>;
  remove(pluginId: string, id: string): Promise<void>;
  removePlugin(pluginId: string): Promise<void>;
  releaseOwner(pluginId: string, owner: string): Promise<void>;
}
export interface PendingLocalResource {
  pluginId: string;
  owner: string;
  token: string;
  set: PluginLocalResourceSet;
}
/** The catalog is published only after every byte and digest has been checked. */
export interface LocalResourcePersistence {
  begin(value: PendingLocalResource): Promise<void>;
  write(token: string, path: string, offset: number, bytes: ArrayBuffer): Promise<void>;
  commit(value: PendingLocalResource, alive: () => boolean): Promise<void>;
  abort(token: string): Promise<void>;
  list(pluginId: string): Promise<PluginLocalResourceSet[]>;
  read(pluginId: string, id: string, path: string): Promise<ArrayBuffer>;
  remove(pluginId: string, id: string): Promise<void>;
  removePlugin(pluginId: string): Promise<void>;
  cleanupExpired(before: number): Promise<void>;
}
type ImportState = PendingLocalResource & {
  files: Map<
    string,
    { file: PluginLocalResourceFile; offset: number; digest: ReturnType<typeof sha256.create> }
  >;
  tail: Promise<unknown>;
  cancelled: boolean;
};
export function localResourceId(id: string) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id))
    throw new Error('Invalid local resource set ID');
  localResourcePath(id);
  return id;
}
function localResourcePath(path: string) {
  resourcePath(path);
  if (new TextEncoder().encode(path).byteLength > 1024)
    throw new Error('Local resource path is too long');
  for (const part of path.split('/')) {
    if (
      new TextEncoder().encode(part).byteLength > 255 ||
      /[<>:"|?*#%\x00-\x1f\x7f-\x9f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.')[0])
    )
      throw new Error('Local resource path is not portable across platforms');
  }
  return path;
}
export function validateLocalResourceImport(
  input: PluginLocalResourceImport,
): PluginLocalResourceImport {
  if (!input || typeof input !== 'object') throw new Error('Resource import must be an object');
  localResourceId(input.id);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100)
    throw new Error('Resource set must contain 1 to 100 files');
  let size = 0;
  const paths = new Set<string>();
  const files = input.files.map((file) => {
    if (!file || typeof file.path !== 'string') throw new Error('Invalid resource path');
    localResourcePath(file.path);
    if (paths.has(file.path.toLowerCase())) throw new Error('Duplicate resource file');
    if (
      [...paths].some(
        (other) =>
          other.startsWith(`${file.path.toLowerCase()}/`) ||
          file.path.toLowerCase().startsWith(`${other}/`),
      )
    )
      throw new Error('Resource file paths cannot be parents of other files');
    paths.add(file.path.toLowerCase());
    if (
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength <= 0 ||
      file.byteLength > LOCAL_RESOURCE_MAX_BYTES
    )
      throw new Error('Invalid resource file size');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256))
      throw new Error('Invalid resource SHA-256');
    size += file.byteLength;
    return { path: file.path, byteLength: file.byteLength, sha256: file.sha256.toLowerCase() };
  });
  if (size > LOCAL_RESOURCE_MAX_BYTES) throw new Error('Resource set exceeds 512 MiB');
  return { id: input.id, files };
}

/** Shared validation and import lifetime management, with an injectable persistence boundary. */
export class ValidatedLocalResourceStorage implements LocalResourceStorage {
  private imports = new Map<string, ImportState>();
  private revokedOwners = new Set<string>();
  private initialized?: Promise<void>;
  constructor(private persistence: LocalResourcePersistence) {}
  private initialize() {
    return (this.initialized ??= this.persistence
      .cleanupExpired(Date.now() - IMPORT_LIFETIME)
      .catch((error) => {
        this.initialized = undefined;
        throw error;
      }));
  }
  private ownerKey(pluginId: string, owner: string) {
    return `${pluginId}\0${owner}`;
  }
  async beginImport(pluginId: string, owner: string, request: PluginLocalResourceImport) {
    const input = validateLocalResourceImport(request);
    await this.initialize();
    if (this.revokedOwners.has(this.ownerKey(pluginId, owner)))
      throw new Error('Resource connection has closed');
    const token = newId();
    const entry: ImportState = {
      pluginId,
      owner,
      token,
      set: { ...input, createdAt: Date.now() },
      files: new Map(
        input.files.map((file) => [file.path, { file, offset: 0, digest: sha256.create() }]),
      ),
      tail: Promise.resolve(),
      cancelled: false,
    };
    this.imports.set(token, entry);
    try {
      await this.persistence.begin(entry);
      if (entry.cancelled || this.revokedOwners.has(this.ownerKey(pluginId, owner)))
        throw new Error('Resource connection has closed');
      return { token };
    } catch (error) {
      entry.cancelled = true;
      this.imports.delete(token);
      await this.persistence.abort(token).catch(() => {});
      throw error;
    }
  }
  private owned(pluginId: string, owner: string, token: string) {
    const entry = this.imports.get(token);
    if (!entry || entry.pluginId !== pluginId || entry.owner !== owner || entry.cancelled)
      throw new Error('Resource import token does not belong to this connection');
    return entry;
  }
  private operation<T>(entry: ImportState, job: () => Promise<T>): Promise<T> {
    const result = entry.tail
      .catch(() => {})
      .then(async () => {
        if (entry.cancelled) throw new Error('Resource import was cancelled');
        return job();
      });
    entry.tail = result;
    return result.catch(async (error) => {
      entry.cancelled = true;
      this.imports.delete(entry.token);
      await this.persistence.abort(entry.token).catch(() => {});
      throw error;
    });
  }
  writeChunk(
    pluginId: string,
    owner: string,
    token: string,
    path: string,
    offset: number,
    bytes: ArrayBuffer,
  ) {
    const entry = this.owned(pluginId, owner, token);
    return this.operation(entry, async () => {
      const item = entry.files.get(path);
      if (!item || !Number.isSafeInteger(offset) || offset !== item.offset)
        throw new Error('Resource chunks must be written at the next sequential offset');
      if (
        !(bytes instanceof ArrayBuffer) ||
        !bytes.byteLength ||
        bytes.byteLength > LOCAL_RESOURCE_CHUNK_BYTES ||
        offset + bytes.byteLength > item.file.byteLength
      )
        throw new Error('Invalid resource chunk size');
      await this.persistence.write(token, path, offset, bytes);
      if (entry.cancelled) throw new Error('Resource import was cancelled');
      item.digest.update(new Uint8Array(bytes));
      item.offset += bytes.byteLength;
    });
  }
  commitImport(pluginId: string, owner: string, token: string) {
    const entry = this.owned(pluginId, owner, token);
    return this.operation(entry, async () => {
      for (const { file, offset, digest } of entry.files.values()) {
        if (offset !== file.byteLength) throw new Error(`Incomplete resource: ${file.path}`);
        const actual = Array.from(digest.digest(), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (actual !== file.sha256) throw new Error(`Resource SHA-256 mismatch: ${file.path}`);
      }
      if (entry.cancelled) throw new Error('Resource import was cancelled');
      await this.persistence.commit(entry, () => !entry.cancelled);
      this.imports.delete(token);
      return structuredClone(entry.set);
    });
  }
  async abortImport(pluginId: string, owner: string, token: string) {
    const entry = this.imports.get(token);
    if (!entry) return;
    this.owned(pluginId, owner, token);
    entry.cancelled = true;
    this.imports.delete(token);
    await entry.tail.catch(() => {});
    await this.persistence.abort(token);
  }
  async list(pluginId: string) {
    await this.initialize();
    return this.persistence.list(pluginId);
  }
  async read(pluginId: string, id: string, path: string) {
    localResourceId(id);
    localResourcePath(path);
    await this.initialize();
    return this.persistence.read(pluginId, id, path);
  }
  async remove(pluginId: string, id: string) {
    localResourceId(id);
    await this.initialize();
    await this.persistence.remove(pluginId, id);
  }
  async removePlugin(pluginId: string) {
    for (const entry of [...this.imports.values()].filter((value) => value.pluginId === pluginId))
      await this.abortImport(pluginId, entry.owner, entry.token);
    await this.initialize();
    await this.persistence.removePlugin(pluginId);
  }
  async releaseOwner(pluginId: string, owner: string) {
    this.revokedOwners.add(this.ownerKey(pluginId, owner));
    await Promise.all(
      [...this.imports.values()]
        .filter((value) => value.pluginId === pluginId && value.owner === owner)
        .map((value) => this.abortImport(pluginId, owner, value.token)),
    );
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bubblefish-local-resources', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('imports', { keyPath: 'token' });
      request.result.createObjectStore('sets');
      request.result.createObjectStore('chunks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Local resource transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Local resource transaction aborted'));
  });
}
const chunkRange = (token: string) =>
  IDBKeyRange.bound([token, '', 0], [token, '\uffff', Number.MAX_SAFE_INTEGER]);
function deleteChunks(transaction: IDBTransaction, token: string) {
  const cursor = transaction.objectStore('chunks').openCursor(chunkRange(token));
  cursor.onsuccess = () => {
    if (cursor.result) {
      cursor.result.delete();
      cursor.result.continue();
    }
  };
}
type StoredSet = { token: string; set: PluginLocalResourceSet };
class BrowserLocalResourcePersistence implements LocalResourcePersistence {
  private async use<T>(
    stores: string[],
    mode: IDBTransactionMode,
    job: (transaction: IDBTransaction) => T | Promise<T>,
  ) {
    const db = await database();
    try {
      const tx = db.transaction(stores, mode),
        done = complete(tx);
      // A request may reject before the transaction's error callback runs.
      void done.catch(() => {});
      const result = await job(tx);
      await done;
      return result;
    } finally {
      db.close();
    }
  }
  async begin(value: PendingLocalResource) {
    await this.use(['imports'], 'readwrite', (tx) => {
      tx.objectStore('imports').add({
        token: value.token,
        pluginId: value.pluginId,
        createdAt: value.set.createdAt,
        updatedAt: Date.now(),
      });
    });
  }
  async write(token: string, path: string, offset: number, bytes: ArrayBuffer) {
    await this.use(['imports', 'chunks'], 'readwrite', (tx) => {
      const pending = tx.objectStore('imports').get(token);
      pending.onsuccess = () => {
        if (!pending.result) {
          tx.abort();
          return;
        }
        tx.objectStore('imports').put({ ...pending.result, updatedAt: Date.now() });
        tx.objectStore('chunks').add(new Blob([bytes]), [token, path, offset]);
      };
    });
  }
  async commit(value: PendingLocalResource, alive: () => boolean) {
    await this.use(['sets', 'imports', 'chunks'], 'readwrite', (tx) => {
      const store = tx.objectStore('sets'),
        previous = store.get([value.pluginId, value.set.id]),
        pending = tx.objectStore('imports').get(value.token);
      previous.onsuccess = () => {
        pending.onsuccess = () => {
          if (!alive() || !pending.result) {
            tx.abort();
            return;
          }
          const old = previous.result as StoredSet | undefined;
          if (old) deleteChunks(tx, old.token);
          store.put({ token: value.token, set: value.set }, [value.pluginId, value.set.id]);
          tx.objectStore('imports').delete(value.token);
        };
      };
    });
  }
  async abort(token: string) {
    await this.use(['imports', 'chunks'], 'readwrite', (tx) => {
      tx.objectStore('imports').delete(token);
      deleteChunks(tx, token);
    });
  }
  async list(pluginId: string) {
    return this.use(['sets'], 'readonly', async (tx) => {
      const values = (await requestResult(
        tx.objectStore('sets').getAll(IDBKeyRange.bound([pluginId, ''], [pluginId, '\uffff'])),
      )) as StoredSet[];
      return values.map((value) => value.set);
    });
  }
  async read(pluginId: string, id: string, path: string) {
    let byteLength = 0;
    const chunks = await this.use(
      ['sets', 'chunks'],
      'readonly',
      (tx) =>
        new Promise<Blob[]>((resolve, reject) => {
          const selected = tx.objectStore('sets').get([pluginId, id]);
          selected.onerror = () => reject(selected.error);
          selected.onsuccess = () => {
            const stored = selected.result as StoredSet | undefined;
            const file = stored?.set.files.find((file) => file.path === path);
            if (!stored || !file) {
              reject(new Error('Local resource file not found'));
              return;
            }
            byteLength = file.byteLength;
            const request = tx
              .objectStore('chunks')
              .getAll(
                IDBKeyRange.bound(
                  [stored.token, path, 0],
                  [stored.token, path, Number.MAX_SAFE_INTEGER],
                ),
              );
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          };
        }),
    );
    const blob = new Blob(chunks);
    if (blob.size !== byteLength)
      throw new Error('Local resource data is incomplete; import the model again');
    return blob.arrayBuffer();
  }
  async remove(pluginId: string, id: string) {
    await this.use(['sets', 'chunks'], 'readwrite', (tx) => {
      const store = tx.objectStore('sets'),
        selected = store.get([pluginId, id]);
      selected.onsuccess = () => {
        if (selected.result) deleteChunks(tx, (selected.result as StoredSet).token);
        store.delete([pluginId, id]);
      };
    });
  }
  async removePlugin(pluginId: string) {
    await this.use(['sets', 'imports', 'chunks'], 'readwrite', (tx) => {
      const cursor = tx
        .objectStore('sets')
        .openCursor(IDBKeyRange.bound([pluginId, ''], [pluginId, '\uffff']));
      cursor.onsuccess = () => {
        if (cursor.result) {
          deleteChunks(tx, (cursor.result.value as StoredSet).token);
          cursor.result.delete();
          cursor.result.continue();
        }
      };
      const pending = tx.objectStore('imports').openCursor();
      pending.onsuccess = () => {
        const item = pending.result;
        if (item) {
          if (item.value.pluginId === pluginId) {
            deleteChunks(tx, item.value.token);
            item.delete();
          }
          item.continue();
        }
      };
    });
  }
  async cleanupExpired(before: number) {
    await this.use(['imports', 'chunks'], 'readwrite', (tx) => {
      const cursor = tx.objectStore('imports').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) {
          if ((item.value.updatedAt ?? item.value.createdAt) < before) {
            deleteChunks(tx, item.value.token);
            item.delete();
          }
          item.continue();
        }
      };
    });
  }
}
export class BrowserLocalResourceStorage extends ValidatedLocalResourceStorage {
  constructor() {
    super(new BrowserLocalResourcePersistence());
  }
  override async removePlugin(pluginId: string) {
    if (typeof indexedDB === 'undefined') return;
    return super.removePlugin(pluginId);
  }
}
export class NativeLocalResourceStorage implements LocalResourceStorage {
  private async invoke<T>(
    command: string,
    args: Record<string, unknown> | ArrayBuffer,
    options?: Record<string, string>,
  ) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args, options ? { headers: options } : undefined);
  }
  beginImport(pluginId: string, owner: string, input: PluginLocalResourceImport) {
    return this.invoke<PluginLocalResourceImportToken>('plugin_resource_begin', {
      pluginId,
      owner,
      input,
    });
  }
  writeChunk(
    pluginId: string,
    owner: string,
    token: string,
    path: string,
    offset: number,
    bytes: ArrayBuffer,
  ) {
    return this.invoke<void>('plugin_resource_write', bytes, {
      'x-bf-options': encodeURIComponent(JSON.stringify({ pluginId, owner, token, path, offset })),
    });
  }
  commitImport(pluginId: string, owner: string, token: string) {
    return this.invoke<PluginLocalResourceSet>('plugin_resource_commit', {
      pluginId,
      owner,
      token,
    });
  }
  abortImport(pluginId: string, owner: string, token: string) {
    return this.invoke<void>('plugin_resource_abort', { pluginId, owner, token });
  }
  list(pluginId: string) {
    return this.invoke<PluginLocalResourceSet[]>('plugin_resource_list', { pluginId });
  }
  read(pluginId: string, id: string, path: string) {
    return this.invoke<ArrayBuffer>('plugin_resource_read', { pluginId, id, path });
  }
  remove(pluginId: string, id: string) {
    return this.invoke<void>('plugin_resource_remove', { pluginId, id });
  }
  async removePlugin(_pluginId: string) {
    /* plugin_remove atomically clears native resources. */
  }
  releaseOwner(pluginId: string, owner: string) {
    return this.invoke<void>('plugin_resource_release_owner', { pluginId, owner });
  }
}
