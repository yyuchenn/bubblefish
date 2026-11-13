import type { CommandContext, PluginContext, ProviderContext } from '../../src/plugin-sdk';
import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import { MODEL, EXPECTED_TEXT, validateModel } from './model';

type Ort = typeof import('onnxruntime-web/wasm');
interface Processor {
  preprocess(bytes: Uint8Array): Float32Array;
  decode(ids: Int32Array): string;
  free(): void;
}
interface Shared {
  default(input: { module_or_path: ArrayBuffer }): Promise<unknown>;
  KhaProcessor: new (config: string, vocab: string) => Processor;
  argmax(values: Float32Array): number;
}
interface Loaded {
  ort: Ort;
  shared: Shared;
  processor: Processor;
  encoder: InferenceSession;
  decoder: InferenceSession;
  config: {
    preprocessor: { image_size: number[] };
    model: { decoder_start_token_id: number; eos_token_id: number; max_length: number };
  };
}
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const silent: ProviderContext = { signal: new AbortController().signal, progress() {} };
const silentCommand: CommandContext = { ...silent, summary() {} };
class Runtime {
  private loaded?: Loaded;
  private initializing?: Promise<Loaded>;
  private ort?: Promise<Ort>;
  private shared?: Promise<Shared>;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private stop = new AbortController();
  busy = false;
  constructor(private ctx: PluginContext) {}
  private check(task: ProviderContext) {
    task.signal.throwIfAborted();
    this.stop.signal.throwIfAborted();
    if (this.stopped) throw new Error('OCR 插件已停用');
  }
  private progress(
    task: ProviderContext,
    phase: string,
    message: string,
    completed?: number,
    total?: number,
  ) {
    task.progress({
      phase,
      message,
      ...(completed === undefined ? {} : { completed }),
      ...(total === undefined ? {} : { total }),
    });
  }
  private async loadOrt() {
    if (!this.ort)
      this.ort = (async () => {
        const entry = await this.ctx.resources.url(
          'vendor/ort/ort.wasm.min.mjs',
          'text/javascript',
        );
        const ort = (await import(/* @vite-ignore */ entry)) as Ort;
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = {
          mjs: await this.ctx.resources.url(
            'vendor/ort/ort-wasm-simd-threaded.mjs',
            'text/javascript',
          ),
          wasm: await this.ctx.resources.url(
            'vendor/ort/ort-wasm-simd-threaded.wasm',
            'application/wasm',
          ),
        };
        return ort;
      })().catch((error) => {
        this.ort = undefined;
        throw error;
      });
    return this.ort;
  }
  private async loadShared() {
    if (!this.shared)
      this.shared = (async () => {
        const entry = await this.ctx.resources.url('shared.js', 'text/javascript');
        const shared = (await import(/* @vite-ignore */ entry)) as Shared;
        await shared.default({ module_or_path: await this.ctx.resources.read('shared_bg.wasm') });
        return shared;
      })().catch((error) => {
        this.shared = undefined;
        throw error;
      });
    return this.shared;
  }
  private async initialize(task: ProviderContext): Promise<Loaded> {
    this.check(task);
    const installed = (await this.ctx.resources.local.list()).find((set) => set.id === MODEL.id);
    if (!installed) throw new Error('请先打开 Kha White OCR 模型管理，导入 .bfmodel 离线模型包');
    validateModel({ ...MODEL, files: installed.files });
    const strings = await Promise.all(
      ['config.json', 'vocab.txt'].map(async (path) =>
        new TextDecoder().decode(await this.ctx.resources.local.read({ id: MODEL.id, path })),
      ),
    );
    const config = JSON.parse(strings[0]) as Loaded['config'];
    const [ort, shared] = await Promise.all([this.loadOrt(), this.loadShared()]);
    const processor = new shared.KhaProcessor(strings[0], strings[1]);
    let encoder: InferenceSession | undefined, decoder: InferenceSession | undefined;
    try {
      this.check(task);
      this.progress(task, 'loading-encoder', '正在加载编码器（328 MiB）');
      encoder = await ort.InferenceSession.create(
        await this.ctx.resources.local.read({ id: MODEL.id, path: 'encoder.onnx' }),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
      );
      this.check(task);
      this.progress(task, 'loading-decoder', '正在加载解码器（112 MiB）');
      decoder = await ort.InferenceSession.create(
        await this.ctx.resources.local.read({ id: MODEL.id, path: 'decoder.onnx' }),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
      );
      this.check(task);
      return { ort, shared, processor, encoder, decoder, config };
    } catch (error) {
      processor.free();
      await encoder?.release();
      await decoder?.release();
      throw error;
    }
  }
  private async get(task: ProviderContext) {
    if (this.loaded) return this.loaded;
    if (!this.initializing)
      this.initializing = this.initialize(task)
        .then((loaded) => (this.loaded = loaded))
        .finally(() => {
          this.initializing = undefined;
        });
    return this.initializing;
  }
  async recognize(bytes: ArrayBuffer, task = silent) {
    const job = this.tail
      .catch(() => {})
      .then(async () => {
        this.check(task);
        this.busy = true;
        const started = performance.now();
        let hidden: Tensor | undefined;
        try {
          const loaded = await this.get(task),
            prepared = performance.now();
          this.check(task);
          this.progress(task, 'encoding', '正在编码图片');
          const pixels = loaded.processor.preprocess(new Uint8Array(bytes));
          const [width, height] = loaded.config.preprocessor.image_size;
          const input = new loaded.ort.Tensor('float32', pixels, [1, 3, height, width]);
          try {
            hidden = (await loaded.encoder.run({ pixel_values: input })).encoder_hidden_states;
          } finally {
            input.dispose();
          }
          const tokenIds = [loaded.config.model.decoder_start_token_id];
          for (let step = 0; step < loaded.config.model.max_length; step++) {
            await yieldTask();
            this.check(task);
            this.progress(task, 'decoding', `正在生成文字（已生成 ${step} 个 token）`, step);
            const ids = new loaded.ort.Tensor('int64', BigInt64Array.from(tokenIds.map(BigInt)), [
              1,
              tokenIds.length,
            ]);
            const mask = new loaded.ort.Tensor(
              'int64',
              new BigInt64Array(tokenIds.length).fill(1n),
              [1, tokenIds.length],
            );
            let outputs: InferenceSession.ReturnType | undefined;
            let next: number;
            try {
              outputs = await loaded.decoder.run({
                input_ids: ids,
                encoder_hidden_states: hidden,
                attention_mask: mask,
              });
              const logits = outputs.logits.data as Float32Array;
              next = loaded.shared.argmax(logits.subarray(logits.length - 6144));
            } finally {
              ids.dispose();
              mask.dispose();
              for (const tensor of Object.values(outputs ?? {})) tensor.dispose();
            }
            tokenIds.push(next!);
            this.check(task);
            if (next === loaded.config.model.eos_token_id) break;
          }
          const text = loaded.processor.decode(Int32Array.from(tokenIds.slice(1)));
          this.progress(task, 'completed', '识别完成', 1, 1);
          return {
            text,
            tokenIds,
            backend: 'web-wasm',
            timings: {
              loadMs: Math.round(prepared - started),
              inferenceMs: Math.round(performance.now() - prepared),
              totalMs: Math.round(performance.now() - started),
            },
          };
        } finally {
          hidden?.dispose();
          this.busy = false;
        }
      });
    this.tail = job;
    return job;
  }
  async status() {
    return {
      backend: 'web-wasm',
      ready: !!this.loaded,
      busy: this.busy,
      modelInstalled: (await this.ctx.resources.local.list()).some((set) => set.id === MODEL.id),
      modelId: MODEL.id,
    };
  }
  async reset(task?: ProviderContext) {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (task) this.check(task);
        const loaded = this.loaded;
        this.loaded = undefined;
        if (loaded) {
          await loaded.encoder.release();
          await loaded.decoder.release();
          loaded.processor.free();
        }
        task?.signal.throwIfAborted();
        return null;
      });
    this.tail = operation;
    return operation;
  }
  async dispose() {
    this.stopped = true;
    this.stop.abort();
    await this.reset();
  }
}
let runtime: Runtime | undefined;
export function activate(ctx: PluginContext) {
  if (ctx.runtimeRole !== 'main') return;
  const engine = (runtime = new Runtime(ctx));
  ctx.ocr.register(
    { id: 'kha-white-ocr', name: 'Kha White OCR（日文）', languages: ['ja'] },
    async (_input, bytes, task) => engine.recognize(bytes, task),
  );
  ctx.commands.register('model-status', async (_params, task = silentCommand) => {
    task.signal.throwIfAborted();
    task.progress({ phase: 'querying', message: '正在查询模型与推理会话状态' });
    const result = await engine.status();
    task.signal.throwIfAborted();
    task.summary(
      `${result.modelInstalled ? '模型已导入' : '尚未导入模型'} · Web WASM 后端 · ${result.ready ? '推理会话已就绪' : '推理会话未加载'}`,
    );
    return result;
  });
  ctx.commands.register('reset-model', async (_params, task = silentCommand) => {
    task.signal.throwIfAborted();
    task.progress({ phase: 'resetting', message: '正在释放推理会话' });
    const result = await engine.reset(task);
    task.signal.throwIfAborted();
    task.summary('推理会话已释放，下次识别时重新加载');
    return result;
  });
  ctx.commands.register('self-test', async (_params, task = silentCommand) => {
    task.signal.throwIfAborted();
    task.progress({ phase: 'preparing', message: '正在读取内置日文样例' });
    const sample = await ctx.resources.read('japanese-smoke.png');
    task.signal.throwIfAborted();
    const result = await engine.recognize(sample, task);
    task.signal.throwIfAborted();
    if (result.text !== EXPECTED_TEXT) throw new Error(`OCR 自检失败：识别文字与内置样例不符`);
    task.summary(`OCR 自检通过：${result.text}`);
    return { ...result, expected: EXPECTED_TEXT, passed: true };
  });
}
export async function deactivate() {
  await runtime?.dispose();
  runtime = undefined;
}
