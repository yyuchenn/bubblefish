import { describe, expect, it, vi } from 'vitest';
import { commandsToOperations, operationsToCommands } from '../src/runtime/document-operations';
import { createPluginHost } from '../src/runtime/plugin-host';
import type { Command, ImageDocument, RichText } from '../src/generated/core';
import type { PluginMutationProposal, PluginOperation } from '../src/generated/plugins';
import type { Workbench } from '../src/runtime/workbench';

const text = (value: string): RichText => ({ runs: [{ text: value, marks: [] }] });
const resolve = (_handle: string): ImageDocument => {
  throw new Error('No image resources expected');
};
const translate = (markerId: string, value = markerId): PluginOperation => ({
  type: 'marker.update',
  imageId: 'image',
  markerId,
  translation: text(value),
});
const assist = (markerId: string, value = markerId): PluginOperation => ({
  type: 'assistance.update',
  imageId: 'image',
  markerId,
  patch: { originalText: value },
});

describe('document operation batching', () => {
  it('exposes batch translations to hooks as ordinary marker updates', () => {
    const command: Command = {
      type: 'updateTranslations',
      updates: [
        { imageId: 'image', markerId: 'a', translation: text('first') },
        { imageId: 'image', markerId: 'b', translation: text('second') },
      ],
    };
    const operations = commandsToOperations([command], () => 'unused');
    expect(operations).toEqual([translate('a', 'first'), translate('b', 'second')]);
    expect(operationsToCommands(operations, resolve)).toEqual([command]);
  });

  it('groups contiguous translation forms and keeps other marker changes in order', () => {
    const commands = operationsToCommands(
      [
        translate('a'),
        { type: 'translation.set', imageId: 'image', markerId: 'b', value: 'new' },
        { type: 'translation.clear', imageId: 'image', markerId: 'c' },
        {
          type: 'marker.update',
          imageId: 'image',
          markerId: 'd',
          translation: text('styled'),
          style: { horizontal: true, overlayText: false },
        },
        translate('e'),
      ],
      resolve,
    );
    expect(commands).toMatchObject([
      {
        type: 'updateTranslations',
        updates: [
          { markerId: 'a', translation: text('a') },
          { markerId: 'b', translation: text('new') },
          { markerId: 'c', translation: { runs: [] } },
        ],
      },
      { type: 'updateMarker', markerId: 'd', style: { horizontal: true } },
      { type: 'updateMarker', markerId: 'e' },
    ]);
  });

  it('starts another group at repeated targets to retain sequential writes', () => {
    const commands = operationsToCommands(
      [translate('a', 'first'), translate('b'), translate('a', 'second'), translate('c')],
      resolve,
    );
    expect(commands).toMatchObject([
      { type: 'updateTranslations', updates: [{ markerId: 'a' }, { markerId: 'b' }] },
      { type: 'updateTranslations', updates: [{ markerId: 'a' }, { markerId: 'c' }] },
    ]);
    expect(commandsToOperations(commands, () => 'unused')).toEqual([
      translate('a', 'first'),
      translate('b'),
      translate('a', 'second'),
      translate('c'),
    ]);
  });

  it('groups assistance fields while preserving preconditions and repeated-target boundaries', () => {
    const expected = { originalText: 'before' };
    const operations: PluginOperation[] = [
      { ...assist('a'), expected } as PluginOperation,
      {
        type: 'assistance.update',
        imageId: 'image',
        markerId: 'b',
        patch: { machineTranslation: 'machine', lastTranslationService: 'service' },
      },
      { type: 'assistance.clear', imageId: 'image', markerId: 'a' },
      assist('c'),
      translate('d'),
    ];
    const commands = operationsToCommands(operations, resolve);
    expect(commands).toMatchObject([
      {
        type: 'updateAssistance',
        updates: [
          { markerId: 'a', originalText: 'a', expected },
          { markerId: 'b', machineTranslation: 'machine', lastTranslationService: 'service' },
        ],
      },
      {
        type: 'updateAssistance',
        updates: [
          { markerId: 'a', originalText: null, machineTranslation: null },
          { markerId: 'c', originalText: 'c' },
        ],
      },
      { type: 'updateMarker', markerId: 'd' },
    ]);
  });

  it('uses both image and marker identity when deciding batch boundaries', () => {
    const commands = operationsToCommands(
      [translate('a'), { ...translate('a'), imageId: 'another-image' } as PluginOperation],
      resolve,
    );
    expect(commands).toMatchObject([{ type: 'updateTranslations', updates: [{}, {}] }]);
  });

  it('enforces the public limit before compression and allows a bounded internal batch', () => {
    const operations = Array.from({ length: 15000 }, (_, index) => translate(`marker-${index}`));
    expect(() => operationsToCommands(operations, resolve)).toThrow('10000');
    const commands = operationsToCommands(operations, resolve, operations.length);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'updateTranslations' });
    if (commands[0].type === 'updateTranslations') expect(commands[0].updates).toHaveLength(15000);
    expect(() => operationsToCommands([...operations, translate('extra')], resolve, 15000)).toThrow(
      '15000',
    );
  });
});

describe('large built-in proposal hook limits', () => {
  function setup() {
    const preview = vi.fn(
      async (_projectId: string, _commands: Command[], _state?: string) => ({}),
    );
    const release = vi.fn();
    const workbench = {
      value: { activeId: 'project', projects: [{ id: 'project', stateId: 'state' }] },
      transport: { preview },
      resources: { release },
      releaseStagedAssets: vi.fn(),
    } as unknown as Workbench;
    return {
      preview,
      host: createPluginHost(workbench, () => ['document.intercept', 'document.write']),
    };
  }
  const proposal = (operations: PluginOperation[]): PluginMutationProposal => ({
    projectId: 'project',
    transactionId: 'transaction',
    baseStateId: 'state',
    origin: { kind: 'user' },
    operations,
  });

  it('validates complete large hook rewrites without allowing them to grow', async () => {
    const { host, preview } = setup();
    const operations = Array.from({ length: 15000 }, (_, index) => translate(`marker-${index}`));
    const rewritten = operations.map((operation, index) =>
      index === 0 ? translate('marker-0', 'rewritten') : operation,
    );
    await host.validateOperations!('plugin', proposal(operations), rewritten);
    expect(preview).toHaveBeenCalledOnce();
    const commands = preview.mock.calls[0][1] as Command[];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'updateTranslations' });
    await expect(
      host.validateOperations!('plugin', proposal(operations), [...rewritten, translate('extra')]),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('keeps ordinary plugin transactions limited to ten thousand operations', async () => {
    const { host, preview } = setup();
    const operations = Array.from({ length: 10001 }, (_, index) => translate(`marker-${index}`));
    await expect(
      host.call!(
        'plugin',
        'document.transaction',
        { projectId: 'project', label: 'plugin batch', operations },
        undefined,
        { runtimeRole: 'main', instanceId: 'instance' },
      ),
    ).rejects.toThrow('10000');
    expect(preview).not.toHaveBeenCalled();
    await expect(
      host.validateOperations!('plugin', proposal([]), operations),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
