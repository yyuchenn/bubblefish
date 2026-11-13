import { writable } from 'svelte/store';
import type { AssistanceUpdate, ImageDocument, Marker } from '../generated/core';
import type { PluginManager } from './plugins';
import { platform } from './platform';
import { id } from './assets';
import { message, type Workbench } from './workbench';

export function assistanceText(
  marker: Marker | undefined,
  key: 'originalText' | 'machineTranslation',
) {
  const cache = marker?.bunnyCache;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return '';
  return typeof cache[key] === 'string' ? cache[key] : '';
}

export function providerText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string')
    return result.text;
  throw new Error('插件返回的结果必须包含 text 字符串');
}

function originalValue(marker: Marker): string | null {
  const cache = marker.bunnyCache;
  return cache &&
    typeof cache === 'object' &&
    !Array.isArray(cache) &&
    typeof cache.originalText === 'string'
    ? cache.originalText
    : null;
}

export interface AssistanceRun {
  id: string;
  kind: 'ocr' | 'translation';
  projectId: string;
  total: number;
  done: number;
  state: 'running' | 'committing' | 'completed' | 'cancelled' | 'failed';
  errors: string[];
  applied: number;
  cancellable?: boolean;
}
interface Target {
  projectId: string;
  image: ImageDocument;
  marker: Marker;
  sourceLanguage: string;
  targetLanguage: string;
}

