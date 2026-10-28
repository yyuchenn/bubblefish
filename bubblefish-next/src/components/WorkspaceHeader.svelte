<script lang="ts">
  import type { Workbench } from '../runtime/workbench';
  import { platform, type WindowChromeState } from '../runtime/platform';
  import { usePopups, type PopupId } from '../runtime/popups';
  import Icon from './Icon.svelte';

  interface Props {
    workbench: Workbench;
    recent: string[];
    onaction(name: string): void;
    onnew(): void;
    onopen(): void;
    onproject(id: string): void;
    onclose(id: string): void;
    onlefttoggle(): void;
    onrighttoggle(): void;
    leftOpen: boolean;
    rightOpen: boolean;
    onzoom(mode: 'fit' | 'width' | 'height'): void;
    onsettings(): void;
    chrome?: WindowChromeState | null;
    onminimize?(): void;
    onmaximize?(): void;
    onquit?(): void;
  }

  let {
    workbench,
    recent,
    onaction,
    onnew,
    onopen,
    onproject,
    onclose,
    onlefttoggle,
    onrighttoggle,
    leftOpen,
    rightOpen,
    onzoom,
    onsettings,
    chrome = null,
    onminimize = () => {},
    onmaximize = () => {},
    onquit = () => onaction('app.quit'),
  }: Props = $props();

  const project = $derived($workbench.projects.find((item) => item.id === $workbench.activeId));
  const compact = $derived(chrome?.platform === 'windows' || chrome?.platform === 'macos');
  const macChrome = $derived(chrome?.platform === 'macos');
  const windowsChrome = $derived(chrome?.platform === 'windows');
  const desktop = $derived(chrome !== null || platform.desktop);
  const mac = $derived(chrome ? macChrome : /Mac|iPhone|iPad/.test(navigator.platform));
  const mod = $derived(mac ? '⌘' : 'Ctrl+');
  const newShortcut = $derived(`${mod}${desktop ? '' : mac ? '⌥' : 'Alt+'}N`);
  const basename = (path: string) => path.split(/[/\\]/).pop() || path;
  const popups = usePopups();
  function disclose(event: MouseEvent, id: PopupId) {
    event.preventDefault();
    popups.toggle({ id, trigger: event.currentTarget as HTMLElement });
  }
  function choose(operation: () => void) {
    popups.close('action');
    operation();
  }
</script>

<header
  class="titlebar"
  class:native-titlebar={compact}
  class:windows-titlebar={windowsChrome}
  class:macos-titlebar={macChrome}
  class:window-unfocused={chrome?.focused === false}
  class:window-fullscreen={chrome?.fullscreen === true}
  data-tauri-drag-region={chrome ? 'deep' : undefined}
