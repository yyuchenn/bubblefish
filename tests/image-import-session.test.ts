import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/runtime/assets';
import { ImageImportSession } from '../src/runtime/image-import-session';
import type { CoreTransport } from '../src/runtime/transports';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const files = (...names: string[]) =>
  names.map((name) => ({ name, file: new File(['image'], name, { type: 'image/png' }) }));
const probe = { width: 4, height: 3, checksum: 'checksum', format: 'png' };
const cleanups: (() => void)[] = [];
function setup() {
  const assets = new AssetStore();
  const owned = new Set<string>();
  const probeImage = vi.fn(async () => probe);
  const progress = vi.fn<(value: { done: number; total: number } | null) => void>();
  const onRelease = vi.fn(() => assets.releaseExcept(owned));
  const session = new ImageImportSession(
    assets,
    { probeImage } as unknown as CoreTransport,
    progress,
    onRelease,
  );
  const created = vi.spyOn(URL, 'createObjectURL');
  const revoked = vi.spyOn(URL, 'revokeObjectURL');
  cleanups.push(() => {
    session.release();
    assets.dispose();
  });
  return { assets, owned, probeImage, progress, onRelease, session, created, revoked };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('user image import sessions', () => {
  it('pins each image before yielding during a multi-image import and while matching waits', async () => {
    const { assets, session, probeImage, progress, revoked } = setup();
    const secondStarted = deferred(),
      secondFinished = deferred();
    probeImage
      .mockImplementationOnce(async () => probe)
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        await secondFinished.promise;
        return probe;
      });
    progress.mockImplementation(() => assets.releaseExcept(new Set()));
    const importing = session.import(files('first.png', 'second.png'));
    await secondStarted.promise;
    assets.releaseExcept(new Set());
    expect(revoked).not.toHaveBeenCalled();
    secondFinished.resolve();
    const images = await importing;
    assets.releaseExcept(new Set());
    for (const image of images) expect(assets.get(image.assetId)).toBeDefined();
    expect(progress.mock.calls).toEqual([[{ done: 1, total: 2 }], [{ done: 2, total: 2 }], [null]]);
    session.release();
    for (const image of images) expect(assets.get(image.assetId)).toBeUndefined();
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it('rolls back a failed batch while retaining previous candidates and allowing another batch', async () => {
    const { assets, session, onRelease, created, revoked, progress } = setup();
    const previous = await session.import(files('previous.png'));
    await expect(session.import(files('partial.png', 'unsupported.txt'))).rejects.toThrow(
      '不支持的图片',
    );
    expect(assets.get(previous[0].assetId)).toBeDefined();
    expect(created).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveBeenCalledExactlyOnceWith(created.mock.results[1].value);
    expect(onRelease).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(null);
    const next = await session.import(files('next.png'));
    assets.releaseExcept(new Set());
    expect(assets.get(previous[0].assetId)).toBeDefined();
    expect(assets.get(next[0].assetId)).toBeDefined();
    session.release();
    session.release();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledTimes(3);
    expect(new Set(revoked.mock.calls.map(([url]) => url)).size).toBe(3);
  });

  it('releases unused candidates after ownership transfers without discarding committed images', async () => {
    const { assets, owned, session, revoked } = setup();
    const [selected, unused] = await session.import(files('selected.png', 'unused.png'));
    owned.add(selected.assetId);
    session.release();
    expect(assets.get(selected.assetId)).toBeDefined();
    expect(assets.get(unused.assetId)).toBeUndefined();
    expect(revoked).toHaveBeenCalledTimes(1);
    owned.clear();
    assets.releaseExcept(owned);
    expect(assets.get(selected.assetId)).toBeUndefined();
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending batch and discards an image whose probe finishes after cancellation', async () => {
    const { assets, session, probeImage, onRelease, created, revoked, progress } = setup();
    const secondStarted = deferred(),
      secondFinished = deferred();
    probeImage
      .mockImplementationOnce(async () => probe)
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        await secondFinished.promise;
        return probe;
      });
    const importing = session.import(files('first.png', 'late.png'));
    const rejected = expect(importing).rejects.toThrow('会话已关闭');
    await secondStarted.promise;
    session.release();
    expect(revoked).toHaveBeenCalledTimes(1);
    secondFinished.resolve();
    await rejected;
    assets.releaseExcept(new Set());
    expect(created).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveBeenCalledTimes(2);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(null);
  });

  it('rejects a completed batch if its session closes before the import result is delivered', async () => {
    const { session, progress, probeImage, created, revoked, onRelease } = setup();
    progress.mockImplementation((value) => {
      if (value && value.done === value.total) session.release();
    });
    await expect(session.import(files('late-result.png'))).rejects.toThrow('会话已关闭');
    expect(created).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    await expect(session.import(files('closed.png'))).rejects.toThrow('会话已关闭');
    expect(probeImage).toHaveBeenCalledTimes(1);
  });

  it('cleans up partial imports when the asset store is disposed during a later probe', async () => {
    const { assets, session, probeImage, created, revoked } = setup();
    const secondStarted = deferred(),
      secondFinished = deferred();
    probeImage
      .mockImplementationOnce(async () => probe)
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        await secondFinished.promise;
        return probe;
      });
    const importing = session.import(files('first.png', 'late.png'));
    const rejected = expect(importing).rejects.toThrow('会话已关闭');
    await secondStarted.promise;
    assets.dispose();
    secondFinished.resolve();
    await rejected;
    expect(created).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledTimes(1);
  });
});
