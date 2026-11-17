<script lang="ts">
  import type { PluginManager } from '../runtime/plugins';
  import PluginPanelContent from './PluginPanelContent.svelte';
  let {
    plugins,
    pluginId,
    panelId,
  }: { plugins: PluginManager; pluginId: string; panelId: string } = $props();
  const panel = $derived(
    $plugins.panels.find((item) => item.pluginId === pluginId && item.info.id === panelId),
  );
  function focusPanel(node: HTMLDivElement) {
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => node.querySelector<HTMLButtonElement>('button')?.focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = [...node.querySelectorAll<HTMLElement>('button,iframe')].filter(
        (element) => element.tabIndex >= 0 && getComputedStyle(element).visibility !== 'hidden',
      );
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    node.addEventListener('keydown', trap);
    return {
      destroy() {
        node.removeEventListener('keydown', trap);
        if (previous?.isConnected) previous.focus();
      },
    };
  }
</script>

<div class="modal-backdrop plugin-panel-backdrop" role="presentation">
  <div
    class="modal plugin-panel"
    role="dialog"
    aria-modal="true"
    aria-label={panel?.info.title ?? '插件面板'}
    tabindex="-1"
    use:focusPanel
    onkeydown={(event) => {
      if (event.key === 'Escape') plugins.closePanel();
    }}
  >
    <div class="modal-heading">
      <h2>{panel?.info.title ?? '插件面板'}</h2>
      <button aria-label="关闭插件面板" onclick={() => plugins.closePanel()}>关闭</button>
    </div>
    <PluginPanelContent {plugins} {pluginId} {panelId} />
  </div>
</div>
