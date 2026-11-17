import type { PluginContext } from '../../../src/plugin-sdk';

export async function activate(ctx: PluginContext) {
  const config = await ctx.config.get();
  if (config.failActivation) throw new Error('底部测试激活失败');
  let releaseTranslation: (() => void) | undefined;
  ctx.subscriptions.add(
    ctx.events.subscribe('config.changed', (changed) => {
      if (
        changed &&
        typeof changed === 'object' &&
        !Array.isArray(changed) &&
        !changed.holdTranslation
      )
        releaseTranslation?.();
    }),
  );
  ctx.ocr.register({ id: 'ocr', name: '底部测试 OCR' }, () => ({ text: '测试原文' }));
  ctx.translation.register({ id: 'translator', name: '底部测试翻译' }, async (input, task) => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.text !== 'string'
    )
      throw new Error('缺少测试原文');
    if ((await ctx.config.get()).holdTranslation) {
      task.progress({ message: '等待释放译文' });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          task.signal.removeEventListener('abort', cancel);
          releaseTranslation = undefined;
        };
        const cancel = () => {
          cleanup();
          reject(new DOMException('测试翻译已取消', 'AbortError'));
        };
        releaseTranslation = () => {
          cleanup();
          resolve();
        };
        task.signal.addEventListener('abort', cancel, { once: true });
        if (task.signal.aborted) cancel();
      });
    }
    return { text: `译文：${input.text}` };
  });
  ctx.commands.register('identity', () => ctx.pluginId);
  ctx.commands.register('open-notes', () => ctx.panels.open('notes').then(() => null));
  if (config.openOnActivate) await ctx.panels.open('notes');
}