/** Long jobs run outside the document queue; only completed results enter history. */
export class AssistanceService {
  private readonly store = writable<AssistanceRun[]>([]);
  readonly subscribe = this.store.subscribe;
  private runs: AssistanceRun[] = [];
  private controllers = new Map<string, AbortController>();
  private latest = new Map<string, string>();
  private originalGroups = new Map<string, { id: string; time: number }>();
  private cropWorker?: Worker;
  private crops = new Map<
    string,
    {
      resolve: (value: { bytes: ArrayBuffer; width: number; height: number }) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly workbench: Workbench,
    private readonly plugins: PluginManager,
  ) {
    this.unsubscribe = workbench.subscribe((state) => {
      for (const run of this.runs)
        if (run.state === 'running' && !state.projects.some((p) => p.id === run.projectId))
          this.cancel(run.id);
    });
  }
  private publish() {
    this.store.set(this.runs.map((run) => ({ ...run, errors: [...run.errors] })));
  }
  cancel(runId: string) {
    const run = this.runs.find((entry) => entry.id === runId);
    if ((run?.state !== 'running' && run?.state !== 'committing') || run.cancellable === false)
      return;
    this.controllers.get(runId)?.abort();
    run.state = 'cancelled';
    this.publish();
  }
  cancelAll() {
    for (const run of this.runs) this.cancel(run.id);
  }
  private key(kind: string, target: Target) {
    return `${kind}/${target.projectId}/${target.image.id}/${target.marker.id}`;
  }
  private current(target: Target, kind: 'ocr' | 'translation', runId: string) {
    const project = this.workbench.value.projects.find((p) => p.id === target.projectId);
    const image = project?.images.find((i) => i.id === target.image.id);
    const marker = image?.markers.find((m) => m.id === target.marker.id);
    return (
      this.latest.get(this.key(kind, target)) === runId &&
      project &&
      image &&
      marker &&
      project.sourceLanguage === target.sourceLanguage &&
      (kind === 'ocr' || project.targetLanguage === target.targetLanguage) &&
      image.assetId === target.image.assetId &&
      (kind !== 'ocr' ||
        JSON.stringify(marker.geometry) === JSON.stringify(target.marker.geometry)) &&
      assistanceText(marker, 'originalText') === assistanceText(target.marker, 'originalText')
    );
  }
  private async crop(target: Target, signal: AbortSignal) {
    const asset = this.workbench.assets.get(target.image.assetId);
    if (!asset) throw new Error('无法取得标记原图');
    const file =
      asset.file ?? (asset.path ? (await platform.readFile(asset.path)).file : undefined);
    if (!file) throw new Error('图片尚未关联');
    signal.throwIfAborted();
    if (!this.cropWorker) {
      this.cropWorker = new Worker(new URL('./crop-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.cropWorker.onmessage = ({ data }) => {
        const pending = this.crops.get(data.id);
        if (!pending) return;
        this.crops.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data);
      };
      this.cropWorker.onerror = () => {
        for (const pending of this.crops.values()) pending.reject(new Error('图片裁剪进程已停止'));
        this.crops.clear();
        this.cropWorker?.terminate();
        this.cropWorker = undefined;
      };
    }
    const requestId = id();
    return new Promise<{ bytes: ArrayBuffer; width: number; height: number }>((resolve, reject) => {
      const aborted = () => {
        this.crops.delete(requestId);
        reject(new DOMException('已取消', 'AbortError'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      const finish = () => signal.removeEventListener('abort', aborted);
      this.crops.set(requestId, {
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      this.cropWorker!.postMessage({ id: requestId, file, geometry: target.marker.geometry });
    });
  }
  async run(kind: 'ocr' | 'translation', providerId: string, allOnPage = false) {
    await this.workbench.barrier();
    const project = this.workbench.active,
      image = this.workbench.image;
    if (!project || !image) throw new Error('请先打开项目并选择图片');
    const markers = allOnPage
      ? image.markers
      : image.markers.filter((m) => m.id === this.workbench.value.markerId);
    if (!markers.length) throw new Error('请先选择标记');
    const targets: Target[] = markers.map((marker) =>
      structuredClone({
        projectId: project.id,
        image: { ...image, markers: [] },
        marker,
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
      }),
    );
    const run: AssistanceRun = {
      id: id(),
      kind,
      projectId: project.id,
      total: targets.length,
      done: 0,
      state: 'running',
      errors: [],
      applied: 0,
    };
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.runs = [...this.runs.filter((r) => r.state === 'running').slice(-19), run];
    targets.forEach((target) => this.latest.set(this.key(kind, target), run.id));
    this.publish();
    const results: { target: Target; text: string }[] = [];
    try {
      for (const target of targets) {
        if (controller.signal.aborted) break;
        try {
          let result: unknown;
          if (kind === 'ocr') {
            const crop = await this.crop(target, controller.signal);
            result = await this.plugins.runOcr(
              providerId,
              {
                mimeType: 'image/png',
                width: crop.width,
                height: crop.height,
                sourceLanguage: target.sourceLanguage,
                options: {},
              },
              crop.bytes,
              { signal: controller.signal },
            );
          } else {
            const text = assistanceText(target.marker, 'originalText');
            if (!text.trim()) throw new Error('没有可翻译的原文，请先识别或输入原文');
            result = await this.plugins.translate(
              providerId,
              {
                text,
                sourceLanguage: target.sourceLanguage,
                targetLanguage: target.targetLanguage,
                options: {},
              },
              { signal: controller.signal },
            );
          }
          if (!controller.signal.aborted) results.push({ target, text: providerText(result) });
        } catch (error) {
          if (!controller.signal.aborted) run.errors.push(`${target.marker.id}: ${message(error)}`);
        }
        run.done++;
        this.publish();
      }
      controller.signal.throwIfAborted();
      // Flush UI edits before evaluating preconditions. The core verifies them again atomically.
      await this.workbench.barrier();
      controller.signal.throwIfAborted();
      const applicable = results.filter(({ target }) => this.current(target, kind, run.id));
      if (applicable.length !== results.length)
        run.errors.push('部分标记的输入已变化，已跳过过期结果');
      const updates: AssistanceUpdate[] = applicable.map(({ target, text }) => ({
        imageId: target.image.id,
        markerId: target.marker.id,
        ...(kind === 'ocr'
          ? { originalText: text, lastOcrModel: providerId }
          : { machineTranslation: text, lastTranslationService: providerId }),
        expected: {
          assetId: target.image.assetId,
          sourceLanguage: target.sourceLanguage,
          ...(kind === 'ocr'
            ? { geometry: target.marker.geometry }
            : { targetLanguage: target.targetLanguage }),
          originalText: originalValue(target.marker),
        },
      }));
      if (updates.length) {
        run.state = 'committing';
        this.publish();
        await this.workbench.documentCommand(
          { type: 'updateAssistance', updates },
          kind === 'ocr' ? '识别原文' : '机器翻译',
          project.id,
          {
            origin: { kind, pluginId: providerId.split('/')[0], causationId: run.id },
            guard: () => !controller.signal.aborted,
            onDispatch: () => {
              run.cancellable = false;
              this.publish();
            },
          },
        );
        run.applied = updates.length;
      }
      run.state = 'completed';
    } catch (error) {
      run.state = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted) run.errors.push(message(error));
    } finally {
      this.controllers.delete(run.id);
      for (const target of targets)
        if (this.latest.get(this.key(kind, target)) === run.id)
          this.latest.delete(this.key(kind, target));
      this.publish();
    }
    if (run.errors.length) this.workbench.notice(run.errors.join('；'));
    return run;
  }
  async editOriginal(projectId: string, imageId: string, markerId: string, text: string) {
    const key = `${projectId}/${imageId}/${markerId}`,
      now = Date.now();
    const previous = this.originalGroups.get(key);
    const group = previous && now - previous.time < 1000 ? previous.id : id();
    this.originalGroups.set(key, { id: group, time: now });
    // Enqueue on each input, so the existing save/navigation barrier includes it.
    await this.workbench.dispatch(
      { type: 'updateAssistance', updates: [{ imageId, markerId, originalText: text }] },
      { label: '编辑原文', groupId: group },
      projectId,
    );
    const marker = this.workbench.value.projects
      .find((project) => project.id === projectId)
      ?.images.find((image) => image.id === imageId)
      ?.markers.find((marker) => marker.id === markerId);
    return assistanceText(marker, 'originalText');
  }
  async adopt(projectId: string, imageId: string, marker: Marker) {
    await this.workbench.replaceTranslation(
      projectId,
      imageId,
      marker.id,
      { runs: [{ text: assistanceText(marker, 'machineTranslation'), marks: [] }] },
      '采用机器译文',
    );
  }
  dispose() {
    this.unsubscribe();
    for (const controller of this.controllers.values()) controller.abort();
    for (const pending of this.crops.values()) pending.reject(new Error('会话已关闭'));
    this.crops.clear();
    this.cropWorker?.terminate();
  }
}
