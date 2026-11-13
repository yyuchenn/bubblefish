import { describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/runtime/assets';
import { ImageResources } from '../src/runtime/image-resources';
import type { CoreTransport } from '../src/runtime/transports';

function setup() {
  const assets = new AssetStore();
  const probeImage = vi.fn(async () => ({
    width: 4,
    height: 3,
    checksum: '0123456789abcdef0123456789abcdef',
  }));
  const resources = new ImageResources(assets, { probeImage } as unknown as CoreTransport);
  return { assets, resources, probeImage };
}
describe('image resource leases', () => {
  it('pins uploads before import yields and keeps successful and historic resource versions until released', async () => {
    const { assets, resources } = setup();
    const uploaded = await resources.stage(
      'instance',
      'project',
      'original.png',
      new ArrayBuffer(8),
    );
    assets.releaseExcept(new Set());
    expect(assets.get(uploaded.assetId)).toBeDefined();
    expect(() => resources.resolve(uploaded.stagedResource, 'other', 'project')).toThrow();
    expect(() => resources.resolve(uploaded.stagedResource, 'instance', 'other')).toThrow();
    const inFlight = assets.pin([uploaded.assetId]);
    resources.releaseOwner('instance');
    assets.releaseExcept(new Set());
    expect(assets.get(uploaded.assetId)).toBeDefined();
    inFlight();
    assets.releaseExcept(new Set());
    expect(assets.get(uploaded.assetId)).toBeUndefined();
    assets.dispose();
  });
  it.each(['instance', 'project', 'session'] as const)(
    'does not leak an upload that finishes after its %s closes',
    async (kind) => {
      const { assets, resources, probeImage } = setup();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      probeImage.mockImplementation(async () => {
        await pending;
        return { width: 4, height: 3, checksum: 'checksum' };
      });
      const created = vi.spyOn(URL, 'createObjectURL'),
        revoked = vi.spyOn(URL, 'revokeObjectURL');
      const upload = resources.stage('instance', 'project', 'original.png', new ArrayBuffer(8));
      const rejected = expect(upload).rejects.toThrow(/关闭/);
      if (kind === 'instance') resources.releaseOwner('instance');
      if (kind === 'project') resources.releaseProject('project');
      if (kind === 'session') assets.dispose();
      finish();
      await rejected;
      expect(revoked.mock.calls.length).toBe(created.mock.calls.length);
      assets.dispose();
      vi.restoreAllMocks();
    },
  );
});