>
  {#if macChrome}
    <div class="native-traffic-spacer" data-tauri-drag-region="deep" aria-hidden="true"></div>
  {:else if !compact}
    <div class="brand">
      <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="Bubblefish" />
      <span>Bubblefish <small>Next</small></span>
    </div>
  {/if}
  {#if !macChrome}
    <nav class="menu-bar" aria-label="主菜单" data-tauri-drag-region={chrome ? 'false' : undefined}>
      <details class="app-menu" open={$popups?.id === 'file'} use:popups.boundary={{ id: 'file' }}>
        <summary data-popup-trigger onclick={(event) => disclose(event, 'file')}>文件</summary>
        <div class="menu-popover">
          <button onclick={() => choose(onnew)}>新建项目 <kbd>{newShortcut}</kbd></button>
          <button onclick={() => choose(onopen)}>打开项目 <kbd>{mod}O</kbd></button>
          {#if recent.length}
            <div class="menu-label">最近文件</div>
            {#each recent as path}
              <button
                title={path}
                onclick={() => choose(() => onaction(`app.openRecent:${encodeURIComponent(path)}`))}
                >{basename(path)}</button
              >
            {/each}
            <hr />
          {/if}
          <button disabled={!project} onclick={() => choose(() => onaction('app.save'))}
            >保存 <kbd>{mod}S</kbd></button
          >
          <button disabled={!project} onclick={() => choose(() => onaction('app.saveAs'))}
            >另存为 <kbd>{mod}Shift+S</kbd></button
          >
          <button disabled={!project} onclick={() => choose(() => onaction('app.exportLabelplus'))}
            >导出 LabelPlus…</button
          >
          <hr />
          <button disabled={!project} onclick={() => choose(() => onaction('app.closeCurrent'))}
            >关闭项目</button
          >
        </div>
      </details>
      <details class="app-menu" open={$popups?.id === 'edit'} use:popups.boundary={{ id: 'edit' }}>
        <summary data-popup-trigger onclick={(event) => disclose(event, 'edit')}>编辑</summary>
        <div class="menu-popover">
          <button disabled={!project?.canUndo} onclick={() => choose(() => onaction('app.undo'))}
            >撤销{project?.undoLabel ?? ''}<kbd>{mod}Z</kbd></button
          >
          <button disabled={!project?.canRedo} onclick={() => choose(() => onaction('app.redo'))}
            >重做{project?.redoLabel ?? ''}<kbd>{mod}Shift+Z</kbd></button
          >
        </div>
      </details>
      <details class="app-menu" open={$popups?.id === 'view'} use:popups.boundary={{ id: 'view' }}>
        <summary data-popup-trigger onclick={(event) => disclose(event, 'view')}>视图</summary>
        <div class="menu-popover">
          <button onclick={() => choose(onlefttoggle)}>{leftOpen ? '隐藏' : '显示'}左侧面板</button>
          <button onclick={() => choose(onrighttoggle)}
            >{rightOpen ? '隐藏' : '显示'}翻译面板</button
          >
          <hr />
          <button onclick={() => choose(() => onzoom('fit'))}>适合屏幕</button>
          <button onclick={() => choose(() => onzoom('width'))}>适合宽度</button>
          <button onclick={() => choose(() => onzoom('height'))}>适合高度</button>
        </div>
      </details>
      <details class="app-menu" open={$popups?.id === 'more'} use:popups.boundary={{ id: 'more' }}>
        <summary data-popup-trigger onclick={(event) => disclose(event, 'more')}>更多</summary>
        <div class="menu-popover">
          <button onclick={() => choose(() => onaction('app.snapshots'))}>快照</button>
          <button onclick={() => choose(onsettings)}>设置与外观</button>
        </div>
      </details>
    </nav>
  {/if}
  <details
    class="project-switcher"
    open={$popups?.id === 'projects'}
    use:popups.boundary={{ id: 'projects' }}
    data-tauri-drag-region={chrome ? 'false' : undefined}
  >
    <summary
      data-popup-trigger
      title={project?.name}
      onclick={(event) => disclose(event, 'projects')}
    >
      <span class="project-dot"></span>
      <span class="project-title"
        >{project?.name ?? (compact ? 'Bubblefish Next' : '开始新的翻译')}{!compact &&
        project &&
        workbench.dirty(project)
          ? ' *'
          : ''}</span
      >
      {#if compact && project && workbench.dirty(project)}<span
          class="project-unsaved"
          aria-label="未保存">[*]</span
        >{/if}
      <Icon name="down" size={14} />
    </summary>
    <div class="menu-popover project-popover">
      {#each $workbench.projects as item}
        <div class="project-option">
          <button onclick={() => choose(() => onproject(item.id))}
            >{item.id === project?.id ? '✓ ' : ''}{item.name}{workbench.dirty(item)
              ? compact
                ? ' [*]'
                : ' *'
              : ''}</button
          >
          <button aria-label={`关闭 ${item.name}`} onclick={() => choose(() => onclose(item.id))}
            ><Icon name="close" size={14} /></button
          >
        </div>
      {/each}
      <hr />
      <button onclick={() => choose(onnew)}><Icon name="plus" />新建项目</button>
    </div>
  </details>
  {#if compact}
    <div class="native-titlebar-actions" data-tauri-drag-region="false">
      <div class="native-pane-controls" data-tauri-drag-region="false">
        <button
          class="native-pane-button"
          aria-label={`${leftOpen ? '隐藏' : '显示'}左侧面板`}
          title={`${leftOpen ? '隐藏' : '显示'}左侧面板`}
          aria-pressed={leftOpen}
          onclick={() => choose(onlefttoggle)}><Icon name="pane-left" size={16} /></button
        >
        <button
          class="native-pane-button"
          aria-label={`${rightOpen ? '隐藏' : '显示'}翻译面板`}
          title={`${rightOpen ? '隐藏' : '显示'}翻译面板`}
          aria-pressed={rightOpen}
          onclick={() => choose(onrighttoggle)}><Icon name="pane-right" size={16} /></button
        >
      </div>
      {#if windowsChrome}
        <div class="native-window-controls" data-tauri-drag-region="false">
          <button
            class="window-control"
            aria-label="最小化窗口"
            title="最小化窗口"
            onclick={() => choose(onminimize)}><Icon name="window-minimize" size={16} /></button
          >
          <button
            class="window-control"
            aria-label={chrome?.maximized ? '还原窗口' : '最大化窗口'}
            title={chrome?.maximized ? '还原窗口' : '最大化窗口'}
            onclick={() => choose(onmaximize)}
            ><Icon
              name={chrome?.maximized ? 'window-restore' : 'window-maximize'}
              size={16}
            /></button
          >
          <button
            class="window-control window-close"
            aria-label="关闭窗口"
            title="关闭窗口"
            onclick={() => choose(onquit)}><Icon name="close" size={16} /></button
          >
        </div>
      {/if}
    </div>
  {:else}
    <div class="titlebar-actions" data-tauri-drag-region={chrome ? 'false' : undefined}>
      <span class="runtime-badge">{desktop ? '桌面版' : '网页版'}</span>
      <button
        class="icon-button"
        aria-label="保存项目"
        title={`保存 (${mod}S)`}
        disabled={!project}
        onclick={() => choose(() => onaction('app.save'))}><Icon name="save" /></button
      >
    </div>
  {/if}
</header>
