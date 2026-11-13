<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { PluginManager } from '../runtime/plugins';
  import { platform } from '../runtime/platform';
  import { message } from '../runtime/workbench';
  import type { PluginPanelAppearance } from '../generated/plugins';
  import { injectPanelTheme } from '../runtime/plugins/panel-theme-html';
  import { observePanelAppearance } from '../runtime/plugins/panel-appearance';
  let {
    plugins,
    pluginId,
    panelId,
  }: { plugins: PluginManager; pluginId: string; panelId: string } = $props();
  let html = $state<string | undefined>(),
    src = $state<string | undefined>(),
    error = $state(''),
    ready = $state(false);
  let frame = $state<HTMLIFrameElement>();
  let disconnect: (() => void) | undefined;
  let appearance: PluginPanelAppearance | undefined;
  let themePort: MessagePort | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false,
    loadEpoch = 0,
    connectionEpoch = 0;
  const panel = $derived(
    $plugins.panels.find((item) => item.pluginId === pluginId && item.info.id === panelId),
  );
  const plugin = $derived($plugins.plugins.find((item) => item.manifest.id === pluginId));
  function closeConnection() {
    connectionEpoch++;
    clearTimeout(timer);
    disconnect?.();
    disconnect = undefined;
    themePort?.close();
    themePort = undefined;
  }
  function failPanel(reason: string) {
    loadEpoch++;
    closeConnection();
    ready = false;
    html = src = undefined;
    error = reason;
  }
  $effect(() => {
    if (plugin?.state === 'failed') {
      const reason = plugin.error ?? '插件连接已中断，请重试加载';
      untrack(() => failPanel(reason));
    }
  });
  async function loadPanel() {
    const epoch = ++loadEpoch;
    closeConnection();
    ready = false;
    error = '';
    html = src = undefined;
    try {
      await plugins.preparePanel(pluginId, panelId);
      if (disposed || epoch !== loadEpoch) return;
      if (platform.desktop) {
        const { invoke } = await import('@tauri-apps/api/core');
        const url = await invoke<string>('plugin_panel_url', { pluginId, panelId });
        if (!disposed && epoch === loadEpoch) src = `${url}?appearance-load=${epoch}`;
      } else {
        const content = await plugins.getPanelHtml(pluginId, panelId);
        if (!disposed && epoch === loadEpoch) html = injectPanelTheme(content);
      }
    } catch (cause) {
      if (!disposed && epoch === loadEpoch) error = message(cause);
    }
  }
  onMount(() => {
    const unobserve = observePanelAppearance((value) => {
      appearance = value;
      themePort?.postMessage({ type: 'appearance', appearance: value });
    });
    if (plugins.value.plugins.find((item) => item.manifest.id === pluginId)?.state !== 'failed')
      void loadPanel();
    return () => {
      disposed = true;
      loadEpoch++;
      unobserve();
      closeConnection();
    };
  });
  function connect(event: Event) {
    if (disposed || event.currentTarget !== frame || !frame?.contentWindow || !appearance) return;
    closeConnection();
    ready = false;
    const epoch = connectionEpoch;
    const channel = new MessageChannel(),
      theme = new MessageChannel();
    try {
      disconnect = plugins.connectPanel(pluginId, channel.port1);
      themePort = theme.port1;
      theme.port1.onmessage = ({ data }) => {
        if (
          disposed ||
          epoch !== connectionEpoch ||
          data?.type !== 'appearance-ready' ||
          data.revision !== appearance?.revision
        )
          return;
        clearTimeout(timer);
        ready = true;
      };
      theme.port1.start();
      timer = setTimeout(() => {
        if (disposed || epoch !== connectionEpoch || ready) return;
        error = '插件面板主题初始化超时，请重试加载';
        closeConnection();
      }, 5000);
      frame.contentWindow.postMessage(
        {
          type: 'bubblefish:connect',
          apiVersion: 1,
          panelId,
          appearance,
        },
        '*',
        [channel.port2, theme.port2],
      );
    } catch (cause) {
      channel.port1.close();
      channel.port2.close();
      theme.port1.close();
      theme.port2.close();
      closeConnection();
      error = message(cause);
    }
  }
</script>

<div class="plugin-panel-content">
  {#if error}
    <div class="plugin-panel-load-error">
      <p role="alert">{error}</p>
      <button onclick={() => void loadPanel()}>重试加载</button>
    </div>
  {:else if html !== undefined || src}
    <div class="plugin-frame-shell" aria-busy={!ready}>
      {#if !ready}<p class="plugin-panel-loading" role="status">正在应用插件主题…</p>{/if}
      <iframe
        bind:this={frame}
        title={panel?.info.title ?? '插件面板'}
        sandbox="allow-scripts"
        class:plugin-theme-pending={!ready}
        aria-hidden={!ready}
        {src}
        srcdoc={html}
        onload={connect}
      ></iframe>
    </div>
  {:else}<p role="status">正在加载插件面板…</p>{/if}
</div>
