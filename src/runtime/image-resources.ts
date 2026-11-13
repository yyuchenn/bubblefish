import type { ImageDocument } from '../generated/core';
import type { PluginStagedImage } from '../generated/plugins';
import { AssetStore, id } from './assets';
import type { CoreTransport } from './transports';

interface Staged {
  owner: string;
  projectId: string;
  image: ImageDocument;
  release(): void;
}
const mime = (name: string) =>
  ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
  })[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
export const imageMime = mime;

/** Staged image handles are scoped to one plugin instance and project. */
export class ImageResources {
  private staged = new Map<string, Staged>();
  private revoked = new Set<string>();
  private closedProjects = new Set<string>();
  constructor(
    private assets: AssetStore,
    private transport: CoreTransport,
  ) {}
  alive(owner: string) {
    return !this.revoked.has(owner);
  }
  retain(image: ImageDocument, owner: string, projectId: string): string {
    if (!this.alive(owner) || this.closedProjects.has(projectId))
      throw new Error('插件实例或项目已关闭');
    const handle = id();
    this.staged.set(handle, {
      owner,
      projectId,
      image: structuredClone(image),
      release: this.assets.pin([image.assetId]),
    });
    return handle;
  }
  async stage(
    owner: string,
    projectId: string,
    filename: string,
    bytes: ArrayBuffer,
  ): Promise<PluginStagedImage> {
    if (!this.alive(owner)) throw new Error('插件实例已关闭');
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('\\') ||
      /[\0-\x1f]/.test(filename)
    )
      throw new Error('图片名称必须是不含路径的文件名');
    let stagedResource = '';
    const [image] = await this.assets.import(
      [{ name: filename, file: new File([bytes], filename, { type: mime(filename) }) }],
      this.transport,
      undefined,
      (image) => {
        stagedResource = this.retain(image, owner, projectId);
      },
    );
    return {
      stagedResource,
      assetId: image.assetId,
      filename: image.filename,
      width: image.width,
      height: image.height,
      checksum: image.checksum ?? '',
      mimeType: mime(filename),
    };
  }
  resolve(
    handle: string,
    owner: string,
    projectId: string,
    sharedHandles: string[] = [],
  ): ImageDocument {
    const entry = this.staged.get(handle);
    if (
      !entry ||
      entry.projectId !== projectId ||
      (entry.owner !== owner && !sharedHandles.includes(handle))
    )
      throw new Error('暂存图片句柄无效或不属于当前项目／实例');
    return structuredClone(entry.image);
  }
  release(handles: Iterable<string>) {
    for (const handle of handles) {
      const value = this.staged.get(handle);
      if (value) {
        value.release();
        this.staged.delete(handle);
      }
    }
  }
  releaseOwner(owner: string) {
    this.revoked.add(owner);
    this.release(
      [...this.staged].filter(([, value]) => value.owner === owner).map(([handle]) => handle),
    );
  }
  releaseProject(projectId: string) {
    this.closedProjects.add(projectId);
    this.release(
      [...this.staged]
        .filter(([, value]) => value.projectId === projectId)
        .map(([handle]) => handle),
    );
  }
  dispose() {
    this.release(this.staged.keys());
  }
}
