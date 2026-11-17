<script lang="ts">
  import type { PluginCommandRun } from '../runtime/plugins/types';
  import { commandPending, commandStateLabel } from './CommandFeedback.svelte';
  import Icon from './Icon.svelte';

  let {
    run,
    pluginName,
    onview,
    ondismiss,
  }: {
    run: PluginCommandRun;
    pluginName: string;
    onview: () => void;
    ondismiss: () => void;
  } = $props();
  const description = $derived(
    run.state === 'completed'
      ? run.summary?.trim() || '执行完成'
      : run.state === 'failed' || run.state === 'interrupted'
        ? run.error || commandStateLabel(run.state)
        : commandStateLabel(run.state),
  );
</script>

<div class="plugin-command-notice" role="status" aria-live="polite" aria-atomic="true">
  {#if commandPending(run)}<span class="command-spinner" aria-hidden="true"></span>{/if}
  <div class="plugin-command-notice-text">
    <strong>{pluginName} · {run.title}</strong>
    <span>{description}</span>
  </div>
  <button onclick={onview}>查看结果</button>
  <button class="icon-button" aria-label="关闭命令提示" onclick={ondismiss}
    ><Icon name="close" size={16} /></button
  >
</div>
