import type { PluginContext, CommandContext } from '../../../src/plugin-sdk';

const wait = (milliseconds: number, task?: CommandContext) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      task?.signal.removeEventListener('abort', abort);
      reject(new DOMException('测试命令已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      task?.signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    task?.signal.addEventListener('abort', abort, { once: true });
    if (task?.signal.aborted) abort();
  });

export function activate(ctx: PluginContext) {
  ctx.commands.register('status', (_params, task) => {
    task.summary('查询完成：测试模型已就绪');
    return { ready: true, pluginId: ctx.pluginId, text: '<script>unsafe()</script>' };
  });
  ctx.commands.register('empty', () => null);
  ctx.commands.register('false', () => false);
  ctx.commands.register('zero', () => 0);
  ctx.commands.register('text', () => '完整文字\n第二行');
  ctx.commands.register('failed-result', () => ({ passed: false, reason: '规则未通过' }));
  ctx.commands.register('delayed', async (_params, task) => {
    const { delayMs } = await ctx.config.get();
    for (let completed = 0; completed < 3; completed++) {
      task.signal.throwIfAborted();
      task.progress({ message: '正在执行分步测试', completed, total: 3 });
      await wait(Math.max(10, Number(delayMs) / 3), task);
    }
    task.summary('分步测试已完成');
    return { completed: 3 };
  });
  ctx.commands.register('indeterminate', async (_params, task) => {
    task.progress({ message: '正在等待服务响应', completed: -1, total: 0 });
    await wait(1500, task);
    return null;
  });
  ctx.commands.register('ignore-cancel', async (_params, task) => {
    task.progress({ message: '执行暂不响应取消的操作' });
    await wait(1500);
    task.summary('迟到的成功摘要');
    return { text: '迟到的命令结果' };
  });
  ctx.commands.register('error', () => {
    throw new Error('测试失败，请重试');
  });
  ctx.commands.register('summary-error', (_params, task) => {
    task.summary('这条成功摘要不应显示');
    throw new Error('操作在完成前失败');
  });
}
