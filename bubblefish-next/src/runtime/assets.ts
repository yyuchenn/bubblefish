import type { ImageDocument } from '../generated/core';
import type { CoreTransport } from './transports';
import { platform, type PickedFile } from './platform';
import { createThumbnail } from './thumbnails';

export const id = () => crypto.randomUUID();
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
export const imagePattern = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const checksumKey = (value?: string) => value?.replace(/^md5:/i, '').toLowerCase();
export interface Asset {
  id: string;
  url: string;
  thumbnail?: string;
  file?: File;
  path?: string;
  filename: string;
}

/** Original browser Files are references, never copied into document/history. */
export class AssetStore {
  private disposed = false;
  private assets = new Map<string, Asset>();
  private pins = new Map<string, number>();
  private thumbnailJobs = new Map<string, Promise<string | undefined>>();
  get(assetId: string) {
    return this.assets.get(assetId);
  }
  pin(assetIds: Iterable<string>): () => void {
    const ids = [...new Set(assetIds)];
    for (const key of ids) this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of ids) {
        const count = (this.pins.get(key) ?? 1) - 1;
        if (count > 0) this.pins.set(key, count);
        else this.pins.delete(key);
      }
    };
  }
  async file(assetId: string): Promise<File> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error('图片资源已释放');
    const file =
      asset.file ?? (asset.path ? (await platform.readFile(asset.path)).file : undefined);
    if (!file) throw new Error('图片尚未关联');
    return file;
  }

  async import(
    files: PickedFile[],
    transport: CoreTransport,
    progress: (done: number, total: number) => void = () => {},
    imported: (image: ImageDocument) => void = () => {},
  ): Promise<ImageDocument[]> {
    const result: ImageDocument[] = [];
    for (const [index, picked] of files.entries()) {
      if (this.disposed) throw new Error('图片资源会话已关闭');
      const file = picked.file ?? (await platform.readFile(picked.path!)).file!;
      if (!imagePattern.test(file.name)) throw new Error(`不支持的图片：${file.name}`);
      const info = await transport.probeImage(new Uint8Array(await file.arrayBuffer()));
      const assetId = id();
      const nativeUrl =
        picked.path && platform.desktop ? await platform.imageUrl(picked.path) : undefined;
      if (this.disposed) throw new Error('图片资源会话已关闭');
      const asset: Asset = {
        id: assetId,
        url: nativeUrl ?? URL.createObjectURL(file),
        file: nativeUrl ? undefined : file,
        path: picked.path,
        filename: file.name,
      };
      this.assets.set(assetId, asset);
      const image: ImageDocument = {
        id: id(),
        assetId,
        filename: file.name,
        width: info.width,
        height: info.height,
        checksum: `md5:${checksumKey(info.checksum)}`,
        markers: [],
      };
      // The lease must be established before yielding to another transaction.
      try {
        imported(image);
      } catch (error) {
        this.discard([assetId]);
        throw error;
      }
      result.push(image);
      progress(index + 1, files.length);
    }
    return result;
  }

  async thumbnail(assetId: string): Promise<string | undefined> {
    const asset = this.assets.get(assetId);
    if (!asset || asset.thumbnail) return asset?.thumbnail;
    let job = this.thumbnailJobs.get(assetId);
    if (!job) {
      job = createThumbnail(
        { name: asset.filename, file: asset.file, path: asset.path },
        () => !this.assets.has(assetId),
      )
        .then((value) => {
          asset.thumbnail = value;
          return value;
        })
        .catch(() => undefined)
        .finally(() => this.thumbnailJobs.delete(assetId));
      this.thumbnailJobs.set(assetId, job);
    }
    return job;
  }

  releaseExcept(ids: Set<string>) {
    for (const [key, asset] of this.assets)
      if (!ids.has(key) && !this.pins.has(key)) {
        if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
        this.assets.delete(key);
      }
  }
  discard(ids: Iterable<string>) {
    for (const key of ids) {
      const asset = this.assets.get(key);
      if (!asset || this.pins.has(key)) continue;
      if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      this.assets.delete(key);
    }
  }
  dispose() {
    this.disposed = true;
    this.pins.clear();
    this.releaseExcept(new Set());
  }
}
