import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../src/runtime/workbench';
import { platform, type SaveResult } from '../src/runtime/platform';
import type { CoreTransport } from '../src/runtime/transports/types';
import type { Envelope, ProjectDocument, ProjectPatch, Reply } from '../src/generated/core';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const original: ProjectDocument = {
  id: 'project',
  name: 'original',
  sourceLanguage: 'japanese',
  targetLanguage: 'simplifiedChinese',
  images: [],
};
function patch(name: string, stateId: string, savedStateId = 'state-0'): ProjectPatch {
  return {
    id: original.id,
    name,
    sourceLanguage: original.sourceLanguage,
    targetLanguage: original.targetLanguage,
    imageOrder: [],
    upsertImages: [],
    removedImageIds: [],
    stateId,
    savedStateId,
    canUndo: stateId !== 'state-0',
    canRedo: false,
    historyDepth: stateId === 'state-0' ? 0 : 1,
  };
}
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const instances: Workbench[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.restoreAllMocks();
});

/** A scripted remote boundary, deliberately without an editor or history engine. */
async function setup() {
  const remote = { current: patch('original', 'state-0'), revision: 0 };
  const acknowledge = (envelope: Envelope, next = remote.current): Reply => {
    remote.current = next;
    return {
      commandId: envelope.commandId,
      eventRevision: ++remote.revision,
      projectId: 'project',
      patch: structuredClone(next),
    };
  };
  const dispatch = vi.fn(async (envelope: Envelope): Promise<Reply> => {
    if (envelope.command.type === 'createProject' || envelope.command.type === 'endGroup')
      return acknowledge(envelope);
    if (envelope.command.type === 'markSaved')
      return acknowledge(envelope, { ...remote.current, savedStateId: envelope.command.stateId });
    throw new Error(`Unscripted command: ${envelope.command.type}`);
  });
  const transport: CoreTransport = {
    ready: vi.fn(async () => {}),
    dispatch,
    importProject: vi.fn(async () => {
      throw new Error('Unused import');
    }),
    exportProject: vi.fn(async () => encode(remote.current.stateId)),
    probeImage: vi.fn(async () => {
      throw new Error('Unused image probe');
    }),
    dispose: vi.fn(),
  };
  const workbench = new Workbench(transport);
  instances.push(workbench);
  await workbench.finishOpen({
    document: structuredClone(original),
    warnings: [],
    forceSaveAs: false,
    format: 'bf',
  });
  return { workbench, remote, transport, dispatch, acknowledge };
}

