import { get, writable } from 'svelte/store';
import { tick } from 'svelte';
import type {
  Command,
  Envelope,
  Geometry,
  HistoryMeta,
  ImageDocument,
  Marker,
  ProjectDocument,
  ProjectPatch,
  Reply,
  RichText,
} from '../generated/core';
import { createTransport, type CoreTransport } from './transports';
import { platform, type PickedFile } from './platform';
import { AssetStore, id } from './assets';
import { CommandQueue } from './queue';
import { snapshots } from './snapshots';

export type ProjectView = ProjectDocument &
  Omit<
    ProjectPatch,
    | 'upsertImages'
    | 'removedImageIds'
    | 'imageOrder'
    | 'id'
    | 'name'
    | 'sourceLanguage'
    | 'targetLanguage'
  >;
export interface PendingGeometry {
  projectId: string;
  imageId: string;
  markerId: string;
  geometry: Geometry;
  token: number;
}
export function pendingGeometriesForImage(
  pending: Record<string, PendingGeometry>,
  projectId: string,
  imageId: string,
): Record<string, Geometry> {
  return Object.fromEntries(
    Object.values(pending)
      .filter((entry) => entry.projectId === projectId && entry.imageId === imageId)
      .map((entry) => [entry.markerId, entry.geometry]),
  );
}
export interface ViewState {
  ready: boolean;
  projects: ProjectView[];
  activeId: string | null;
  imageId: string | null;
  markerId: string | null;
  pending: number;
  geometryPending: number;
  pendingGeometries: Record<string, PendingGeometry>;
  queueError: string | null;
  notice: string;
  progress: { done: number; total: number } | null;
  editorRestore: { version: number; bookmark: NonNullable<ProjectPatch['focus']> } | null;
  editorAutoFocus: boolean;
  recoveryDrafts: { id: string; projectId: string; imageId: string; marker: Marker }[];
}
export interface OpenDraft {
  document: ProjectDocument;
  warnings: string[];
  forceSaveAs: boolean;
  path?: string;
  format: 'bf' | 'labelplus';
  restored?: boolean;
}
const initial: ViewState = {
  ready: false,
  projects: [],
  activeId: null,
  imageId: null,
  markerId: null,
  pending: 0,
  geometryPending: 0,
  pendingGeometries: {},
  queueError: null,
  notice: '',
  progress: null,
  editorRestore: null,
  editorAutoFocus: true,
  recoveryDrafts: [],
};

export class Workbench {
  private readonly state = writable<ViewState>(initial);
  readonly subscribe = this.state.subscribe;
  readonly assets = new AssetStore();
  readonly transport: CoreTransport;
  readonly queue: CommandQueue;
  private readonly sessionId = id();
  private paths = new Map<string, string>();
  private selections = new Map<string, { imageId: string | null; markerId: string | null }>();
  private ownedAssets = new Map<string, Set<string>>();
  private lastSnapshot = new Map<string, { stateId: string; depth: number; time: number }>();
  private snapshotRunning = false;
  private snapshotRetryAfter = 0;
  private saves = new Map<string, Promise<void>>();
  private geometryTail: Promise<void> = Promise.resolve();
  private geometryToken = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  editorBarrier: (allowTransition?: boolean) => Promise<void> = async () => {};

  constructor(transport = createTransport()) {
    this.transport = transport;
    this.queue = new CommandQueue((pending, error) =>
      this.state.update((s) => ({
        ...s,
        pending,
        queueError: error ? message(error) : this.queue?.blocked ? s.queueError : null,
      })),
    );
  }
  get value() {
    return get(this.state);
  }
  get active() {
    return this.value.projects.find((p) => p.id === this.value.activeId);
  }
  get image() {
    return this.active?.images.find((i) => i.id === this.value.imageId);
  }
  get marker() {
    return this.image?.markers.find((m) => m.id === this.value.markerId);
  }
  dirty(project: ProjectView) {
    return project.stateId !== project.savedStateId;
  }
  notice(text: string) {
    this.state.update((s) => ({ ...s, notice: text }));
  }

