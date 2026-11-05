<script lang="ts">
  import AssistancePanel from './AssistancePanel.svelte';
  import PluginPanelContent from './PluginPanelContent.svelte';
  import type { Workbench } from '../runtime/workbench';
  import type { PluginManager } from '../runtime/plugins';
  import type { AssistanceService } from '../runtime/assistance';
  import { ASSISTANCE_TAB_ID, bottomPanelBounds } from '../runtime/preferences';

  let {
    workbench,
    plugins,
    assistance,
    open,
    height,
    selectedTab,
    viewportHeight,
    onselect,
    onresize,
    onheight,
  }: {
    workbench: Workbench;
    plugins: PluginManager;
    assistance: AssistanceService;
    open: boolean;
    height: number;
    selectedTab: string;
    viewportHeight: number;
    onselect(id: string): void;
    onresize(event: PointerEvent): void;
    onheight(height: number): void;
  } = $props();
  let assistancePanel = $state<AssistancePanel>();
  let visited = $state<string[]>([]);
  const pluginPanels = $derived(
    $plugins.panels.filter((panel) => panel.info.location === 'bottom'),
  );
  const tabs = $derived([
    { id: ASSISTANCE_TAB_ID, title: 'OCR 与机器翻译', owner: '内置工具' },
    ...pluginPanels.map((panel) => ({
      id: panel.id,
      title: panel.info.title,
      owner: $plugins.plugins.find((plugin) => plugin.manifest.id === panel.pluginId)?.manifest
        .name,
    })),
  ]);
  const bounds = $derived(bottomPanelBounds(viewportHeight));
  $effect(() => {
    const next = visited.filter((id) => pluginPanels.some((panel) => panel.id === id));
    if (
      open &&
      pluginPanels.some((panel) => panel.id === selectedTab) &&
      !next.includes(selectedTab)
    )
      next.push(selectedTab);
    if (next.length !== visited.length || next.some((id, index) => id !== visited[index]))
      visited = next;
  });
  export async function barrier() {
    await assistancePanel?.barrier();
  }
  function navigate(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    if (!target) return;
    const current = tabs.findIndex((tab) => tab.id === target.dataset.tabId);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case 'ArrowRight':
        next = (current + 1) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    onselect(tabs[next].id);
    document.getElementById(`bottom-tab-${tabs[next].id}`)?.focus();
  }
</script>

<section
  class="bottom-panel"
  aria-label="底部面板"
  data-bottom-panel
  hidden={!open}
  style:height={`${height}px`}
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The ARIA window splitter pattern uses a focusable separator with keyboard resizing.) -->
  <div
    class="splitter horizontal bottom-splitter"
    role="separator"
    aria-label="调整底部面板"
    aria-orientation="horizontal"
    aria-valuemin={bounds.min}
    aria-valuemax={bounds.max}
    aria-valuenow={height}
    tabindex="0"
    onpointerdown={onresize}
    onkeydown={(event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      onheight(
        event.key === 'Home'
          ? bounds.min
          : event.key === 'End'
            ? bounds.max
            : height + (event.key === 'ArrowUp' ? 16 : -16),
      );
    }}
  ></div>
  <div class="bottom-panel-heading">
    <div class="bottom-tabs" role="tablist" aria-label="底部面板页面">
      {#each tabs as tab (tab.id)}
        <button
          id={`bottom-tab-${tab.id}`}
          role="tab"
          data-tab-id={tab.id}
          aria-selected={selectedTab === tab.id}
          aria-controls={`bottom-content-${tab.id}`}
          tabindex={selectedTab === tab.id ? 0 : -1}
          title={`${tab.title} · ${tab.owner ?? ''}`}
          onkeydown={navigate}
          onclick={() => onselect(tab.id)}>{tab.title}</button
        >
      {/each}
    </div>
  </div>
  <div
    class="bottom-tab-content"
    id={`bottom-content-${ASSISTANCE_TAB_ID}`}
    role="tabpanel"
    aria-labelledby={`bottom-tab-${ASSISTANCE_TAB_ID}`}
    hidden={selectedTab !== ASSISTANCE_TAB_ID}
  >
    <AssistancePanel bind:this={assistancePanel} {workbench} {plugins} {assistance} />
  </div>
  {#each pluginPanels as panel (panel.id)}
    <div
      class="bottom-tab-content bottom-plugin-content"
      id={`bottom-content-${panel.id}`}
      role="tabpanel"
      aria-labelledby={`bottom-tab-${panel.id}`}
      hidden={selectedTab !== panel.id}
    >
      {#if visited.includes(panel.id)}
        <PluginPanelContent {plugins} pluginId={panel.pluginId} panelId={panel.info.id} />
      {/if}
    </div>
  {/each}
</section>
