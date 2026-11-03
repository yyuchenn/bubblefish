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
    historyRevision: stateId === 'state-0' ? 0 : 1,
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
async function setup(document: ProjectDocument = original) {
  const remote = {
    current: {
      ...patch('original', 'state-0'),
      imageOrder: document.images.map((image) => image.id),
      upsertImages: structuredClone(document.images),
    },
    revision: 0,
  };
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
    document: structuredClone(document),
    warnings: [],
    forceSaveAs: false,
    format: 'bf',
  });
  return { workbench, remote, transport, dispatch, acknowledge };
}

describe('Workbench transaction boundaries', () => {
  it('prepares hooks outside the core queue, tracks pending work, and commits the rewritten proposal once', async () => {
    const { workbench, dispatch, acknowledge, transport } = await setup();
    const checked = deferred<void>(),
      finish = deferred<void>();
    const defaultDispatch = dispatch.getMockImplementation()!;
    transport.preview = vi.fn(async () => structuredClone(original));
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type !== 'batch') return defaultDispatch(envelope);
      expect(envelope.expectedStateId).toBe('state-0');
      expect(envelope.command.commands).toEqual([
        {
          type: 'updateProject',
          name: 'checked',
          sourceLanguage: undefined,
          targetLanguage: undefined,
        },
      ]);
      return acknowledge(envelope, patch('checked', 'state-1'));
    });
    workbench.mutations.intercept = vi.fn(async (proposal) => {
      expect(proposal.baseStateId).toBe('state-0');
      checked.resolve();
      await finish.promise;
      return [{ type: 'project.update' as const, name: 'checked' }];
    });
    const events = vi.fn();
    workbench.onDomainEvent = events;
    const editing = workbench.dispatch(
      { type: 'updateProject', name: 'unchecked' },
      { label: 'checked edit' },
    );
    await checked.promise;
    expect(workbench.value.pending).toBeGreaterThan(0);
    // Queries are free to use the queue while a hook is awaiting its own reads.
    await workbench.queue.enqueue(async () => expect(workbench.active!.name).toBe('original'));
    expect(dispatch.mock.calls.filter(([entry]) => entry.command.type === 'batch')).toHaveLength(0);
    finish.resolve();
    await editing;
    expect(workbench.active!.name).toBe('checked');
    expect(workbench.value.pending).toBe(0);
    expect(events.mock.calls.filter(([event]) => event === 'transaction.committed')).toHaveLength(
      1,
    );
  });

  it('rejects invalid proposals before hooks and recovers after a business rejection', async () => {
    const { workbench, transport, dispatch, acknowledge } = await setup();
    const intercept = vi.fn(async (proposal) => proposal.operations);
    workbench.mutations.intercept = intercept;
    transport.preview = vi.fn(async (_id, commands) => {
      if (commands[0].type === 'updateProject' && commands[0].name === '')
        throw new Error('Invalid project name');
      return structuredClone(original);
    });
    await expect(workbench.dispatch({ type: 'updateProject', name: '' })).rejects.toThrow(
      'Invalid project name',
    );
    expect(intercept).not.toHaveBeenCalled();
    intercept.mockRejectedValueOnce(new Error('Rule rejected this edit'));
    await expect(workbench.dispatch({ type: 'updateProject', name: 'blocked' })).rejects.toThrow(
      'Rule rejected',
    );
    dispatch.mockImplementation(async (envelope) =>
      acknowledge(envelope, patch('next', 'state-1')),
    );
    await workbench.dispatch({ type: 'updateProject', name: 'next' });
    expect(workbench.active!.name).toBe('next');
    expect(workbench.queue.blocked).toBe(false);
  });

  it('never reruns hooks or notifications when the same uncertain commit is retried', async () => {
    const { workbench, dispatch, acknowledge } = await setup();
    const intercept = vi.fn(async (proposal) => proposal.operations),
      events = vi.fn();
    workbench.mutations.intercept = intercept;
    workbench.onDomainEvent = events;
    let reply: Reply | undefined;
    dispatch.mockImplementation(async (envelope) => {
      if (!reply) {
        reply = acknowledge(envelope, patch('accepted', 'state-1'));
        throw new Error('Lost ACK');
      }
      return reply;
    });
    let alive = true;
    const editing = workbench.dispatch(
      { type: 'updateProject', name: 'accepted' },
      undefined,
      'project',
      undefined,
      { guard: () => alive },
    );
    await vi.waitFor(() => expect(workbench.queue.blocked).toBe(true));
    expect(events).not.toHaveBeenCalled();
    alive = false;
    workbench.retry();
    await editing;
    expect(intercept).toHaveBeenCalledOnce();
    expect(events.mock.calls.filter(([event]) => event === 'transaction.committed')).toHaveLength(
      1,
    );
  });

  it('isolates notification errors and excludes history, saving, and no-op replies from hooks', async () => {
    const { workbench, dispatch, acknowledge } = await setup();
    const intercept = vi.fn(async (proposal) => proposal.operations);
    workbench.mutations.intercept = intercept;
    dispatch.mockImplementation(async (envelope) =>
      acknowledge(
        envelope,
        patch('changed', envelope.command.type === 'undo' ? 'state-0' : 'state-1'),
      ),
    );
    workbench.onDomainEvent = () => {
      throw new Error('Faulty notification listener');
    };
    await workbench.dispatch({ type: 'updateProject', name: 'changed' });
    expect(workbench.queue.blocked).toBe(false);
    await workbench.dispatch({ type: 'undo' });
    await workbench.dispatch({ type: 'markSaved', stateId: 'state-0' });
    expect(intercept).toHaveBeenCalledTimes(1);
    expect(workbench.queue.blocked).toBe(false);
  });

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

