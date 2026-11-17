import type { ProviderContext } from '../../src/plugin-sdk';
import { renderMessages, type DeepSeekConfig, type TranslationInput } from './config';

export const REQUEST_TIMEOUT_MS = 120_000;

class TranslationError extends Error {}

function httpError(status: number): TranslationError {
  const messages: Record<number, string> = {
    400: '翻译请求格式无效，请检查模型和请求模式',
    401: 'API Key 无效或已失效，请检查鉴权配置',
    402: 'API 账户余额不足，请检查账户余额',
    403: 'API 拒绝访问，请检查账户及模型权限',
    404: '找不到 API 地址或模型，请检查完整地址与模型名',
    408: 'API 请求超时，请稍后重试',
    413: '翻译输入过长，请减少原文长度',
    422: 'API 参数无效，请检查模型与请求模式',
    429: 'API 请求过于频繁或并发已满，请稍后重试',
    500: 'API 服务内部错误，请稍后重试',
    502: 'API 网关错误，请稍后重试',
    503: 'API 服务繁忙，请稍后重试',
    504: 'API 网关超时，请稍后重试',
  };
  return new TranslationError(`${messages[status] ?? 'API 请求失败'}（HTTP ${status}）`);
}

function translationText(value: unknown): string {
  const choices =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).choices
      : undefined;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  if (!first || typeof first !== 'object') throw new TranslationError('API 响应缺少翻译结果');
  const reasons: Record<string, string> = {
    length: '译文被长度限制截断，请减少原文长度或调整服务端输出限制',
    content_filter: 'API 内容过滤阻止了本次翻译',
    tool_calls: 'API 返回了工具调用，未生成可用译文',
    insufficient_system_resource: 'API 推理资源不足，翻译被中断，请稍后重试',
    aborted: 'API 中断了本次翻译，请重试',
  };
  const { finish_reason: reason, message } = first as Record<string, unknown>;
  if (reason !== 'stop')
    throw new TranslationError(
      typeof reason === 'string' && Object.hasOwn(reasons, reason)
        ? reasons[reason]
        : 'API 未正常完成翻译，结果未采用',
    );
  if (
    message &&
    typeof message === 'object' &&
    Array.isArray((message as Record<string, unknown>).tool_calls) &&
    ((message as Record<string, unknown>).tool_calls as unknown[]).length
  )
    throw new TranslationError('API 返回了工具调用，未生成可用译文');
  const content =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;
  if (typeof content !== 'string' || !content.trim())
    throw new TranslationError('API 未返回有效译文，请检查提示词和模型');
  return content.trim();
}

/** Owns the requests of one plugin activation. It never exposes upstream error bodies. */
export class DeepSeekClient {
  private stopped = false;
  private pending = new Set<AbortController>();
  private fetch: typeof globalThis.fetch;
  private timeoutMs: number;
  constructor(options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}) {
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }
  async translate(config: DeepSeekConfig, input: TranslationInput, task: ProviderContext) {
    if (this.stopped) throw new Error('DeepSeek 翻译插件已停用');
    if (task.signal.aborted) throw new DOMException('翻译已取消', 'AbortError');
    task.progress({ phase: 'preparing', message: '正在准备翻译请求' });
    const controller = new AbortController();
    this.pending.add(controller);
    let timedOut = false;
    const cancel = () => controller.abort();
    task.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new DOMException('翻译已取消', 'AbortError'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    if (task.signal.aborted || this.stopped) controller.abort();
    try {
      const request = async () => {
        controller.signal.throwIfAborted();
        task.progress({ phase: 'waiting', message: '正在等待翻译结果' });
        const response = await this.fetch(config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages: renderMessages(config, input),
            stream: false,
            ...(config.requestMode === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
          }),
          signal: controller.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw httpError(response.status);
        let result: unknown;
        try {
          result = await response.json();
        } catch {
          throw new TranslationError('API 返回的响应不是有效 JSON');
        }
        return translationText(result);
      };
      const text = await Promise.race([request(), aborted]);
      if (controller.signal.aborted) throw new DOMException('翻译已取消', 'AbortError');
      task.progress({ phase: 'completed', message: '翻译完成', completed: 1, total: 1 });
      return { text };
    } catch (error) {
      if (task.signal.aborted || this.stopped) throw new DOMException('翻译已取消', 'AbortError');
      if (timedOut) throw new Error('翻译请求超时（120 秒），请稍后重试');
      if (error instanceof TranslationError) throw error;
      throw new Error('无法连接翻译 API，请检查网络、HTTPS 地址及网关的跨域设置');
    } finally {
      clearTimeout(timer);
      task.signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', rejectAbort);
      this.pending.delete(controller);
    }
  }
  dispose() {
    this.stopped = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
