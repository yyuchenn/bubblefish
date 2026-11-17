import type {
  PreparedSearchReplacement,
  SearchField,
  SearchMatch,
  SearchOptions,
  SearchWorkerReply,
  SearchWorkerRequest,
} from './search';

type WorkerRequest =
  | Omit<Extract<SearchWorkerRequest, { type: 'search' }>, 'id'>
  | Omit<Extract<SearchWorkerRequest, { type: 'replace' }>, 'id'>;

/** Each service owns one cancellable worker, separate from the document engine. */
export class SearchService {
  private sequence = 0;
  private pending?: { cancel(): void };
  private disposed = false;

  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL('./search-worker.ts', import.meta.url), {
        type: 'module',
        name: 'bubblefish-search',
      }),
    private readonly timeout = 2000,
  ) {}

  search(fields: SearchField[], options: SearchOptions): Promise<SearchMatch[]> {
    return this.request({ type: 'search', fields, options });
  }

  prepareReplacement(
    fields: SearchField[],
    options: SearchOptions,
    replacement: string,
    current?: SearchMatch,
  ): Promise<PreparedSearchReplacement> {
    return this.request({ type: 'replace', fields, options, replacement, current });
  }

  cancel() {
    this.pending?.cancel();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }

  private request<T>(request: WorkerRequest): Promise<T> {
    this.cancel();
    if (this.disposed) return Promise.reject(new Error('查找服务已关闭'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch (error) {
        reject(error);
        return;
      }
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, result?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.terminate();
        if (this.pending === pending) this.pending = undefined;
        if (error) reject(error);
        else resolve(result!);
      };
      const pending = {
        cancel: () => finish(new DOMException('查找已取消', 'AbortError')),
      };
      this.pending = pending;
      timer = setTimeout(() => finish(new Error('查找超时，请简化正则表达式')), this.timeout);
      worker.onmessage = ({ data }: MessageEvent<SearchWorkerReply>) => {
        if (data.id !== id) return;
        if (data.error !== undefined) finish(new Error(data.error));
        else finish(undefined, data.result as T);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error(event.message || '查找进程已停止'));
      };
      worker.onmessageerror = () => finish(new Error('查找进程返回无效数据'));
      try {
        worker.postMessage({ ...request, id });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
