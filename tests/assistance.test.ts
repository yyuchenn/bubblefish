import { describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { AssistanceService, providerText } from '../src/runtime/assistance';
import type { Workbench, ProjectView, ViewState } from '../src/runtime/workbench';
import type { PluginManager } from '../src/runtime/plugins';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  const project = {
    id: 'project',
    sourceLanguage: 'japanese',
    targetLanguage: 'simplifiedChinese',
    images: [
      {
        id: 'image',
        assetId: 'asset',
        markers: [1, 2].map((n) => ({
          id: `marker-${n}`,
          geometry: { type: 'point', x: 0.5, y: 0.5 },
          translation: { runs: [] },
          style: { overlayText: false, horizontal: false },
          bunnyCache: { originalText: `原文${n}` },
        })),
      },
    ],
  } as unknown as ProjectView;
  const state = {
    projects: [project],
    activeId: project.id,
    imageId: 'image',
    markerId: 'marker-1',
  } as ViewState;
  const store = writable(state);
  const documentCommand = vi.fn(
    async (_command: unknown, _label: string, _projectId: string) => ({}),
  );
  const workbench = {
    value: state,
    active: project,
    image: project.images[0],
    subscribe: store.subscribe,
    barrier: vi.fn(async () => {}),
    documentCommand,
    notice: vi.fn(),
  } as unknown as Workbench;
  const translate = vi.fn(async () => ({ text: '机器译文' }));
  const plugins = { translate } as unknown as PluginManager;
  return {
    service: new AssistanceService(workbench, plugins),
    project,
    state,
    store,
    documentCommand,
    translate,
  };
}
describe('Assistance task boundaries', () => {
  it('commits a page batch in one atomic command without overwriting human translations', async () => {
    const { service, documentCommand } = setup();
    const run = await service.run('translation', 'test/translator', true);
    expect(run.applied).toBe(2);
    expect(documentCommand).toHaveBeenCalledTimes(1);
    const command = documentCommand.mock.calls[0][0] as unknown as {
      type: string;
      updates: object[];
    };
    expect(command.type).toBe('updateAssistance');
    expect(command.updates).toHaveLength(2);
    expect(command.updates[0]).toMatchObject({
      machineTranslation: '机器译文',
      expected: { originalText: '原文1' },
    });
    expect(command.updates[0]).not.toHaveProperty('translation');
    service.dispose();
  });
  it('ignores a result after relevant input changes, but accepts unrelated human editing', async () => {
    const { service, project, documentCommand, translate } = setup();
    const started = deferred<void>(),
      output = deferred<{ text: string }>();
    translate.mockImplementation(async () => {
      started.resolve();
      return output.promise;
    });
    const task = service.run('translation', 'test/translator');
    await started.promise;
    project.images[0].markers[0].bunnyCache = { originalText: '新原文' };
    output.resolve({ text: '过期译文' });
    expect((await task).applied).toBe(0);
    expect(documentCommand).not.toHaveBeenCalled();
    service.dispose();
  });
  it('cancels on project close even if a plugin later resolves successfully', async () => {
    const { service, state, store, documentCommand, translate } = setup();
    const started = deferred<void>(),
      output = deferred<{ text: string }>();
    translate.mockImplementation(async () => {
      started.resolve();
      return output.promise;
    });
    const task = service.run('translation', 'test/translator');
    await started.promise;
    state.projects = [];
    store.set(state);
    output.resolve({ text: '迟到译文' });
    expect((await task).state).toBe('cancelled');
    expect(documentCommand).not.toHaveBeenCalled();
    service.dispose();
  });
  it('rejects malformed provider output', () => {
    expect(() => providerText({ data: 'invalid' })).toThrow('text');
  });
});
