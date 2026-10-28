import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbench, pendingGeometriesForImage } from '../src/runtime/workbench';
import { platform } from '../src/runtime/platform';
import type { CoreTransport } from '../src/runtime/transports/types';
import type {
  Envelope,
  Geometry,
  HistoryMeta,
  ProjectDocument,
  ProjectPatch,
  Reply,
} from '../src/generated/core';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const a: Geometry = { type: 'point', x: 0.2, y: 0.3 };
const b: Geometry = { type: 'point', x: 0.45, y: 0.5 };
const c: Geometry = { type: 'point', x: 0.7, y: 0.65 };
function document(projectId: string): ProjectDocument {
  return {
    id: projectId,
    name: projectId,
    sourceLanguage: 'japanese',
    targetLanguage: 'simplifiedChinese',
    images: [
      {
        id: 'image',
        assetId: `${projectId}-asset`,
        filename: 'page.png',
        width: 600,
        height: 900,
        markers: [
          {
            id: 'marker',
            geometry: structuredClone(a),
            translation: { runs: [] },
            style: { overlayText: false, horizontal: false },
          },
        ],
      },
      {
        id: 'other-image',
        assetId: `${projectId}-other`,
        filename: 'other.png',
        width: 600,
        height: 900,
        markers: [],
      },
    ],
  };
}
type Snapshot = { document: ProjectDocument; stateId: string };
type HistoryEntry = { before: Snapshot; after: Snapshot; history?: HistoryMeta };
type Remote = Snapshot & { savedStateId?: string; undo: HistoryEntry[]; redo: HistoryEntry[] };
const instances: Workbench[] = [];
afterEach(() => {
  for (const workbench of instances.splice(0)) workbench.dispose();
  vi.restoreAllMocks();
});

async function setup(projectIds = ['project']) {
  const remotes = new Map<string, Remote>();
  let revision = 0,
    version = 0;
  const snapshot = (remote: Remote): Snapshot => ({
    document: structuredClone(remote.document),
    stateId: remote.stateId,
  });
  const patch = (remote: Remote): ProjectPatch => ({
    id: remote.document.id,
    name: remote.document.name,
    sourceLanguage: remote.document.sourceLanguage,
    targetLanguage: remote.document.targetLanguage,
    imageOrder: remote.document.images.map((image) => image.id),
    upsertImages: structuredClone(remote.document.images),
    removedImageIds: [],
    stateId: remote.stateId,
    savedStateId: remote.savedStateId,
    canUndo: remote.undo.length > 0,
    canRedo: remote.redo.length > 0,
    historyDepth: remote.undo.length,
  });
  const base = (envelope: Envelope): Reply => {
    const command = envelope.command;
    if (command.type === 'createProject') {
      remotes.set(command.document.id, {
        document: structuredClone(command.document),
        stateId: `${command.document.id}:0`,
        savedStateId: `${command.document.id}:0`,
        undo: [],
        redo: [],
      });
    }
    const projectId = command.type === 'createProject' ? command.document.id : envelope.projectId!;
    const remote = remotes.get(projectId)!;
    let focus;
    if (command.type === 'updateMarker' && command.geometry) {
      const before = snapshot(remote);
      remote.document.images
        .find((image) => image.id === command.imageId)!
        .markers.find((marker) => marker.id === command.markerId)!.geometry = structuredClone(
        command.geometry,
      );
      remote.stateId = `${projectId}:${++version}`;
      remote.undo.push({ before, after: snapshot(remote), history: envelope.history });
      remote.redo = [];
    } else if (command.type === 'updateProject') {
      if (command.name) remote.document.name = command.name;
      remote.stateId = `${projectId}:${++version}`;
    } else if (command.type === 'undo') {
      const entry = remote.undo.pop();
      if (entry) {
        remote.document = structuredClone(entry.before.document);
        remote.stateId = entry.before.stateId;
        remote.redo.push(entry);
        focus = entry.history?.before;
      }
    } else if (command.type === 'redo') {
      const entry = remote.redo.pop();
      if (entry) {
        remote.document = structuredClone(entry.after.document);
        remote.stateId = entry.after.stateId;
        remote.undo.push(entry);
        focus = entry.history?.after;
      }
    } else if (command.type === 'markSaved') remote.savedStateId = command.stateId;
    else if (command.type === 'closeProject') {
      remotes.delete(projectId);
      return {
        commandId: envelope.commandId,
        eventRevision: ++revision,
        closedProjectId: projectId,
      };
    }
    return {
      commandId: envelope.commandId,
      eventRevision: ++revision,
      projectId,
      patch: { ...patch(remote), ...(focus ? { focus } : {}) },
    };
  };
  const dispatch = vi.fn(async (envelope: Envelope) => base(envelope));
  const transport: CoreTransport = {
    ready: async () => {},
    dispatch,
    exportProject: vi.fn(async (projectId) =>
      new TextEncoder().encode(JSON.stringify(remotes.get(projectId)!.document)),
    ),
    importProject: async () => {
      throw Error('Unused import');
    },
    probeImage: async () => {
      throw Error('Unused probe');
    },
    dispose: vi.fn(),
  };
  const workbench = new Workbench(transport);
  instances.push(workbench);
  for (const projectId of projectIds)
    await workbench.finishOpen({
      document: document(projectId),
      warnings: [],
      forceSaveAs: false,
      format: 'bf',
    });
  await workbench.switchProject(projectIds[0]);
  dispatch.mockClear();
  return { workbench, dispatch, transport, remotes, base };
}
const geometry = (workbench: Workbench, projectId = 'project') =>
  workbench.value.projects.find((project) => project.id === projectId)!.images[0].markers[0]
    .geometry;