describe('Workbench transaction boundaries', () => {
  it('publishes each queued reply before the next dispatch and subsequent export can observe it', async () => {
    const { workbench, remote, transport, dispatch, acknowledge } = await setup();
    const firstReply = deferred<void>(),
      secondReply = deferred<void>();
    const secondStarted = deferred<void>(),
      exported = deferred<void>();
    const defaultDispatch = dispatch.getMockImplementation()!;
    const observations: string[] = [];
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type !== 'updateProject') return defaultDispatch(envelope);
      if (envelope.command.name === 'first') {
        await firstReply.promise;
        return acknowledge(envelope, patch('first', 'state-1'));
      }
      // This runs from the queue pump, before the first dispatch Promise resumes.
      observations.push(workbench.active!.name);
      secondStarted.resolve();
      await secondReply.promise;
      return acknowledge(envelope, patch('second', 'state-2'));
    });
    vi.mocked(transport.exportProject).mockImplementation(async () => {
      observations.push(workbench.active!.name);
      expect(workbench.active!.stateId).toBe(remote.current.stateId);
      exported.resolve();
      return encode(remote.current.stateId);
    });
    const save = vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: false });
    const first = workbench.dispatch({ type: 'updateProject', name: 'first' });
    const second = workbench.dispatch({ type: 'updateProject', name: 'second' });
    const saving = workbench.save();
    expect(transport.exportProject).not.toHaveBeenCalled();
    firstReply.resolve();
    await secondStarted.promise;
    expect(observations).toEqual(['first']);
    expect(transport.exportProject).not.toHaveBeenCalled();
    secondReply.resolve();
    await exported.promise;
    await Promise.all([first, second, saving]);
    expect(observations).toEqual(['first', 'second']);
    expect(decode(save.mock.calls[0][0])).toBe('state-2');
    expect(workbench.active!.savedStateId).toBe('state-2');
    expect(workbench.dirty(workbench.active!)).toBe(false);
  });

  it('serializes edits behind an in-flight export, then keeps later edits dirty while file writing finishes', async () => {
    const { workbench, remote, transport, dispatch, acknowledge } = await setup();
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateProject') {
        return acknowledge(
          envelope,
          patch(envelope.command.name!, envelope.command.name === 'before' ? 'state-1' : 'state-2'),
        );
      }
      return defaultDispatch(envelope);
    });
    await workbench.dispatch({ type: 'updateProject', name: 'before' });
    const exportStarted = deferred<void>(),
      finishExport = deferred<void>();
    const writeStarted = deferred<void>(),
      finishWrite = deferred<SaveResult>();
    vi.mocked(transport.exportProject).mockImplementation(async () => {
      const capturedState = remote.current.stateId;
      exportStarted.resolve();
      await finishExport.promise;
      return encode(capturedState);
    });
    const save = vi.spyOn(platform, 'save').mockImplementation(async () => {
      writeStarted.resolve();
      return finishWrite.promise;
    });
    const saving = workbench.save();
    await exportStarted.promise;
    const editing = workbench.dispatch({ type: 'updateProject', name: 'after' });
    await Promise.resolve();
    expect(dispatch.mock.calls.filter(([e]) => e.command.type === 'updateProject')).toHaveLength(1);
    expect(workbench.active!.name).toBe('before');
    finishExport.resolve();
    await writeStarted.promise;
    await editing;
    expect(decode(save.mock.calls[0][0])).toBe('state-1');
    expect(workbench.active!.name).toBe('after');
    expect(workbench.active!.savedStateId).toBe('state-0');
    finishWrite.resolve({ cancelled: false });
    await saving;
    const savedCommands = dispatch.mock.calls
      .map(([e]) => e.command)
      .filter((c) => c.type === 'markSaved');
    expect(savedCommands).toEqual([{ type: 'markSaved', stateId: 'state-1' }]);
    expect(workbench.active!.stateId).toBe('state-2');
    expect(workbench.active!.savedStateId).toBe('state-1');
    expect(workbench.dirty(workbench.active!)).toBe(true);
  });

  it('reports a CoreReply validation error without blocking a later valid command', async () => {
    const { workbench, dispatch, acknowledge } = await setup();
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateProject' && envelope.command.name === '') {
        return {
          commandId: envelope.commandId,
          eventRevision: 2,
          projectId: 'project',
          error: { code: 'required', message: 'Name is required', path: 'name' },
        };
      }
      return acknowledge(envelope, patch('valid', 'state-1'));
    });
    const invalid = workbench.dispatch({ type: 'updateProject', name: '' });
    const rejection = expect(invalid).rejects.toThrow('Name is required（name）');
    const valid = workbench.dispatch({ type: 'updateProject', name: 'valid' });
    await Promise.all([rejection, valid]);
    expect(workbench.active!.name).toBe('valid');
    expect(workbench.queue.blocked).toBe(false);
    expect(workbench.value.queueError).toBeNull();
    expect(workbench.value.pending).toBe(0);
  });

  it('retains an uncertain transport commit and retries the exact envelope before later commands', async () => {
    const { workbench, dispatch, acknowledge } = await setup();
    const interrupted = deferred<void>();
    let attempts = 0,
      commits = 0;
    let originalReply: Reply | undefined;
    const seen: Envelope[] = [];
    dispatch.mockImplementation(async (envelope) => {
      seen.push(envelope);
      if (envelope.command.type === 'updateProject' && envelope.command.name === 'first') {
        if (++attempts === 1) {
          commits += 1;
          originalReply = acknowledge(envelope, patch('first', 'state-1'));
          interrupted.resolve();
          throw new Error('IPC acknowledgement was lost');
        }
        return originalReply!;
      }
      return acknowledge(envelope, patch('later', 'state-2'));
    });
    const first = workbench.dispatch({ type: 'updateProject', name: 'first' });
    const later = workbench.dispatch({ type: 'updateProject', name: 'later' });
    await interrupted.promise;
    await vi.waitFor(() => expect(workbench.queue.blocked).toBe(true));
    expect(seen).toHaveLength(1);
    expect(workbench.active!.name).toBe('original');
    expect(workbench.value.queueError).toBe('IPC acknowledgement was lost');
    expect(workbench.value.pending).toBe(2);
    workbench.retry();
    await Promise.all([first, later]);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[1].commandId).toBe(seen[0].commandId);
    expect(seen.map((e) => (e.command.type === 'updateProject' ? e.command.name : ''))).toEqual([
      'first',
      'first',
      'later',
    ]);
    expect(commits).toBe(1);
    expect(workbench.active!.name).toBe('later');
    expect(workbench.queue.blocked).toBe(false);
    expect(workbench.value.queueError).toBeNull();
  });

  it('waits for the editor composition barrier before exporting', async () => {
    const { workbench, transport } = await setup();
    const compositionFinished = deferred<void>();
    workbench.editorBarrier = () => compositionFinished.promise;
    vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: false });
    const saving = workbench.save();
    await Promise.resolve();
    expect(transport.exportProject).not.toHaveBeenCalled();
    compositionFinished.resolve();
    await saving;
    expect(transport.exportProject).toHaveBeenCalledOnce();
  });

  it('leaves the queue usable after an export validation error and does not confirm cancelled writes', async () => {
    const { workbench, transport, dispatch, acknowledge } = await setup();
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) =>
      envelope.command.type === 'updateProject'
        ? acknowledge(envelope, patch('edited', 'state-1'))
        : defaultDispatch(envelope),
    );
    vi.mocked(transport.exportProject).mockRejectedValueOnce(
      new Error('Cannot export formatted ]'),
    );
    const save = vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: true });
    await expect(workbench.save()).rejects.toThrow('Cannot export formatted ]');
    expect(workbench.queue.blocked).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await workbench.dispatch({ type: 'updateProject', name: 'edited' });
    await workbench.save();
    expect(save).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls.some(([e]) => e.command.type === 'markSaved')).toBe(false);
    expect(workbench.active!.savedStateId).toBe('state-0');
    expect(workbench.dirty(workbench.active!)).toBe(true);
  });

  it('keeps BF dirty when LabelPlus is exported successfully', async () => {
    const { workbench, dispatch, acknowledge } = await setup();
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) =>
      envelope.command.type === 'updateProject'
        ? acknowledge(envelope, patch('edited', 'state-1'))
        : defaultDispatch(envelope),
    );
    await workbench.dispatch({ type: 'updateProject', name: 'edited' });
    const save = vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: false });
    await workbench.save(false, 'labelplus');
    expect(save.mock.calls[0][1].format).toBe('labelplus');
    expect(dispatch.mock.calls.some(([e]) => e.command.type === 'markSaved')).toBe(false);
    expect(workbench.dirty(workbench.active!)).toBe(true);
  });
});
