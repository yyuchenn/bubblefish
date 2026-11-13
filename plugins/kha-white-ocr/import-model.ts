import { Unzip } from 'fflate';
import { CHUNK_SIZE, MODEL, validateModel } from './model';
import type { connectPanel } from '../../src/plugin-sdk';
type Local = ReturnType<typeof connectPanel>['resources']['local'];

/** Stored ZIP entries keep every read/decode/IPC step bounded by one 4 MiB chunk. */
export async function importModel(
  file: File,
  local: Local,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
) {
  const total = MODEL.files.reduce((sum, file) => sum + file.byteLength, 0);
  if (file.size > total + 1024 * 1024) throw new Error('模型包大小超出已验证模型范围');
  let token: string | undefined,
    manifestReady = false,
    parserError: Error | undefined;
  let uploaded = 0;
  const seen = new Set<string>(),
    completed = new Set<string>();
  const sizes = new Map<string, number>();
  const queued: Array<{ path: string; offset: number; bytes: ArrayBuffer }> = [];
  const unzip = new Unzip((entry) => {
    const expected = MODEL.files.find((file) => file.path === entry.name);
    if (
      seen.has(entry.name) ||
      (!expected && entry.name !== 'model.json') ||
      entry.compression !== 0
    )
      throw new Error('模型包包含重复、未知文件或非标准压缩格式，请使用生成的 .bfmodel');
    if (entry.name !== 'model.json' && !manifestReady) throw new Error('模型清单必须位于包的开头');
    seen.add(entry.name);
    let count = 0;
    const metadata: Uint8Array[] = [];
    entry.ondata = (error, bytes, final) => {
      if (error) {
        parserError = error;
        return;
      }
      const offset = count;
      count += bytes.length;
      if (count > (expected?.byteLength ?? 64 * 1024)) {
        parserError = new Error(`模型文件大小无效：${entry.name}`);
        return;
      }
      if (entry.name === 'model.json') {
        metadata.push(new Uint8Array(bytes));
        if (final) {
          const joined = new Uint8Array(count);
          let position = 0;
          for (const chunk of metadata) {
            joined.set(chunk, position);
            position += chunk.length;
          }
          try {
            validateModel(JSON.parse(new TextDecoder().decode(joined)));
            manifestReady = true;
          } catch (error) {
            parserError = error instanceof Error ? error : new Error(String(error));
          }
        }
      } else {
        for (let start = 0; start < bytes.length; start += CHUNK_SIZE)
          queued.push({
            path: entry.name,
            offset: offset + start,
            bytes: new Uint8Array(bytes.subarray(start, start + CHUNK_SIZE)).buffer,
          });
      }
      if (final) {
        if (expected && count !== expected.byteLength)
          parserError = new Error(`模型文件不完整：${entry.name}`);
        sizes.set(entry.name, count);
        completed.add(entry.name);
      }
    };
    entry.start();
  });
  try {
    progress(0, total);
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      signal.throwIfAborted();
      const end = Math.min(file.size, offset + CHUNK_SIZE);
      unzip.push(new Uint8Array(await file.slice(offset, end).arrayBuffer()), end === file.size);
      if (parserError) throw parserError;
      if (manifestReady && !token)
        token = (await local.beginImport({ id: MODEL.id, files: MODEL.files })).token;
      while (queued.length) {
        signal.throwIfAborted();
        const chunk = queued.shift()!;
        if (!token) throw new Error('模型导入尚未初始化');
        const length = chunk.bytes.byteLength;
        await local.writeChunk({ token, path: chunk.path, offset: chunk.offset }, chunk.bytes);
        uploaded += length;
        progress(uploaded, total);
      }
    }
    signal.throwIfAborted();
    if (
      !token ||
      !manifestReady ||
      completed.size !== 5 ||
      MODEL.files.some((file) => sizes.get(file.path) !== file.byteLength)
    )
      throw new Error('模型包不完整');
    const result = await local.commitImport({ token });
    token = undefined;
    return result;
  } finally {
    if (token) await local.abortImport({ token }).catch(() => {});
  }
}
