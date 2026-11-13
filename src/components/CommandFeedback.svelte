<script module lang="ts">
  import type { PluginCommandRun } from '../runtime/plugins/types';

  export function commandPending(run: PluginCommandRun | undefined) {
    return !!run && ['queued', 'activating', 'running', 'cancelling'].includes(run.state);
  }

  export function commandStateLabel(state: PluginCommandRun['state']) {
    return {
      queued: '等待执行',
      activating: '正在激活',
      running: '执行中',
      cancelling: '正在取消',
      completed: '已完成',
      cancelled: '已取消',
      failed: '执行失败',
      interrupted: '执行中断',
    }[state];
  }
</script>

<script lang="ts">
  let { run, oncancel }: { run: PluginCommandRun; oncancel: () => void } = $props();
  const pending = $derived(commandPending(run));
  const progress = $derived(
    run.progress && typeof run.progress === 'object' && !Array.isArray(run.progress)
      ? run.progress
      : null,
  );
  const quantity = $derived.by(() => {
    const completed = progress?.completed,
      total = progress?.total;
    return typeof completed === 'number' &&
      typeof total === 'number' &&
      Number.isFinite(completed) &&
      Number.isFinite(total) &&
      completed >= 0 &&
      total > 0 &&
      completed <= total
      ? { completed, total }
      : null;
  });
  const description = $derived.by(() => {
    if (run.state === 'cancelling') return '正在取消，等待插件结束当前步骤…';
    if (run.state === 'completed') return run.summary?.trim() || '执行完成';
    if (run.state === 'failed') return run.error || '命令执行失败';
    if (run.state === 'interrupted') return run.error || '插件已停止，命令未完成';
    if (run.state === 'cancelled') return '已取消';
    if (typeof progress?.message === 'string' && progress.message.trim()) return progress.message;
    return run.state === 'queued'
      ? '等待当前操作完成…'
      : run.state === 'activating'
        ? '正在准备插件…'
        : '正在执行命令…';
  });
  const resultText = $derived.by(() => {
    if (run.result === undefined) return '无返回值';
    if (typeof run.result === 'string') return run.result || '""';
    try {
      return JSON.stringify(run.result, null, 2);
    } catch {
      return '返回数据无法显示';
    }
  });
</script>

<section
  class="plugin-command-feedback"
  class:command-failed={run.state === 'failed' || run.state === 'interrupted'}
  data-state={run.state}
  aria-label={`${run.title} 执行结果`}
>
  <div class="plugin-command-heading">
    <strong>{run.title}</strong>
    <span class="plugin-command-state">
      {#if pending}<span class="command-spinner" aria-hidden="true"></span>{/if}
      {commandStateLabel(run.state)}
    </span>
  </div>
  <p
    class="plugin-command-description"
    role={run.state === 'failed' || run.state === 'interrupted' ? 'alert' : 'status'}
    aria-live={run.state === 'failed' || run.state === 'interrupted' ? 'assertive' : 'polite'}
    aria-atomic="true"
  >
    {description}
  </p>
  {#if pending}
    <div class="plugin-command-progress">
      {#if quantity && run.state !== 'cancelling'}
        <progress
          aria-label={`${run.title} 执行进度`}
          max={quantity.total}
          value={quantity.completed}
        ></progress>
        <span class="muted">{Math.floor((quantity.completed / quantity.total) * 100)}%</span>
      {:else}
        <div class="command-progress-track" role="progressbar" aria-label={`${run.title} 执行进度`}>
          <span></span>
        </div>
      {/if}
      <button aria-label="取消命令" disabled={run.state === 'cancelling'} onclick={oncancel}
        >{run.state === 'cancelling' ? '正在取消…' : '取消命令'}</button
      >
    </div>
    {#if run.state === 'cancelling'}
      <p class="muted plugin-command-cancel-hint">若长时间未结束，可以停用插件。</p>
    {/if}
  {:else if run.state === 'completed'}
    <details class="plugin-command-details">
      <summary>数据详情</summary>
      <pre>{resultText}</pre>
    </details>
  {/if}
</section>