  async initialize() {
    try {
      await this.transport.ready();
      this.state.update((s) => ({ ...s, ready: true }));
      this.timer = setInterval(() => {
        void this.maybeSnapshot();
      }, 1000);
    } catch (error) {
      this.notice(`启动失败：${message(error)}`);
    }
  }
  async dispatch(
    command: Command,
    history?: HistoryMeta,
    projectId = this.value.activeId,
  ): Promise<Reply> {
    // Capture immutable wire values now; Svelte's reactive proxies cannot cross a Worker boundary.
    const envelope: Envelope = JSON.parse(
      JSON.stringify({
        commandId: id(),
        sessionId: this.sessionId,
        ...(projectId ? { projectId } : {}),
        command,
        ...(history ? { history } : {}),
      }),
    );
    const reply = await this.queue.enqueue(async () => {
      const result = await this.transport.dispatch(envelope);
      if (result.patch)
        this.applyPatch(result.patch, command.type === 'undo' || command.type === 'redo');
      if (result.closedProjectId) this.removeView(result.closedProjectId);
      return result;
    });
    if (reply.error)
      throw new Error(`${reply.error.message}${reply.error.path ? `（${reply.error.path}）` : ''}`);
    return reply;
  }
  private applyPatch(patch: ProjectPatch, restore: boolean) {
    if (!this.lastSnapshot.has(patch.id))
      this.lastSnapshot.set(patch.id, { stateId: '', depth: 0, time: Date.now() });
    this.state.update((s) => {
      const previous = s.projects.find((p) => p.id === patch.id);
      const images = new Map(previous?.images.map((i) => [i.id, i]) ?? []);
      patch.removedImageIds.forEach((key) => images.delete(key));
      patch.upsertImages.forEach((image) => images.set(image.id, image));
      const { upsertImages: _, removedImageIds: __, imageOrder, ...meta } = patch;
      const project: ProjectView = { ...meta, images: imageOrder.map((key) => images.get(key)!) };
      const projects = previous
        ? s.projects.map((p) => (p.id === patch.id ? project : p))
        : [...s.projects, project];
      let imageId = s.imageId,
        markerId = s.markerId,
        editorRestore = s.editorRestore,
        editorAutoFocus = s.editorAutoFocus;
      if (s.activeId === project.id) {
        if (!project.images.some((i) => i.id === imageId)) {
          imageId = project.images[0]?.id ?? null;
          markerId = null;
        }
        if (!project.images.find((i) => i.id === imageId)?.markers.some((m) => m.id === markerId))
          markerId = null;
      }
      if (restore && patch.focus) {
        imageId = project.images.some((i) => i.id === patch.focus!.imageId)
          ? patch.focus.imageId
          : imageId;
        markerId = project.images
          .find((i) => i.id === imageId)
          ?.markers.some((m) => m.id === patch.focus!.markerId)
          ? patch.focus.markerId
          : null;
        editorAutoFocus = patch.focus.focusEditor !== false;
        editorRestore =
          editorAutoFocus && markerId
            ? { version: (editorRestore?.version ?? 0) + 1, bookmark: patch.focus }
            : null;
      }
      return { ...s, projects, imageId, markerId, editorRestore, editorAutoFocus };
    });
  }
  async barrier(allowTransition = false) {
    // Capture the tail at entry: edits registered later belong to a later action.
    const geometryTail = this.geometryTail;
    await geometryTail;
    await this.flushEditorAndQueue(allowTransition);
  }
  private async flushEditorAndQueue(allowTransition = false, projectId = this.value.activeId) {
    await this.editorBarrier(allowTransition);
    await this.queue.drain();
    if (projectId) await this.dispatch({ type: 'endGroup' }, undefined, projectId);
  }
  commitGeometry(
    projectId: string,
    imageId: string,
    markerId: string,
    geometry: Geometry,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('会话已经关闭'));
    const entry: PendingGeometry = {
      projectId,
      imageId,
      markerId,
      geometry: JSON.parse(JSON.stringify(geometry)),
      token: ++this.geometryToken,
    };
    const key = JSON.stringify([projectId, imageId, markerId]);
    // Register before returning to pointerup, so clearing the gesture preview is safe.
    this.state.update((s) => ({
      ...s,
      geometryPending: s.geometryPending + 1,
      pendingGeometries: { ...s.pendingGeometries, [key]: entry },
    }));
    const operation = this.geometryTail.then(async () => {
      try {
        if (this.disposed) throw new Error('会话已经关闭');
        // Never await the public barrier here: it would wait for this operation.
        // History may already own an editor transition while awaiting our tail.
        await this.flushEditorAndQueue(true, projectId);
        if (this.disposed) throw new Error('会话已经关闭');
        const focus = this.context(imageId, markerId);
        await this.dispatch(
          { type: 'updateMarker', imageId, markerId, geometry: entry.geometry },
          { label: '调整标记', before: focus, after: focus },
          projectId,
        );
      } finally {
        // dispatch applies its authoritative patch before resolving. Flush that
        // projection into components before removing the optimistic geometry.
        await tick();
        this.state.update((s) => {
          const pendingGeometries = { ...s.pendingGeometries };
          if (pendingGeometries[key]?.token === entry.token) delete pendingGeometries[key];
          return {
            ...s,
            geometryPending: Math.max(0, s.geometryPending - 1),
            pendingGeometries,
          };
        });
      }
    });
    // A definite rejection is reported to this caller but must not poison the
    // scheduler or every later navigation/save/close barrier. Uncertain transport
    // failures keep the queue's Promise pending until its same-ID retry succeeds.
    this.geometryTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async importImages(files: PickedFile[]) {
    try {
      return await this.assets.import(files, this.transport, (done, total) =>
        this.state.update((s) => ({ ...s, progress: { done, total } })),
      );
    } finally {
      this.state.update((s) => ({ ...s, progress: null }));
    }
  }
  async create(name: string, images: ImageDocument[]) {
    await this.barrier();
    const document: ProjectDocument = {
      id: id(),
      name: name.trim(),
      sourceLanguage: 'japanese',
      targetLanguage: 'simplifiedChinese',
      images,
    };
    await this.dispatch({ type: 'createProject', document, saved: false }, undefined, null);
    this.ownedAssets.set(document.id, new Set(images.map((i) => i.assetId)));
    this.activate(document.id);
  }
  async parseProject(picked: PickedFile): Promise<OpenDraft> {
    await this.barrier();
    const file = picked.file ?? (await platform.readFile(picked.path!)).file;
    const format = /\.bf$/i.test(file.name) ? 'bf' : 'labelplus';
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Parsing failures are user-facing format errors, not an uncertain engine commit.
    const result = await this.transport.importProject(bytes, format, id());
    return { ...result, path: picked.path, format };
  }
  async finishOpen(draft: OpenDraft) {
    await this.dispatch(
      {
        type: 'createProject',
        document: draft.document,
        saved: draft.format === 'bf' && !draft.restored,
      },
      undefined,
      null,
    );
    if (draft.path && !draft.forceSaveAs && draft.format === 'bf') {
      this.paths.set(draft.document.id, draft.path);
      await platform
        .rememberFile(draft.path)
        .catch((error) => this.notice(`项目已打开；最近文件记录失败：${message(error)}`));
    }
    this.ownedAssets.set(draft.document.id, new Set(draft.document.images.map((i) => i.assetId)));
    this.activate(draft.document.id);
  }
  async switchProject(projectId: string) {
    await this.barrier();
    this.activate(projectId);
  }
  private activate(projectId: string) {
    const old = this.value;
    if (old.activeId)
      this.selections.set(old.activeId, { imageId: old.imageId, markerId: old.markerId });
    const project = this.value.projects.find((p) => p.id === projectId)!;
    const previous = this.selections.get(projectId);
    this.state.update((s) => ({
      ...s,
      activeId: projectId,
      imageId: previous?.imageId ?? project.images[0]?.id ?? null,
      markerId: previous?.markerId ?? null,
      editorRestore: null,
    }));
  }
  async selectImage(imageId: string | null, markerId: string | null = null) {
    await this.barrier();
    this.state.update((s) => ({
      ...s,
      imageId,
      markerId,
      editorRestore: null,
      editorAutoFocus: true,
    }));
  }
  async selectMarker(markerId: string | null) {
    await this.barrier();
    this.state.update((s) => ({ ...s, markerId, editorRestore: null, editorAutoFocus: true }));
  }
  async navigateImage(delta: number) {
    const project = this.active;
    if (!project) return;
    const index = project.images.findIndex((i) => i.id === this.value.imageId);
    const image = project.images[index + delta];
    if (image) await this.selectImage(image.id);
  }
  async navigateMarker(delta: number) {
    const project = this.active,
      image = this.image;
    if (!project || !image || !this.value.markerId) return;
    const index = image.markers.findIndex((m) => m.id === this.value.markerId);
    const next = image.markers[index + delta];
    if (next) return this.selectMarker(next.id);
    const adjacent = project.images[project.images.indexOf(image) + delta];
    if (adjacent)
      await this.selectImage(
        adjacent.id,
        delta > 0 ? (adjacent.markers[0]?.id ?? null) : (adjacent.markers.at(-1)?.id ?? null),
      );
  }
  async addImages(images: ImageDocument[]) {
    await this.barrier();
    if (!this.active) return;
    const projectId = this.active.id;
    await this.dispatch({ type: 'addImages', images }, { label: '添加图片' });
    images.forEach((i) => this.ownedAssets.get(projectId)?.add(i.assetId));
    if (!this.value.imageId) await this.selectImage(images[0]?.id ?? null);
  }
  private context(imageId = this.value.imageId, markerId = this.value.markerId) {
    return imageId
      ? {
          imageId,
          markerId: markerId ?? '',
          anchor: 1,
          head: 1,
          storedMarks: [],
          focusEditor: false,
        }
      : undefined;
  }
  async documentCommand(command: Command, label: string, projectId = this.value.activeId) {
    const selectedImageId = this.value.imageId;
    const selectedMarkerId = this.value.markerId;
    const captured: Command = JSON.parse(JSON.stringify(command));
    await this.barrier();
    const project = this.value.projects.find((p) => p.id === projectId);
    const targetImage = 'imageId' in captured ? captured.imageId : selectedImageId;
    const targetMarker = 'markerId' in captured ? captured.markerId : selectedMarkerId;
    const before = this.context(targetImage, targetMarker);
    let after = before;
    if (captured.type === 'removeImage') {
      const images = project?.images ?? [],
        index = images.findIndex((i) => i.id === captured.imageId);
      after = this.context((images[index + 1] ?? images[index - 1])?.id ?? null, null);
    } else if (captured.type === 'removeMarker') {
      const markers = project?.images.find((i) => i.id === captured.imageId)?.markers ?? [],
        index = markers.findIndex((m) => m.id === captured.markerId);
      after = this.context(
        captured.imageId,
        (markers[index + 1] ?? markers[index - 1])?.id ?? null,
      );
    }
    return this.dispatch(captured, { label, before, after }, projectId);
  }
  async addMarker(geometry: Marker['geometry']) {
    await this.barrier();
    const image = this.image;
    if (!image) return;
    const marker: Marker = {
      id: id(),
      geometry,
      translation: { runs: [] },
      style: { overlayText: false, horizontal: false },
    };
    await this.dispatch(
      { type: 'addMarker', imageId: image.id, marker },
      { label: '添加标记', before: this.context(), after: this.context(image.id, marker.id) },
    );
    this.state.update((s) => ({ ...s, markerId: marker.id, editorAutoFocus: true }));
  }
  edit(imageId: string, markerId: string, translation: RichText, history: HistoryMeta) {
    void this.dispatch({ type: 'updateMarker', imageId, markerId, translation }, history).catch(
      (error) => this.notice(message(error)),
    );
  }
  async history(direction: 'undo' | 'redo') {
    await this.barrier(true);
    await this.dispatch({ type: direction });
  }
  async save(saveAs = false, format: 'bf' | 'labelplus' = 'bf') {
    const projectId = this.value.activeId;
    if (!projectId) return;
    const previous = this.saves.get(projectId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => this.saveProject(projectId, saveAs, format));
    this.saves.set(projectId, operation);
    try {
      await operation;
    } finally {
      if (this.saves.get(projectId) === operation) this.saves.delete(projectId);
    }
  }
  private async saveProject(projectId: string, saveAs: boolean, format: 'bf' | 'labelplus') {
    await this.barrier();
    const project = this.value.projects.find((p) => p.id === projectId);
    if (!project) return;
    const { bytes, stateId } = await this.exportSnapshot(project.id, format);
    const result = await platform.save(bytes, {
      suggestedName: `${project.name}${format === 'bf' ? '.bf' : '_labelplus.txt'}`,
      path: format === 'bf' ? this.paths.get(project.id) : undefined,
      saveAs,
      format,
    });
    if (result.cancelled) return;
    if (format === 'bf') {
      await this.dispatch({ type: 'markSaved', stateId }, undefined, project.id);
      if (result.path) {
        this.paths.set(project.id, result.path);
        await platform
          .rememberFile(result.path)
          .catch((error) => this.notice(`项目已保存；最近文件记录失败：${message(error)}`));
      }
    }
    this.notice(format === 'bf' ? '项目已保存' : '已导出 LabelPlus；矩形标记按上边中点导出');
  }
  private async exportSnapshot(projectId: string, format: 'bf' | 'labelplus', recovery = false) {
    const result = await this.queue.enqueue(async () => {
      const current = this.value.projects.find((p) => p.id === projectId)!;
      const document: ProjectDocument | undefined = recovery
        ? JSON.parse(
            JSON.stringify({
              id: current.id,
              name: current.name,
              sourceLanguage: current.sourceLanguage,
              targetLanguage: current.targetLanguage,
              images: current.images,
            }),
          )
        : undefined;
      try {
        return {
          bytes: await this.transport.exportProject(projectId, format),
          stateId: current.stateId,
          historyDepth: current.historyDepth,
          document,
          exportError: undefined as string | undefined,
        };
      } catch (error) {
        if (recovery)
          return {
            bytes: new Uint8Array(),
            stateId: current.stateId,
            historyDepth: current.historyDepth,
            document,
            exportError: message(error),
          };
        return { error: message(error) };
      }
    });
    if ('error' in result) throw new Error(result.error);
    return result;
  }
  async close(projectId = this.value.activeId): Promise<boolean> {
    if (!projectId) return true;
    await this.saves.get(projectId);
    await this.barrier();
    const project = this.value.projects.find((p) => p.id === projectId);
    if (!project) return true;
    if (this.dirty(project)) {
      const choice = await platform.confirmClose(project.name);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        await this.switchProject(projectId);
        await this.save();
        if (this.dirty(this.value.projects.find((p) => p.id === projectId)!)) return false;
      }
    }
    await this.dispatch({ type: 'closeProject' }, undefined, projectId);
    return true;
  }
  private removeView(projectId: string) {
    this.state.update((s) => {
      const projects = s.projects.filter((p) => p.id !== projectId);
      if (s.activeId !== projectId) return { ...s, projects };
      const activeId = s.activeId === projectId ? (projects.at(-1)?.id ?? null) : s.activeId;
      const imageId = projects.find((p) => p.id === activeId)?.images[0]?.id ?? null;
      return { ...s, projects, activeId, imageId, markerId: null, editorRestore: null };
    });
    this.ownedAssets.delete(projectId);
    this.paths.delete(projectId);
    this.selections.delete(projectId);
    this.assets.releaseExcept(new Set([...this.ownedAssets.values()].flatMap((set) => [...set])));
  }
  private async maybeSnapshot() {
    if (
      this.snapshotRunning ||
      this.queue.blocked ||
      !this.value.ready ||
      Date.now() < this.snapshotRetryAfter
    )
      return;
    const candidates = this.value.projects.filter((p) => {
      const last = this.lastSnapshot.get(p.id);
      return (
        this.dirty(p) &&
        last?.stateId !== p.stateId &&
        !!last &&
        (p.historyDepth - last.depth >= 20 || Date.now() - last.time >= 30_000)
      );
    });
    if (!candidates.length) return;
    this.snapshotRunning = true;
    try {
      await this.barrier();
      for (const project of candidates) {
        const current = this.value.projects.find((p) => p.id === project.id);
        if (!current) continue;
        const { bytes, stateId, historyDepth, document, exportError } = await this.exportSnapshot(
          current.id,
          'bf',
          true,
        );
        await snapshots.add(current.name, bytes, document, exportError);
        this.lastSnapshot.set(current.id, { stateId, depth: historyDepth, time: Date.now() });
      }
    } catch (error) {
      this.snapshotRetryAfter = Date.now() + 30_000;
      this.notice(`快照未保存：${message(error)}`);
    } finally {
      this.snapshotRunning = false;
    }
  }
  retry() {
    this.queue.retry();
  }
  retainDraft(projectId: string, imageId: string, marker: Marker) {
    const draft = JSON.parse(JSON.stringify({ id: id(), projectId, imageId, marker }));
    this.state.update((s) => ({ ...s, recoveryDrafts: [...s.recoveryDrafts, draft] }));
    this.notice('历史操作移除了正在编辑的对象，新输入已保留在恢复草稿中');
  }
  dismissDraft(draftId: string) {
    this.state.update((s) => ({
      ...s,
      recoveryDrafts: s.recoveryDrafts.filter((d) => d.id !== draftId),
    }));
  }
  async restoreDraft(draftId: string) {
    const draft = this.value.recoveryDrafts.find((d) => d.id === draftId);
    if (!draft) return;
    const project = this.value.projects.find((p) => p.id === draft.projectId);
    if (!project?.images.some((i) => i.id === draft.imageId)) {
      this.notice('请先恢复对应项目和图片，草稿文字仍可复制保留');
      return;
    }
    await this.switchProject(project.id);
    const marker = { ...draft.marker, id: id() };
    await this.documentCommand(
      { type: 'addMarker', imageId: draft.imageId, marker },
      '恢复输入草稿',
    );
    await this.selectImage(draft.imageId, marker.id);
    this.dismissDraft(draftId);
  }
  releaseStagedAssets() {
    this.assets.releaseExcept(new Set([...this.ownedAssets.values()].flatMap((set) => [...set])));
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.queue.dispose();
    this.assets.dispose();
    this.transport.dispose();
  }
}
export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String(error.message)
      : String(error);
}
