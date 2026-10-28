<script lang="ts">
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import WorkspaceHeader from '../../../src/components/WorkspaceHeader.svelte';
  import { providePopups } from '../../../src/runtime/popups';
  import type { ProjectView, Workbench } from '../../../src/runtime/workbench';
  import type { WindowChromeState } from '../../../src/runtime/platform';

  const requested = new URL(location.href).searchParams.get('platform');
  let kind = $state<'web' | 'windows' | 'macos' | 'linux'>(
    requested === 'windows' || requested === 'macos' || requested === 'linux' ? requested : 'web',
  );
  let maximized = $state(false),
    fullscreen = $state(false),
    focused = $state(true),
    revision = $state(1);
  let name = $state('标题栏项目'),
    dirty = $state(false);
  let empty = $state(false);
  let leftOpen = $state(true),
    rightOpen = $state(true);
  let callbacks = $state<string[]>([]);
  const popups = providePopups();
  onMount(() => popups.mount());

  function document(id: string, title: string, changed: boolean): ProjectView {
    return {
      id,
      name: title,
      sourceLanguage: 'japanese',
      targetLanguage: 'simplifiedChinese',
      images: [],
      stateId: changed ? 'edited' : 'saved',
      savedStateId: 'saved',
      canUndo: true,
      canRedo: false,
      historyDepth: 1,
    };
  }
  // Only the read side used by WorkspaceHeader is present. No fake command,
  // filesystem, window or history implementation is needed for header tests.
  const projection = writable<{ projects: ProjectView[]; activeId: string | null }>({
    projects: [document('primary', '标题栏项目', false), document('secondary', '另一项目', false)],
    activeId: 'primary',
  });
  const workbench = {
    subscribe: projection.subscribe,
    dirty: (project: ProjectView) => project.stateId !== project.savedStateId,
  } as Workbench;
  const record = (value: string) => {
    callbacks = [...callbacks, value];
  };
  const chrome = $derived<WindowChromeState | null>(
    kind === 'web'
      ? null
      : {
          platform: kind,
          maximized,
          fullscreen,
          focused,
          revision,
        },
  );
  $effect(() => {
    const primary = document('primary', name, dirty);
    projection.update((value) => ({
      ...value,
      projects: empty ? [] : [primary, document('secondary', '另一项目', false)],
      activeId: empty ? null : (value.activeId ?? 'primary'),
    }));
  });
  $effect(() => popups.setScope($projection.activeId, null));
</script>

<div class="app-shell">
  <WorkspaceHeader
    {workbench}
    {chrome}
    recent={['/comics/recent.bf']}
    onaction={record}
    onnew={() => record('new')}
    onopen={() => record('open')}
    onproject={(id) => {
      record(`project:${id}`);
      projection.update((value) => ({ ...value, activeId: id }));
    }}
    onclose={(id) => record(`project-close:${id}`)}
    onlefttoggle={() => {
      leftOpen = !leftOpen;
      record('left-toggle');
    }}
    onrighttoggle={() => {
      rightOpen = !rightOpen;
      record('right-toggle');
    }}
    {leftOpen}
    {rightOpen}
    onzoom={(mode) => record(`zoom:${mode}`)}
    onsettings={() => record('settings')}
    onminimize={() => record('minimize')}
    onmaximize={() => record('maximize')}
    onquit={() => record('quit')}
  />
  <main class="fixture-main" aria-label="标题栏夹具">
    <p role="status">夹具就绪</p>
    <section class="fixture-controls" aria-label="夹具状态控制">
      <label
        >平台<select aria-label="夹具平台" bind:value={kind} onchange={() => revision++}>
          <option value="web">网页</option><option value="windows">Windows</option>
          <option value="macos">macOS</option><option value="linux">Linux</option>
        </select></label
      >
      <label>标题<input class="fixture-title" aria-label="夹具项目名称" bind:value={name} /></label>
      <label><input aria-label="夹具未保存" type="checkbox" bind:checked={dirty} />未保存</label>
      <label><input aria-label="夹具空工作区" type="checkbox" bind:checked={empty} />空工作区</label
      >
      <label
        ><input
          aria-label="夹具最大化"
          type="checkbox"
          bind:checked={maximized}
          onchange={() => revision++}
        />最大化</label
      >
      <label
        ><input
          aria-label="夹具全屏"
          type="checkbox"
          bind:checked={fullscreen}
          onchange={() => revision++}
        />全屏</label
      >
      <label
        ><input
          aria-label="夹具焦点"
          type="checkbox"
          bind:checked={focused}
          onchange={() => revision++}
        />焦点</label
      >
      <button
        onclick={() => {
          callbacks = [];
        }}>清空回调记录</button
      >
    </section>
    <ol aria-label="回调记录">
      {#each callbacks as callback, index (index)}<li>{callback}</li>{/each}
    </ol>
    <p>此夹具只验证浏览器中的标题栏、弹层和回调；不代表操作系统原生窗口已通过实机验收。</p>
  </main>
</div>

<style>
  .fixture-main {
    padding: 24px;
    overflow: auto;
  }
  .fixture-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
  }
  .fixture-controls label {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .fixture-title {
    width: 260px;
  }
  ol {
    margin: 20px 0;
  }
  li {
    padding: 3px 0;
  }
</style>
