import { describe, expect, it, vi } from 'vitest';
import { createPluginHost } from '../src/runtime/plugin-host';
import { AssetStore } from '../src/runtime/assets';
import { ImageResources } from '../src/runtime/image-resources';
import type { Workbench, ProjectView } from '../src/runtime/workbench';
import type { CoreTransport } from '../src/runtime/transports';
import type { JsonValue, PluginMutationProposal, PluginOperation } from '../src/generated/plugins';
import { readImageRegion } from '../src/runtime/read-image';

vi.mock('../src/runtime/read-image', async (original) => ({
  ...(await original<typeof import('../src/runtime/read-image')>()),
  readImageRegion: vi.fn(async () => ({
    bytes: new Uint8Array([137, 80, 78, 71, 9]).buffer,
    width: 2,
    height: 3,
  })),
}));
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const all = [
  'document.read',
  'document.write',
  'images.read',
  'images.write',
  'history.read',
  'history.control',
  'document.intercept',
];
async function setup(permissions = all) {
  const assets = new AssetStore();
  const transport = {
    probeImage: vi.fn(async () => ({ width: 10, height: 20, checksum: 'abc', format: 'png' })),
    preview: vi.fn(async () => ({})),
  } as unknown as CoreTransport;
  const [image] = await assets.import(
    [{ name: 'page.png', file: new File([PNG], 'page.png', { type: 'image/png' }) }],
    transport,
  );
  image.id = 'i';
  image.markers = [
    {
      id: 'm',
      geometry: { type: 'rectangle', x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      translation: { runs: [{ text: 'Hello', marks: ['bold'] }], raw: 'raw' },
      style: { overlayText: true, horizontal: false },
      bunnyCache: {
        originalText: 'original',
        machineTranslation: 'machine',
        unknown: { keep: true },
      },
    },
  ];
  const project: ProjectView = {
    id: 'p',
    name: 'Project',
    sourceLanguage: 'ja',
    targetLanguage: 'zh',
    images: [image],
    stateId: 's0',
    savedStateId: 's0',
    canUndo: false,
    canRedo: false,
    historyDepth: 0,
    historyRevision: 0,
  };
  const resources = new ImageResources(assets, transport);
  const workbench = {
    value: { activeId: 'p', projects: [project], imageId: 'i', markerId: 'm' },
    assets,
    resources,
    transport,
    notice: vi.fn(),
    commitOperations: vi.fn(async () => ({ applied: true })),
    historyList: vi.fn(async () => ({
      undo: [],
      redo: [],
      undoTotal: 0,
      redoTotal: 0,
      historyRevision: 3,
    })),
    history: vi.fn(async () => undefined),
    releaseStagedAssets: vi.fn(),
  };
  const host = createPluginHost(workbench as unknown as Workbench, () => permissions);
  const context = { runtimeRole: 'main' as const, instanceId: 'instance-1' };
  const call = (method: string, params: JsonValue = { projectId: 'p' }, binary?: ArrayBuffer) =>
    host.call!('plugin.id', method, params, binary, context);
  const proposal: PluginMutationProposal = {
    projectId: 'p',
    transactionId: 'tx',
    baseStateId: 's0',
    origin: { kind: 'user' },
    operations: [],
  };
  return {
    host,
    workbench,
    assets,
    resources,
    transport,
    project,
    call,
    context,
    proposal,
    dispose: () => {
      resources.dispose();
      assets.dispose();
    },
  };
}

describe('typed plugin host document operations', () => {
  it('provides rich metadata and old flat read compatibility without exposing asset paths', async () => {
    const s = await setup();
    try {
      expect(
        (await s.call('document.images.get', { projectId: 'p', imageId: 'i' })).result,
      ).toMatchObject({
        id: 'i',
        markers: [{ translation: { runs: [{ text: 'Hello', marks: ['bold'] }], raw: 'raw' } }],
      });
      expect(
        (await s.call('document.translations.get', { projectId: 'p', imageId: 'i', markerId: 'm' }))
          .result,
      ).toEqual(s.project.images[0].markers[0].translation);
      expect(
        (await s.call('document.assistance.get', { projectId: 'p', imageId: 'i', markerId: 'm' }))
          .result,
      ).toMatchObject({ unknown: { keep: true } });
      expect(await s.host.readDocument('plugin.id', null)).toMatchObject({
        projectId: 'p',
        selection: { imageId: 'i', markerId: 'm' },
        images: [
          {
            markers: [
              { translation: 'Hello', originalText: 'original', machineTranslation: 'machine' },
            ],
          },
        ],
      });
      expect(JSON.stringify((await s.call('document.images.list')).result)).not.toContain('path');
    } finally {
      s.dispose();
    }
  });
  it('returns exact encoded bytes, delegates crop decoding to a worker, and pins while reading', async () => {
    const s = await setup();
    try {
      const pin = vi.spyOn(s.assets, 'pin');
      const full = await s.call('document.images.read', { projectId: 'p', imageId: 'i' });
      expect([...new Uint8Array(full.binary!)]).toEqual([...PNG]);
      expect(full.result).toMatchObject({ mimeType: 'image/png', byteLength: PNG.byteLength });
      expect(pin).toHaveBeenCalledWith([s.project.images[0].assetId]);
      const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
      const crop = await s.call('document.images.read', { projectId: 'p', imageId: 'i', region });
      expect(readImageRegion).toHaveBeenCalledWith(expect.any(File), region);
      expect(crop.result).toMatchObject({ mimeType: 'image/png', region, width: 2, height: 3 });
    } finally {
      s.dispose();
    }
  });
  it('keeps staged handles scoped to the owning instance/project and derives metadata from pixels', async () => {
    const s = await setup();
    try {
      const staged = (
        await s.call(
          'document.images.stage',
          { projectId: 'p', filename: 'misnamed.jpg' },
          PNG.buffer.slice(0),
        )
      ).result as Record<string, JsonValue>;
      expect(staged).toMatchObject({
        width: 10,
        height: 20,
        checksum: 'md5:abc',
        mimeType: 'image/png',
      });
      expect(() =>
        s.resources.resolve(String(staged.stagedResource), 'other-instance', 'p'),
      ).toThrow('实例');
      expect(() =>
        s.resources.resolve(String(staged.stagedResource), s.context.instanceId, 'other-project'),
      ).toThrow('项目');
      await expect(
        s.host.call!(
          'plugin.id',
          'document.transaction',
          {
            projectId: 'p',
            label: 'steal',
            operations: [
              { type: 'image.create', id: 'new', stagedResource: staged.stagedResource },
            ],
          },
          undefined,
          { runtimeRole: 'main', instanceId: 'other-instance' },
        ),
      ).rejects.toThrow('句柄');
      expect(
        s.resources.resolve(String(staged.stagedResource), s.context.instanceId, 'p'),
      ).toMatchObject({ width: 10, height: 20 });
      s.host.releaseInstance!('plugin.id', s.context.instanceId);
      expect(() =>
        s.resources.resolve(String(staged.stagedResource), s.context.instanceId, 'p'),
      ).toThrow('句柄');
    } finally {
      s.dispose();
    }
  });
  it('validates an entire multi-image transaction before submitting one atomic operation', async () => {
    const s = await setup();
    try {
      const handles = [];
      for (const filename of ['a.png', 'b.png'])
        handles.push(
          (await s.call('document.images.stage', { projectId: 'p', filename }, PNG.buffer.slice(0)))
            .result as Record<string, JsonValue>,
        );
      const operations: PluginOperation[] = handles.map((entry, index) => ({
        type: 'image.create',
        id: `new-${index}`,
        stagedResource: String(entry.stagedResource),
      }));
      operations.push({
        type: 'marker.create',
        imageId: 'new-0',
        marker: {
          id: 'new-marker',
          geometry: { type: 'point', x: 0.5, y: 0.5 },
          translation: { runs: [] },
          style: { horizontal: true, overlayText: false },
        },
      });
      await s.call('document.transaction', {
        projectId: 'p',
        label: 'batch',
        expectedStateId: 's0',
        causationId: 'cause',
        operations,
      } as unknown as JsonValue);
      expect(s.transport.preview).toHaveBeenCalledTimes(1);
      expect(s.workbench.commitOperations).toHaveBeenCalledTimes(1);
      expect(s.workbench.commitOperations).toHaveBeenCalledWith(
        'p',
        'batch',
        operations,
        s.context.instanceId,
        { kind: 'plugin', pluginId: 'plugin.id', label: 'batch', causationId: 'cause' },
        's0',
      );
    } finally {
      s.dispose();
    }
  });
  it('releases owned handles after failed preflight without committing or releasing another owner', async () => {
    const s = await setup();
    try {
      const own = (
        await s.call(
          'document.images.stage',
          { projectId: 'p', filename: 'own.png' },
          PNG.buffer.slice(0),
        )
      ).result as Record<string, JsonValue>;
      vi.mocked(s.transport.preview!).mockRejectedValueOnce(new Error('invalid middle operation'));
      await expect(
        s.call('document.transaction', {
          projectId: 'p',
          label: 'fail',
          operations: [
            { type: 'image.create', id: 'new', stagedResource: own.stagedResource },
            { type: 'marker.remove', imageId: 'missing', markerId: 'missing' },
          ],
        }),
      ).rejects.toThrow('invalid middle');
      expect(s.workbench.commitOperations).not.toHaveBeenCalled();
      expect(() =>
        s.resources.resolve(String(own.stagedResource), s.context.instanceId, 'p'),
      ).toThrow('句柄');
    } finally {
      s.dispose();
    }
  });
  it('reads only the hook base project and authorizes proposal-held staged resources', async () => {
    const s = await setup();
    try {
      const staged = (
        await s.call(
          'document.images.stage',
          { projectId: 'p', filename: 'staged.png' },
          PNG.buffer.slice(0),
        )
      ).result as Record<string, JsonValue>;
      s.proposal.operations = [
        { type: 'image.create', id: 'new', stagedResource: String(staged.stagedResource) },
      ];
      const context = {
        runtimeRole: 'hooks' as const,
        instanceId: 'hook-instance',
        proposal: s.proposal,
      };
      expect(
        (
          await s.host.call!(
            'plugin.id',
            'document.images.read',
            { projectId: 'p', stagedResource: staged.stagedResource },
            undefined,
            context,
          )
        ).binary,
      ).toEqual(PNG.buffer);
      await expect(
        s.host.call!('plugin.id', 'document.read', { projectId: 'other' }, undefined, context),
      ).rejects.toMatchObject({ code: 'hook_scope' });
      await expect(
        s.host.call!(
          'plugin.id',
          'document.transaction',
          { projectId: 'p', label: 'nested', operations: [] },
          undefined,
          context,
        ),
      ).rejects.toMatchObject({ code: 'hook_readonly' });
      s.project.stateId = 'changed';
      await expect(
        s.host.call!('plugin.id', 'document.images.list', { projectId: 'p' }, undefined, context),
      ).rejects.toMatchObject({ code: 'state_conflict' });
    } finally {
      s.dispose();
    }
  });
  it('requires document/image/history permissions independently and forwards history conflict guards', async () => {
    const s = await setup(['document.read']);
    try {
      expect((await s.call('document.images.list')).result).toBeInstanceOf(Array);
      await expect(
        s.call('document.images.read', { projectId: 'p', imageId: 'i' }),
      ).rejects.toMatchObject({ code: 'permission' });
      await expect(s.call('history.list')).rejects.toMatchObject({ code: 'permission' });
      await expect(
        s.call('document.transaction', { projectId: 'p', label: 'no', operations: [] }),
      ).rejects.toMatchObject({ code: 'permission' });
    } finally {
      s.dispose();
    }
    const t = await setup();
    try {
      await t.call('history.list', { projectId: 'p', offset: 2, limit: 3 });
      expect(t.workbench.historyList).toHaveBeenCalledWith('p', { offset: 2, limit: 3 });
      await t.call('history.pop', {
        projectId: 'p',
        stack: 'redo',
        expectedEntryId: 'entry',
        expectedHistoryRevision: 7,
      });
      expect(t.workbench.history).toHaveBeenCalledWith(
        'redo',
        'p',
        { expectedEntryId: 'entry', expectedHistoryRevision: 7 },
        { kind: 'history', pluginId: 'plugin.id' },
      );
      await expect(
        t.call('history.pop', { projectId: 'p', stack: 'invalid' }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      t.dispose();
    }
  });
  it('routes legacy writes through transactions and validates hook rewrites with bound permissions', async () => {
    const s = await setup();
    try {
      expect(
        await s.host.applyDocument('plugin.id', {
          type: 'setTranslation',
          projectId: 'p',
          imageId: 'i',
          markerId: 'm',
          text: 'new',
        }),
      ).toEqual({ applied: true });
      expect(s.workbench.commitOperations).toHaveBeenCalledWith(
        'p',
        expect.any(String),
        [{ type: 'translation.set', imageId: 'i', markerId: 'm', value: 'new' }],
        'legacy:plugin.id',
        expect.objectContaining({ pluginId: 'plugin.id' }),
        undefined,
      );
      await s.host.validateOperations!('plugin.id', s.proposal, [
        { type: 'translation.clear', imageId: 'i', markerId: 'm' },
      ]);
      expect(s.transport.preview).toHaveBeenLastCalledWith(
        'p',
        [{ type: 'updateMarker', imageId: 'i', markerId: 'm', translation: { runs: [] } }],
        's0',
      );
    } finally {
      s.dispose();
    }
    const t = await setup(['document.intercept', 'document.read']);
    try {
      await expect(
        t.host.validateOperations!('plugin.id', t.proposal, [
          { type: 'translation.clear', imageId: 'i', markerId: 'm' },
        ]),
      ).rejects.toMatchObject({ code: 'permission' });
    } finally {
      t.dispose();
    }
  });
  it('checks rewrite authority for changed, removed and moved operations while preserving unchanged images', async () => {
    const s = await setup(['document.read', 'document.write', 'document.intercept']);
    const image: PluginOperation = { type: 'image.update', imageId: 'i', filename: 'renamed.png' };
    const text: PluginOperation = {
      type: 'translation.set',
      imageId: 'i',
      markerId: 'm',
      value: 'before',
    };
    s.proposal.operations = [image, text];
    try {
      await s.host.validateOperations!('plugin.id', s.proposal, [
        image,
        { ...text, value: 'after' },
      ]);
      await s.host.validateOperations!('plugin.id', s.proposal, [
        { ...text, value: 'inserted' },
        image,
        text,
      ]);
      await expect(
        s.host.validateOperations!('plugin.id', s.proposal, [text]),
      ).rejects.toMatchObject({ code: 'permission' });
      await expect(
        s.host.validateOperations!('plugin.id', s.proposal, [text, image]),
      ).rejects.toMatchObject({ code: 'permission' });
      await expect(
        s.host.validateOperations!('plugin.id', s.proposal, [
          { ...image, filename: 'changed.png' },
          text,
        ]),
      ).rejects.toMatchObject({ code: 'permission' });
      expect(s.transport.preview).toHaveBeenCalledTimes(2);
    } finally {
      s.dispose();
    }
    const t = await setup(['document.read', 'document.intercept']);
    t.proposal.operations = [image, text];
    try {
      await t.host.validateOperations!('plugin.id', t.proposal, [
        { filename: 'renamed.png', imageId: 'i', type: 'image.update' },
        text,
      ]);
    } finally {
      t.dispose();
    }
  });
  it('requires document.read when image read metadata contains rich document fields', async () => {
    const s = await setup(['images.read']);
    try {
      await expect(
        s.call('document.images.read', { projectId: 'p', imageId: 'i' }),
      ).rejects.toMatchObject({
        code: 'permission',
        message: expect.stringContaining('document.read'),
      });
    } finally {
      s.dispose();
    }
  });
});
