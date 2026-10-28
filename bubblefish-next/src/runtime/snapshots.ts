import type { ProjectDocument } from '../generated/core';
export interface Snapshot {
  id: string;
  projectName: string;
  date: number;
  bytes: Uint8Array;
  document?: ProjectDocument;
  exportError?: string;
}
const limit = 50 * 1024 * 1024;
const size = (snapshot: Pick<Snapshot, 'bytes' | 'document'>) =>
  snapshot.bytes.byteLength +
  (snapshot.document ? new TextEncoder().encode(JSON.stringify(snapshot.document)).byteLength : 0);

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bubblefish-next', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('snapshots', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('snapshots', mode);
      const request = operation(tx.objectStore('snapshots'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const snapshots = {
  async list(): Promise<Snapshot[]> {
    return ((await transaction('readonly', (s) => s.getAll())) as Snapshot[]).sort(
      (a, b) => b.date - a.date,
    );
  },
  async remove(id: string) {
    await transaction('readwrite', (s) => s.delete(id));
  },
  async add(
    projectName: string,
    bytes: Uint8Array,
    document?: ProjectDocument,
    exportError?: string,
  ) {
    const byteLength = size({ bytes, document });
    if (byteLength > limit) throw new Error('项目快照超过 50 MiB 存储上限，请手动保存项目');
    const all = await this.list();
    let total = all.reduce((n, s) => n + size(s), byteLength);
    for (const old of [...all].reverse()) {
      if (total <= limit) break;
      await this.remove(old.id);
      total -= size(old);
    }
    await transaction('readwrite', (s) =>
      s.put({
        id: crypto.randomUUID(),
        projectName,
        date: Date.now(),
        bytes,
        document,
        exportError,
      }),
    );
  },
};