const translationDocument = (): ProjectDocument => ({
  ...structuredClone(original),
  images: [
    {
      id: 'image',
      assetId: 'asset',
      filename: 'page.png',
      width: 100,
      height: 100,
      markers: ['selected', 'other'].map((id) => ({
        id,
        geometry: { type: 'point' as const, x: 0.5, y: 0.5 },
        translation: { runs: [{ text: `${id} original`, marks: [] }] },
        style: { overlayText: false, horizontal: false },
      })),
    },
  ],
});
type Context = Awaited<ReturnType<typeof setup>>;
function acknowledgeTranslation(context: Context, envelope: Envelope): Reply {
  const command = envelope.command;
  if (command.type !== 'updateMarker' || !command.translation)
    throw new Error('Expected translation');
  return context.acknowledge(envelope, {
    ...context.remote.current,
    stateId: `translation-${context.remote.revision}`,
    upsertImages: context.remote.current.upsertImages.map((image) =>
      image.id !== command.imageId
        ? image
        : {
            ...image,
            markers: image.markers.map((marker) =>
              marker.id !== command.markerId
                ? marker
                : {
                    ...marker,
                    translation: structuredClone(command.translation!),
                  },
            ),
          },
    ),
  });
}

describe('Workbench external translation replacement', () => {
  it('does not move the current selection when a plugin undoes a background project', async () => {
    const { workbench, dispatch, remote, acknowledge } = await setup(translationDocument());
    await workbench.selectImage('image', 'selected');
    dispatch.mockImplementation(async (envelope) => ({
      ...acknowledge(envelope),
      patch: {
        ...remote.current,
        id: 'background',
        imageOrder: ['background-image'],
        upsertImages: [{ ...translationDocument().images[0], id: 'background-image' }],
        focus: {
          imageId: 'background-image',
          markerId: 'other',
          anchor: 0,
          head: 0,
          storedMarks: [],
          focusEditor: true,
        },
      },
    }));
    await workbench.dispatch(
      {
        type: 'createProject',
        document: { ...translationDocument(), id: 'background' },
        saved: true,
      },
      undefined,
      null,
    );
    await workbench.dispatch({ type: 'undo' }, undefined, 'background');
    expect(workbench.value).toMatchObject({
      activeId: 'project',
      imageId: 'image',
      markerId: 'selected',
      editorRestore: null,
    });
  });

  it('uses the editor transition barrier and publishes content plus restore before the next queued operation', async () => {
    const context = await setup(translationDocument());
    const { workbench, dispatch, acknowledge, remote } = context;
    await workbench.selectImage('image', 'selected');
    const barrierEntered = deferred<void>(),
      finishBarrier = deferred<void>();
    const replacementSent = deferred<void>(),
      finishReplacement = deferred<void>();
    let transitioning = false;
    workbench.editorTransition = async (operation) => {
      transitioning = true;
      try {
        return await operation();
      } finally {
        transitioning = false;
      }
    };
    workbench.editorBarrier = async (allowTransition) => {
      expect(transitioning).toBe(true);
      expect(allowTransition).toBe(true);
      barrierEntered.resolve();
      await finishBarrier.promise;
    };
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker') {
        expect(transitioning).toBe(true);
        replacementSent.resolve();
        await finishReplacement.promise;
        return acknowledgeTranslation(context, envelope);
      }
      if (envelope.command.type === 'updateProject') {
        expect(workbench.marker!.translation.runs[0].text).toBe('machine suggestion');
        expect(workbench.value.editorRestore?.bookmark).toMatchObject({
          imageId: 'image',
          markerId: 'selected',
        });
        return acknowledge(envelope, { ...remote.current, name: 'after replacement' });
      }
      return defaultDispatch(envelope);
    });
    const replacing = workbench.replaceTranslation(
      'project',
      'image',
      'selected',
      { runs: [{ text: 'machine suggestion', marks: [] }] },
      '采用机器译文',
    );
    await barrierEntered.promise;
    expect(dispatch.mock.calls.some(([entry]) => entry.command.type === 'updateMarker')).toBe(
      false,
    );
    expect(workbench.value.editorRestore).toBeNull();
    finishBarrier.resolve();
    await replacementSent.promise;
    const next = workbench.dispatch({ type: 'updateProject', name: 'after replacement' });
    finishReplacement.resolve();
    await Promise.all([replacing, next]);
    expect(transitioning).toBe(false);
    const replacement = dispatch.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.command.type === 'updateMarker');
    expect(replacement).toHaveLength(1);
    expect(replacement[0].history).toMatchObject({
      label: '采用机器译文',
      before: { imageId: 'image', markerId: 'selected' },
      after: { imageId: 'image', markerId: 'selected' },
    });
    expect(replacement[0].history?.groupId).toBeUndefined();
  });

  it('updates a different marker without changing the current editor restore or selection', async () => {
    const context = await setup(translationDocument());
    const { workbench, dispatch } = context;
    await workbench.selectImage('image', 'selected');
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) =>
      envelope.command.type === 'updateMarker'
        ? acknowledgeTranslation(context, envelope)
        : defaultDispatch(envelope),
    );
    await workbench.replaceTranslation(
      'project',
      'image',
      'other',
      { runs: [{ text: 'background update', marks: [] }] },
      '插件修改译文',
    );
    expect(workbench.value.markerId).toBe('selected');
    expect(workbench.marker!.translation.runs[0].text).toBe('selected original');
    expect(
      workbench.image!.markers.find((marker) => marker.id === 'other')!.translation.runs[0].text,
    ).toBe('background update');
    expect(workbench.value.editorRestore).toBeNull();
  });

  it('keeps the transition and draft boundary open across an uncertain acknowledgement until exact-envelope retry', async () => {
    const context = await setup(translationDocument());
    const { workbench, dispatch } = context;
    await workbench.selectImage('image', 'selected');
    let transitioning = false;
    workbench.editorTransition = async (operation) => {
      transitioning = true;
      try {
        return await operation();
      } finally {
        transitioning = false;
      }
    };
    const seen: Envelope[] = [];
    let reply: Reply | undefined;
    const defaultDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type !== 'updateMarker') return defaultDispatch(envelope);
      seen.push(envelope);
      if (!reply) {
        reply = acknowledgeTranslation(context, envelope);
        throw new Error('Lost replacement acknowledgement');
      }
      return reply;
    });
    const replacing = workbench.replaceTranslation(
      'project',
      'image',
      'selected',
      { runs: [{ text: 'retained replacement', marks: [] }] },
      '采用机器译文',
    );
    await vi.waitFor(() => expect(workbench.queue.blocked).toBe(true));
    expect(transitioning).toBe(true);
    expect(workbench.value.editorRestore).toBeNull();
    expect(workbench.marker!.translation.runs[0].text).toBe('selected original');
    workbench.retry();
    await replacing;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(transitioning).toBe(false);
    expect(workbench.value.editorRestore?.version).toBe(1);
    expect(workbench.marker!.translation.runs[0].text).toBe('retained replacement');
  });

  it('does not publish a restore for a rejected replacement and permits the next replacement', async () => {
    const context = await setup(translationDocument());
    const { workbench, dispatch } = context;
    await workbench.selectImage('image', 'selected');
    const defaultDispatch = dispatch.getMockImplementation()!;
    let rejected = false;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type !== 'updateMarker') return defaultDispatch(envelope);
      if (!rejected) {
        rejected = true;
        return {
          commandId: envelope.commandId,
          eventRevision: 3,
          projectId: 'project',
          error: { code: 'markerNotFound', message: 'Marker was removed' },
        };
      }
      return acknowledgeTranslation(context, envelope);
    });
    await expect(
      workbench.replaceTranslation('project', 'image', 'selected', { runs: [] }, '插件修改译文'),
    ).rejects.toThrow('Marker was removed');
    expect(workbench.queue.blocked).toBe(false);
    expect(workbench.value.editorRestore).toBeNull();
    expect(workbench.marker!.translation.runs[0].text).toBe('selected original');
    await workbench.replaceTranslation(
      'project',
      'image',
      'selected',
      { runs: [{ text: 'next replacement', marks: [] }] },
      '插件修改译文',
    );
    expect(workbench.marker!.translation.runs[0].text).toBe('next replacement');
    expect(workbench.value.editorRestore?.version).toBe(1);
  });
});
