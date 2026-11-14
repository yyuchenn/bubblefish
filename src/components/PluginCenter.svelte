<script lang="ts">
  import { tick } from 'svelte';
  import type { PluginManager } from '../runtime/plugins';
  import type { JsonValue } from '../generated/plugins';
  import { message } from '../runtime/workbench';
  import CommandFeedback, { commandPending } from './CommandFeedback.svelte';
  let {
    plugins,
    onpanel,
    focusPluginId,
  }: { plugins: PluginManager; onpanel: () => void; focusPluginId?: string } = $props();
  let busy = $state(false),
    error = $state('');
  let pluginList = $state<HTMLDivElement>();
  $effect(() => {
    const requested = focusPluginId,
      list = pluginList;
    if (!requested || !list) return;
    void tick().then(() => {
      if (focusPluginId !== requested || !list.isConnected) return;
      const card = [...list.querySelectorAll<HTMLElement>('[data-plugin-id]')].find(
        (node) => node.dataset.pluginId === requested,
      );
      card?.scrollIntoView({ block: 'center' });
      card?.focus({ preventScroll: true });
    });
  });
  const states = {
    inactive: '未激活',
    activating: '激活中',
    active: '已激活',
    deactivating: '停用中',
    failed: '失败',
  };
  async function run(operation: () => Promise<unknown>) {
    busy = true;
    error = '';
    try {
      await operation();
    } catch (cause) {
      error = message(cause);
    } finally {
      busy = false;
    }
  }
  function configValue(event: Event, type: string): JsonValue {
    const input = event.currentTarget as HTMLInputElement;
    return type === 'boolean'
      ? input.checked
      : type === 'number'
        ? Number(input.value)
        : input.value;
  }
</script>

<div class="plugin-center">
  <p class="muted">安装本地插件包，为 OCR、翻译和自定义面板添加功能。</p>
  <label class="plugin-install button primary">
    安装插件包
    <input
      aria-label="安装插件包"
      type="file"
      accept=".zip,.bfplugin"
      disabled={busy}
      onchange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void run(() => plugins.install(file));
        event.currentTarget.value = '';
      }}
    />
  </label>
  {#if error}<p class="plugin-error" role="alert">{error}</p>{/if}
  <div class="plugin-list" bind:this={pluginList}>
    {#each $plugins.plugins as plugin (plugin.manifest.id)}
      {@const commandRun = $plugins.commandRuns.find(
        (entry) => entry.pluginId === plugin.manifest.id,
      )}
      <article
        class="plugin-card"
        aria-label={plugin.manifest.name}
        data-plugin-id={plugin.manifest.id}
        tabindex="-1"
      >
        <div class="plugin-card-heading">
          <div>
            <strong>{plugin.manifest.name}</strong><small
              >{plugin.manifest.version} · {plugin.manifest.id}</small
            >
          </div>
          <span class="panel-tag"
            >{plugin.state === 'deactivating'
              ? states[plugin.state]
              : plugin.enabled
                ? states[plugin.state]
                : '已停用'}</span
          >
        </div>
        {#if plugin.manifest.description}<p>{plugin.manifest.description}</p>{/if}
        {#if plugin.error}<p class="plugin-error" role="alert">{plugin.error}</p>{/if}
        {#if plugin.hooksState === 'paused'}
          <p class="plugin-error" role="alert">编辑检查已暂停：{plugin.hooksError}</p>
          <button
            disabled={busy}
            onclick={() => void run(() => plugins.resumeHooks(plugin.manifest.id))}
            >恢复编辑检查</button
          >
        {:else if plugin.hooksState === 'warming'}
          <p class="muted">正在准备编辑检查…</p>
        {:else if plugin.hooksState === 'ready'}
          <p class="muted">编辑检查已就绪</p>
        {/if}
        <div class="plugin-actions">
          <button
            disabled={busy || plugin.state === 'deactivating'}
            onclick={() =>
              void run(() =>
                plugin.enabled
                  ? plugins.disable(plugin.manifest.id)
                  : plugins.enable(plugin.manifest.id),
              )}>{plugin.enabled ? '停用' : '启用'}</button
          >
          <button disabled={busy} onclick={() => void run(() => plugins.remove(plugin.manifest.id))}
            >卸载</button
          >
          {#if plugin.backend}<span class="muted"
              >{plugin.backend === 'native' ? '原生进程' : 'Web Worker'}</span
            >{/if}
        </div>
        {#if plugin.enabled}
          {#each plugin.manifest.contributes?.configuration ?? [] as field}
            <label class="field-label plugin-config"
              >{field.label}
              {#if field.type === 'boolean'}
                <input
                  type="checkbox"
                  aria-label={`${plugin.manifest.name} ${field.label}`}
                  checked={Boolean(plugin.config[field.key] ?? field.default)}
                  onchange={(event) =>
                    void run(() =>
                      plugins.updateConfig(plugin.manifest.id, {
                        [field.key]: configValue(event, field.type),
                      }),
                    )}
                />
              {:else}
                <input
                  type={field.type === 'secret'
                    ? 'password'
                    : field.type === 'number'
                      ? 'number'
                      : 'text'}
                  aria-label={`${plugin.manifest.name} ${field.label}`}
                  value={String(plugin.config[field.key] ?? field.default ?? '')}
                  onchange={(event) => {
                    const value = configValue(event, field.type);
                    void run(() =>
                      plugins.updateConfig(plugin.manifest.id, { [field.key]: value }),
                    );
                  }}
                />
              {/if}
            </label>
          {/each}
          <div class="plugin-actions">
            {#each plugin.manifest.contributes?.commands ?? [] as command}<button
                aria-label={command.title}
                disabled={busy || commandPending(commandRun)}
                onclick={() =>
                  void plugins
                    .runUserCommand(`${plugin.manifest.id}/${command.id}`)
                    .catch(() => {})}
                >{command.title}{#if commandRun?.commandId === `${plugin.manifest.id}/${command.id}` && commandPending(commandRun)}
                  · {commandRun?.state === 'cancelling' ? '正在取消…' : '执行中…'}
                {/if}</button
              >{/each}
            {#each plugin.manifest.contributes?.panels ?? [] as panel}<button
                disabled={busy}
                onclick={() =>
                  void run(async () => {
                    await plugins.openPanel(plugin.manifest.id, panel.id);
                    onpanel();
                  })}>{panel.title}</button
              >{/each}
          </div>
        {/if}
        {#if commandRun}
          <CommandFeedback
            run={commandRun}
            oncancel={() => plugins.cancelUserCommand(commandRun.id)}
          />
        {/if}
      </article>
    {:else}<div class="panel-empty">
        <p>还没有安装插件</p>
        <small>示例插件与打包说明位于 examples/plugins。</small>
      </div>{/each}
  </div>
  {#if $plugins.tasks.some((task) => task.state === 'running')}
    <div class="plugin-tasks">
      <strong>运行中的任务</strong
      >{#each $plugins.tasks.filter((task) => task.state === 'running') as task}<div>
          <span>{task.providerId}</span><button onclick={() => plugins.cancelTask(task.id)}
            >取消任务</button
          >
        </div>{/each}
    </div>
  {/if}
  {#if $plugins.logs.length}
    <details class="plugin-logs">
      <summary>插件日志</summary>{#each $plugins.logs.slice(-30) as entry}<p>
          <small>{entry.pluginId} [{entry.level}]</small>
          {entry.message}
        </p>{/each}
    </details>
  {/if}
</div>
