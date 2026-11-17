import type { PluginContext, PluginOperation } from '../../../src/plugin-sdk';
import type { PluginRichText } from '../../../src/generated/plugins';

const normalize = (value: string) =>
  value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
function richText(value: PluginRichText): PluginRichText {
  const runs = value.runs.map((run) => ({ ...run, text: normalize(run.text) }));
  // A modified RichText must be encoded from its runs, not an old imported raw representation.
  return runs.some((run, index) => run.text !== value.runs[index].text) ? { runs } : value;
}
function rewrite(operation: PluginOperation): PluginOperation {
  if (operation.type === 'translation.set')
    return {
      ...operation,
      value:
        typeof operation.value === 'string'
          ? normalize(operation.value)
          : richText(operation.value),
    };
  if (operation.type === 'marker.create')
    return {
      ...operation,
      marker: { ...operation.marker, translation: richText(operation.marker.translation) },
    };
  if (operation.type === 'marker.update' && operation.translation)
    return { ...operation, translation: richText(operation.translation) };
  if (operation.type === 'assistance.update') {
    const patch = { ...operation.patch };
    if (typeof patch.originalText === 'string') patch.originalText = normalize(patch.originalText);
    if (typeof patch.machineTranslation === 'string')
      patch.machineTranslation = normalize(patch.machineTranslation);
    return { ...operation, patch };
  }
  return operation;
}
function operationText(operation: PluginOperation): string[] {
  if (operation.type === 'translation.set')
    return [
      typeof operation.value === 'string'
        ? operation.value
        : operation.value.runs.map((run) => run.text).join(''),
    ];
  if (operation.type === 'marker.create')
    return [operation.marker.translation.runs.map((run) => run.text).join('')];
  if (operation.type === 'marker.update' && operation.translation)
    return [operation.translation.runs.map((run) => run.text).join('')];
  if (operation.type === 'assistance.update')
    return [operation.patch.originalText, operation.patch.machineTranslation].filter(
      (value): value is string => typeof value === 'string',
    );
  return [];
}
async function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Hook cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
  signal.throwIfAborted();
}

export function activate(ctx: PluginContext) {
  if (ctx.runtimeRole === 'hooks') {
    ctx.hooks.beforeCommit.register('normalize', async (proposal, task) => {
      const config = await ctx.config.get();
      const milliseconds = Math.min(5000, Math.max(0, Number(config.delayMs ?? 0)));
      if (milliseconds) await delay(milliseconds, task.signal);
      const operations = proposal.operations.map(rewrite);
      void ctx.log(`1. normalize (${proposal.transactionId})`).catch(() => {});
      return JSON.stringify(operations) === JSON.stringify(proposal.operations)
        ? { action: 'continue' }
        : { action: 'replace', operations };
    });
    ctx.hooks.beforeCommit.register('reject-block', (proposal) => {
      const blocked = proposal.operations
        .flatMap(operationText)
        .find((value) => value.includes('[BLOCK]'));
      void ctx.log(`2. reject-block (${proposal.transactionId})`).catch(() => {});
      return blocked === undefined
        ? { action: 'continue' }
        : { action: 'reject', reason: `规范化后命中 [BLOCK] 规则：${blocked.slice(0, 100)}` };
    });
    return;
  }
  ctx.translation.register(
    { id: 'guard-echo', name: '编辑检查：主实例示例翻译' },
    async (input, task) => {
      const value = input as { text?: unknown };
      if (typeof value?.text !== 'string') throw new Error('缺少待翻译原文');
      task.signal.throwIfAborted();
      task.progress({ completed: 1, total: 1 });
      return { text: `主实例译文：${value.text}` };
    },
  );
  ctx.commands.register('probe-main', async (_params, task) => {
    task?.signal.throwIfAborted();
    task?.summary('编辑检查插件主实例工作正常');
    return {
      runtimeRole: ctx.runtimeRole,
      provider: 'guard-echo',
      alive: true,
    };
  });
}
