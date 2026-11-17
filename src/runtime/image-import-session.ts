import type { ImageDocument } from '../generated/core';
import type { AssetStore } from './assets';
import type { PickedFile } from './platform';
import type { CoreTransport } from './transports';

/** Keeps user-selected images alive until their import is committed or cancelled. */
export class ImageImportSession {
  private closed = false;
  private leases = new Map<string, () => void>();
  constructor(
    private assets: AssetStore,
    private transport: CoreTransport,
    private progress: (value: { done: number; total: number } | null) => void,
    private onRelease: () => void,
  ) {}
  async import(files: PickedFile[]): Promise<ImageDocument[]> {
    if (this.closed) throw new Error('图片导入会话已关闭');
    const batch = new Set<string>();
    try {
      const images = await this.assets.import(
        files,
        this.transport,
        (done, total) => this.progress({ done, total }),
        (image) => {
          if (this.closed) throw new Error('图片导入会话已关闭');
          this.leases.set(image.assetId, this.assets.pin([image.assetId]));
          batch.add(image.assetId);
        },
      );
      if (this.closed) throw new Error('图片导入会话已关闭');
      return images;
    } catch (error) {
      for (const assetId of batch) {
        this.leases.get(assetId)?.();
        this.leases.delete(assetId);
      }
      this.assets.discard(batch);
      throw error;
    } finally {
      this.progress(null);
    }
  }
  release() {
    if (this.closed) return;
    this.closed = true;
    for (const release of this.leases.values()) release();
    this.leases.clear();
    this.onRelease();
  }
}