const pending = (workbench: Workbench, projectId = 'project') =>
  pendingGeometriesForImage(workbench.value.pendingGeometries, projectId, 'image').marker;

describe('Geometry commit handoff', () => {
  it('registers immediately, freezes input, and retains the target until its authoritative patch is published', async () => {
    const { workbench, dispatch, base } = await setup();
    const reply = deferred(),
      started = deferred();
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker') {
        started.resolve();
        await reply.promise;
      }
      return base(envelope);
    });
    const observations: { canonical: Geometry; overlay?: Geometry; count: number }[] = [];
    const unsubscribe = workbench.subscribe((state) =>
      observations.push({
        canonical: geometry(workbench),
        overlay: pending(workbench),
        count: state.geometryPending,
      }),
    );
    const input = structuredClone(b);
    const committing = workbench.commitGeometry('project', 'image', 'marker', input);
    input.x = 0.99;
    expect(workbench.value.geometryPending).toBe(1);
    expect(pending(workbench)).toEqual(b);
    expect(geometry(workbench)).toEqual(a);
    await started.promise;
    expect(pending(workbench)).toEqual(b);
    reply.resolve();
    await committing;
    expect(
      observations.some(
        (value) =>
          JSON.stringify(value.canonical) === JSON.stringify(b) &&
          value.count === 1 &&
          value.overlay?.x === b.x,
      ),
    ).toBe(true);
    expect(geometry(workbench)).toEqual(b);
    expect(pending(workbench)).toBeUndefined();
    expect(workbench.value.geometryPending).toBe(0);
    unsubscribe();
  });

  it('serializes rapid drags and an older ACK cannot clear the newer target; each drag remains undoable', async () => {
    const { workbench, dispatch, base } = await setup();
    const firstReply = deferred(),
      secondReply = deferred(),
      secondStarted = deferred();
    let updates = 0;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker') {
        if (++updates === 1) await firstReply.promise;
        else {
          secondStarted.resolve();
          await secondReply.promise;
        }
      }
      return base(envelope);
    });
    const first = workbench.commitGeometry('project', 'image', 'marker', b);
    const firstToken = Object.values(workbench.value.pendingGeometries)[0].token;
    const second = workbench.commitGeometry('project', 'image', 'marker', c);
    expect(Object.values(workbench.value.pendingGeometries)[0].token).toBeGreaterThan(firstToken);
    expect(pending(workbench)).toEqual(c);
    firstReply.resolve();
    await first;
    await secondStarted.promise;
    expect(geometry(workbench)).toEqual(b);
    expect(pending(workbench)).toEqual(c);
    expect(workbench.value.geometryPending).toBe(1);
    secondReply.resolve();
    await second;
    expect(geometry(workbench)).toEqual(c);
    expect(workbench.active!.historyDepth).toBe(2);
    await workbench.history('undo');
    expect(geometry(workbench)).toEqual(b);
    await workbench.history('undo');
    expect(geometry(workbench)).toEqual(a);
    await workbench.history('redo');
    expect(geometry(workbench)).toEqual(b);
    await workbench.history('redo');
    expect(geometry(workbench)).toEqual(c);
  });

  it('keeps an uncertain commit visible and retries the exact command ID once before releasing a save', async () => {
    const { workbench, dispatch, base, transport } = await setup();
    let recorded: Reply | undefined;
    const seen: Envelope[] = [];
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker') {
        seen.push(envelope);
        if (!recorded) {
          recorded = base(envelope);
          throw Error('ACK interrupted');
        }
        return recorded;
      }
      return base(envelope);
    });
    const save = vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: false });
    const committing = workbench.commitGeometry('project', 'image', 'marker', b);
    const saving = workbench.save();
    await vi.waitFor(() => expect(workbench.queue.blocked).toBe(true));
    expect(pending(workbench)).toEqual(b);
    expect(geometry(workbench)).toEqual(a);
    expect(transport.exportProject).not.toHaveBeenCalled();
    workbench.retry();
    await Promise.all([committing, saving]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(workbench.active!.historyDepth).toBe(1);
    expect(
      JSON.parse(new TextDecoder().decode(save.mock.calls[0][0])).images[0].markers[0].geometry,
    ).toEqual(b);
    expect(workbench.value.geometryPending).toBe(0);
  });

  it('rolls back a definite rejection and leaves the scheduler and later save usable', async () => {
    const { workbench, dispatch, base } = await setup();
    let reject = true;
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker' && reject) {
        reject = false;
        return {
          commandId: envelope.commandId,
          eventRevision: 1,
          error: { code: 'invalidGeometry', message: 'Geometry was rejected' },
        };
      }
      return base(envelope);
    });
    await expect(workbench.commitGeometry('project', 'image', 'marker', b)).rejects.toThrow(
      'Geometry was rejected',
    );
    expect(pending(workbench)).toBeUndefined();
    expect(geometry(workbench)).toEqual(a);
    expect(workbench.queue.blocked).toBe(false);
    await workbench.commitGeometry('project', 'image', 'marker', c);
    vi.spyOn(platform, 'save').mockResolvedValue({ cancelled: false });
    await workbench.save();
    expect(geometry(workbench)).toEqual(c);
    expect(workbench.value.geometryPending).toBe(0);
  });

  it('allows an already active editor history transition to flush geometry without waiting on itself', async () => {
    const { workbench, dispatch, base } = await setup();
    const transitionFinished = deferred(),
      reply = deferred(),
      started = deferred();
    const flags: boolean[] = [];
    workbench.editorBarrier = async (allowTransition) => {
      flags.push(!!allowTransition);
      if (!allowTransition) await transitionFinished.promise;
    };
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker') {
        started.resolve();
        await reply.promise;
      }
      return base(envelope);
    });
    const committing = workbench.commitGeometry('project', 'image', 'marker', b);
    const undoing = workbench.history('undo').finally(() => transitionFinished.resolve());
    await started.promise;
    expect(flags).toEqual([true]);
    reply.resolve();
    await Promise.all([committing, undoing]);
    expect(flags).toEqual([true, true]);
    expect(geometry(workbench)).toEqual(a);
    expect(workbench.value.geometryPending).toBe(0);
  });

  it.each(['navigation', 'close', 'switch'] as const)(
    'an immediate %s waits for the registered geometry tail',
    async (action) => {
      const { workbench, dispatch, base } = await setup(['project', 'second']);
      const reply = deferred(),
        started = deferred();
      const confirm = vi.spyOn(platform, 'confirmClose').mockResolvedValue('discard');
      dispatch.mockImplementation(async (envelope) => {
        if (envelope.command.type === 'updateMarker') {
          started.resolve();
          await reply.promise;
        }
        return base(envelope);
      });
      const committing = workbench.commitGeometry('project', 'image', 'marker', b);
      const subsequent =
        action === 'navigation'
          ? workbench.navigateImage(1)
          : action === 'close'
            ? workbench.close()
            : workbench.switchProject('second');
      await started.promise;
      expect(workbench.value.activeId).toBe('project');
      expect(workbench.value.imageId).toBe('image');
      expect(confirm).not.toHaveBeenCalled();
      reply.resolve();
      await Promise.all([committing, subsequent]);
      expect(workbench.value.geometryPending).toBe(0);
      if (action === 'navigation') expect(workbench.value.imageId).toBe('other-image');
      else expect(workbench.value.activeId).toBe('second');
    },
  );

  it('isolates matching image/marker IDs across projects and never redirects an inactive-project ACK', async () => {
    const { workbench, dispatch, base } = await setup(['project', 'second']);
    const firstReply = deferred(),
      firstStarted = deferred();
    dispatch.mockImplementation(async (envelope) => {
      if (envelope.command.type === 'updateMarker' && envelope.projectId === 'project') {
        firstStarted.resolve();
        await firstReply.promise;
      }
      return base(envelope);
    });
    const first = workbench.commitGeometry('project', 'image', 'marker', b);
    const second = workbench.commitGeometry('second', 'image', 'marker', c);
    expect(Object.keys(workbench.value.pendingGeometries)).toHaveLength(2);
    expect(pending(workbench, 'project')).toEqual(b);
    expect(pending(workbench, 'second')).toEqual(c);
    await firstStarted.promise;
    firstReply.resolve();
    await Promise.all([first, second]);
    expect(geometry(workbench, 'project')).toEqual(b);
    expect(geometry(workbench, 'second')).toEqual(c);
    expect(workbench.value.activeId).toBe('project');
    expect(workbench.value.imageId).toBe('image');
  });

  it('freezes document command project identity and payload before its editor barrier', async () => {
    const { workbench, dispatch, base } = await setup();
    const gate = deferred(),
      entered = deferred();
    workbench.editorBarrier = async () => {
      entered.resolve();
      await gate.promise;
    };
    const command = {
      type: 'updateMarker' as const,
      imageId: 'image',
      markerId: 'marker',
      geometry: structuredClone(b),
    };
    const editing = workbench.documentCommand(command, 'captured');
    await entered.promise;
    await workbench.finishOpen({
      document: document('second'),
      warnings: [],
      forceSaveAs: false,
      format: 'bf',
    });
    command.geometry.x = 0.99;
    dispatch.mockImplementation(async (envelope) => base(envelope));
    gate.resolve();
    await editing;
    const update = dispatch.mock.calls.find(
      ([envelope]) => envelope.command.type === 'updateMarker',
    )![0];
    expect(update.projectId).toBe('project');
    expect(geometry(workbench, 'project')).toEqual(b);
    expect(geometry(workbench, 'second')).toEqual(a);
    expect(workbench.value.activeId).toBe('second');
  });
});
