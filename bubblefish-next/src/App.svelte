<script module lang="ts">
  function focusInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
  function modalFocus(node: HTMLDivElement) {
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => {
      (
        node.querySelector<HTMLElement>('input:not([type=file])') ??
        node.querySelector<HTMLElement>('button')
      )?.focus();
    });
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const all = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].filter((element) => element.offsetParent !== null);
      const first = all[0],
        last = all.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    node.addEventListener('keydown', handler);
    return {
      destroy() {
        node.removeEventListener('keydown', handler);
        if (previous?.isConnected) previous.focus();
      },
    };
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Canvas, { type ZoomMode } from './components/Canvas.svelte';
  import TranslationPanel from './components/TranslationPanel.svelte';
  import ImageSidebar from './components/ImageSidebar.svelte';
  import WorkspaceHeader from './components/WorkspaceHeader.svelte';
  import Icon from './components/Icon.svelte';
  import PendingPreview from './components/PendingPreview.svelte';
  import {
    Workbench,
    message,
    pendingGeometriesForImage,
    type OpenDraft,
  } from './runtime/workbench';
  import { platform, type PickedFile, type WindowChromeState } from './runtime/platform';
  import { observeWindowChrome } from './runtime/window-chrome';
  import { naturalCompare, checksumKey, id } from './runtime/assets';
  import { snapshots, type Snapshot } from './runtime/snapshots';
  import type { Geometry, ImageDocument, Marker } from './generated/core';
  import {
    readLayout,
    readEditorPreferences,
    readPreference,
    writePreference,
  } from './runtime/preferences';
  import { providePopups } from './runtime/popups';

  let { initialChrome = null }: { initialChrome?: WindowChromeState | null } = $props();
  const bootstrapChrome = untrack(() => initialChrome);
  let chrome = $state.raw<WindowChromeState | null>(bootstrapChrome);
  const workbench = new Workbench();
  const popups = providePopups();
  const layout = readLayout();
  const mac = bootstrapChrome
      ? bootstrapChrome.platform === 'macos'
      : /Mac|iPhone|iPad/.test(navigator.platform),
    mod = mac ? '⌘' : 'Ctrl+';
  let modal = $state<'new' | 'open' | 'snapshots' | 'settings' | 'export' | null>(null);
  let newName = $state('未命名项目'),
    newFiles = $state<PickedFile[]>([]),
    working = $state(false);
  let openDraft = $state<OpenDraft | null>(null),
    candidates = $state<ImageDocument[]>([]),
    assignments = $state<Record<string, string>>({});
  let snapshotList = $state<Snapshot[]>([]),
    recent = $state<string[]>([]);
  let sidebar = $state<'images' | 'settings'>(layout.sidebar),
    leftOpen = $state(layout.leftOpen),
    rightOpen = $state(layout.rightOpen);
  let theme = $state(readPreference('theme') ?? 'ocean');
  let editorPreferences = $state(readEditorPreferences());
  let leftWidth = $state(layout.leftWidth),
    rightWidth = $state(layout.rightWidth),
    editorHeight = $state(layout.editorHeight);
  let canvas = $state<Canvas>(),
    translationPanel = $state<TranslationPanel>();
  let view = $state({ scale: 1, mode: 'fit' as ZoomMode, outside: false });
  let jump = $state(false),
    jumpValue = $state(''),
    tipIndex = $state(0),
    hovered = $state<string | null>(null);
  let dragNew = $state<number | null>(null),
    lastMenu = '';
  let resize: { kind: 'left' | 'right' | 'editor'; start: number; size: number } | null = null;
  let closing = false;
  let locateRequest = 0;
  const externalOpenQueue: string[] = [];
  let openingExternal = false;
  const project = $derived($workbench.projects.find((p) => p.id === $workbench.activeId));
  const image = $derived(project?.images.find((i) => i.id === $workbench.imageId));
  const pendingGeometries = $derived(
    pendingGeometriesForImage($workbench.pendingGeometries, project?.id ?? '', image?.id ?? ''),
  );
  const marker = $derived(image?.markers.find((m) => m.id === $workbench.markerId));
  const windowTitle = $derived(
    platform.desktop
      ? project
        ? `${project.name}${workbench.dirty(project) ? '[*]' : ''}`
        : 'Bubblefish Next'
      : `${project ? `${workbench.dirty(project) ? '● ' : ''}${project.name} — ` : ''}Bubblefish Next`,
  );
  const page = $derived(project?.images.findIndex((i) => i.id === $workbench.imageId) ?? -1);
  const allMatched = $derived(
    !!openDraft && openDraft.document.images.every((i) => !!assignments[i.id]),
  );
  const tips = [
    `使用 ${platform.desktop ? mod : mod + (mac ? '⌥' : 'Alt+')}N 快速创建新项目`,
    `使用 ${mod}O 快速打开项目`,
    `使用 ${mod}← / ${mod}→ 切换图片`,
    `使用 ${mod}Z / ${mod}Shift+Z 撤销重做编辑操作`,
    '选中标记时，使用 Tab / Shift+Tab 切换下一个 / 上一个标记',
    `使用 ${mod}S 及时保存`,
    `按住 ${mac ? '⌘' : 'Ctrl'} 滑动滚轮可以缩放图片`,
    `按住 ${mac ? '⌘' : 'Ctrl'} 可以拖拽图片`,
    '按住 Shift 滑动滚轮可以横向滚动',
    '点击状态栏上的缩放百分比可以选择缩放模式',
    '点击状态栏页码，输入数字跳转到指定页面',
    '图片完全移出可视区域时，点击“图片归位”恢复位置',
    '点击顶部项目名称，可以切换已打开的项目',
    '触摸屏和触控板支持双指缩放',
    '触摸屏支持双指平移图片',
    '长按右侧翻译项一秒后，可以拖动调整编号',
    '意外退出忘记保存？从“更多 → 快照”恢复标注',
    '交流与反馈 QQ 群：1060743685',
  ];
  const languages = [
    ['japanese', '日语'],
    ['english', '英语'],
    ['simplifiedChinese', '简体中文'],
    ['traditionalChinese', '繁体中文'],
  ];
  const run = (operation: () => Promise<unknown>) => {
    void operation().catch((error) => workbench.notice(message(error)));
  };
  function interruptAutoLocate<T>(operation: () => Promise<T>): Promise<T> {
    locateRequest++;
    return operation();
  }
  async function selectAndLocate(operation: () => Promise<unknown>) {
    const request = ++locateRequest;
    const before = {
      projectId: $workbench.activeId,
      imageId: $workbench.imageId,
      markerId: $workbench.markerId,
    };
    await operation();
    const selected = {
      projectId: $workbench.activeId,
      imageId: $workbench.imageId,
      markerId: $workbench.markerId,
    };
    await tick();
    if (
      request !== locateRequest ||
      !editorPreferences.autoLocateMarker ||
      modal ||
      selected.projectId !== before.projectId ||
      selected.projectId !== $workbench.activeId ||
      selected.imageId !== $workbench.imageId ||
      selected.markerId !== $workbench.markerId ||
      (selected.imageId === before.imageId && selected.markerId === before.markerId)
    )
      return;
    const target = image?.markers.find((item) => item.id === selected.markerId);
    if (target) canvas?.locate(target);
  }
  async function busy(operation: () => Promise<void>) {
    working = true;
    try {
      await operation();
    } catch (error) {
      workbench.notice(message(error));
    } finally {
      working = false;
    }
  }
  async function newProject() {
    locateRequest++;
    popups.close('action');
    await workbench.barrier();
    newName = '未命名项目';
    newFiles = [];
    modal = 'new';
  }
  function picked(files: FileList | null): PickedFile[] {
    return Array.from(files ?? [], (file) => ({ name: file.name, file }));
  }
  function appendNew(files: PickedFile[]) {
    newFiles = [...newFiles, ...files];
  }
  async function createProject() {
    if (!newName.trim() || !newFiles.length) return;
    await busy(async () => {
      const images = await workbench.importImages(newFiles);
      await workbench.create(newName, images);
      modal = null;
      newFiles = [];
    });
  }
  async function addImages() {
    const files = await platform.pickImages();
    if (files.length)
      await busy(async () => {
        await workbench.addImages(await workbench.importImages(files));
      });
  }
  async function chooseOpen() {
    popups.close('action');
    const file = await platform.pickProject();
    if (file) await openFile(file);
  }
  async function openFile(file: PickedFile) {
    locateRequest++;
    popups.close('action');
    await busy(async () => {
      const draft = await workbench.parseProject(file);
      openDraft = draft;
      candidates = [];
      assignments = {};
      modal = 'open';
      if (draft.path) {
        const files = await platform.scanImages(draft.path);
        if (files.length) await addCandidates(files);
      }
      if (!draft.document.images.length && !draft.warnings.length && !draft.forceSaveAs)
        await completeOpen();
      else if (
        draft.path &&
        !draft.warnings.length &&
        !draft.forceSaveAs &&
        draft.document.images.every((i) => assignments[i.id])
      )
        await completeOpen();
    });
  }
  async function addCandidates(files: PickedFile[]) {
    if (!files.length) return;
    candidates = [...candidates, ...(await workbench.importImages(files))];
    const next = { ...assignments };
    for (const required of openDraft?.document.images ?? []) {
      if (next[required.id]) continue;
      const checksum = required.checksum
        ? candidates.filter((i) => checksumKey(i.checksum) === checksumKey(required.checksum))
        : [];
      const named = candidates.filter((i) => i.filename === required.filename);
      const matches = required.checksum ? checksum : named;
      if (matches.length === 1) next[required.id] = matches[0].assetId;
    }
    assignments = next;
  }
  async function completeOpen() {
    if (!openDraft || !openDraft.document.images.every((i) => assignments[i.id])) return;
    const draft = openDraft;
    const document = {
      ...draft.document,
      images: draft.document.images.map((required) => {
        const match = candidates.find((i) => i.assetId === assignments[required.id])!;
        return {
          ...required,
          assetId: match.assetId,
          width: match.width,
          height: match.height,
          checksum: match.checksum,
        };
      }),
    };
    await workbench.finishOpen({ ...draft, document });
    modal = null;
    openDraft = null;
    recent = await platform.recentFiles();
  }
  async function drainExternalOpen() {
    if (openingExternal || modal || working || !$workbench.ready) return;
    openingExternal = true;
    try {
      while (externalOpenQueue.length && !modal && !working) {
        const path = externalOpenQueue.shift()!;
        await openFile({ name: path.split(/[/\\]/).pop()!, path });
      }
    } finally {
      openingExternal = false;
    }
  }
  async function action(name: string) {
    if (name !== 'app.previousMarker' && name !== 'app.nextMarker') locateRequest++;
    popups.close('action');
    if (modal && name !== 'app.quit') return;
    if (name.startsWith('app.openRecent:')) {
      const path = decodeURIComponent(name.slice('app.openRecent:'.length));
      return openFile({ name: path.split(/[/\\]/).pop()!, path });
    }
    if (name === 'app.new') return newProject();
    if (name === 'app.open') return chooseOpen();
    if (name === 'app.quit') return closeWindow();
    if (modal && name !== 'app.snapshots') return;
    switch (name) {
      case 'app.save':
        await workbench.save();
        recent = await platform.recentFiles();
        break;
      case 'app.saveAs':
        await workbench.save(true);
        recent = await platform.recentFiles();
        break;
      case 'app.exportLabelplus':
        if (project) {
          await workbench.barrier();
          modal = 'export';
        }
        break;
      case 'app.closeCurrent':
        await workbench.close();
        break;
      case 'app.undo':
        if (project?.canUndo) {
          if (translationPanel) await translationPanel.exclusive(() => workbench.history('undo'));
          else await workbench.history('undo');
        }
        break;
      case 'app.redo':
        if (project?.canRedo) {
          if (translationPanel) await translationPanel.exclusive(() => workbench.history('redo'));
          else await workbench.history('redo');
        }
        break;
      case 'app.previousImage':
        await workbench.navigateImage(-1);
        break;
      case 'app.nextImage':
        await workbench.navigateImage(1);
        break;
      case 'app.previousMarker':
        await selectAndLocate(() => workbench.navigateMarker(-1));
        break;
      case 'app.nextMarker':
        await selectAndLocate(() => workbench.navigateMarker(1));
        break;
      case 'view.fit':
        canvas?.setMode('fit');
        break;
      case 'view.width':
        canvas?.setMode('width');
        break;
      case 'view.height':
        canvas?.setMode('height');
        break;
      case 'view.toggleLeft':
        leftOpen = !leftOpen;
        break;
      case 'view.toggleRight':
        await workbench.barrier();
        rightOpen = !rightOpen;
        break;
      case 'app.settings':
        await workbench.barrier();
        modal = 'settings';
        break;
      case 'app.snapshots':
        await workbench.barrier();
        snapshotList = await snapshots.list();
        modal = 'snapshots';
        break;
    }
  }
  async function restoreSnapshot(item: Snapshot) {
    if (!item.document)
      return openFile({
        name: `${item.projectName}.bf`,
        file: new File([new Uint8Array(item.bytes)], `${item.projectName}.bf`),
      });
    await workbench.barrier();
    openDraft = {
      document: { ...JSON.parse(JSON.stringify(item.document)), id: id() },
      warnings: item.exportError
        ? [`此快照保留了不能用旧 BF 格式表达的内容：${item.exportError}`]
        : [],
      forceSaveAs: true,
      format: 'bf',
      restored: true,
    };
    candidates = [];
    assignments = {};
    modal = 'open';
    if (!openDraft.document.images.length) await completeOpen();
  }
  async function closeWindow() {
    if (closing) return;
    closing = true;
    try {
      for (const p of [...$workbench.projects]) if (!(await workbench.close(p.id))) return;
      await platform.closeWindow();
    } finally {
      closing = false;
    }
  }
  async function markerAction(markerId: string, name: 'delete' | 'convert') {
    popups.close('action');
    const projectId = project?.id,
      imageId = image?.id;
    if (!projectId || !imageId) return;
    await workbench.barrier();
    const target = workbench.value.projects
      .find((item) => item.id === projectId)
      ?.images.find((item) => item.id === imageId)
      ?.markers.find((item) => item.id === markerId);
    if (!target) return;
    if (name === 'delete')
      await workbench.documentCommand(
        { type: 'removeMarker', imageId, markerId },
        '删除标记',
        projectId,
      );
    else {
      const g = target.geometry;
      const geometry: Geometry =
        g.type === 'rectangle'
          ? { type: 'point', x: g.x + g.width / 2, y: g.y }
          : {
              type: 'rectangle',
              x: Math.max(0, Math.min(0.9, g.x - 0.05)),
              y: Math.max(0, Math.min(0.9, g.y)),
              width: 0.1,
              height: 0.1,
            };
      await workbench.documentCommand(
        { type: 'updateMarker', imageId, markerId, geometry },
        '转换标记',
        projectId,
      );
    }
  }
  async function removeImage(imageId: string) {
    if (!project) return;
    if (window.confirm('删除这张图片及其标记？此操作可以撤销。'))
      await workbench.documentCommand({ type: 'removeImage', imageId }, '删除图片');
  }
  async function sortImages() {
    if (project)
      await workbench.documentCommand(
        {
          type: 'reorderImages',
          imageIds: [...project.images]
            .sort((a, b) => naturalCompare(a.filename, b.filename))
            .map((i) => i.id),
        },
        '按文件名排序',
      );
  }
  function startResize(event: PointerEvent, kind: 'left' | 'right' | 'editor') {
    event.preventDefault();
    resize = {
      kind,
      start: kind === 'editor' ? event.clientY : event.clientX,
      size: kind === 'left' ? leftWidth : kind === 'right' ? rightWidth : editorHeight,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function resizeMove(event: PointerEvent) {
    if (!resize) return;
    const delta = (resize.kind === 'editor' ? event.clientY : event.clientX) - resize.start;
    if (resize.kind === 'left') leftWidth = Math.max(180, Math.min(420, resize.size + delta));
    else if (resize.kind === 'right')
      rightWidth = Math.max(270, Math.min(620, resize.size - delta));
    else editorHeight = Math.max(170, Math.min(window.innerHeight * 0.65, resize.size - delta));
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (modal && !working) modal = null;
      return;
    }
    if (modal) return;
    const normal = (event.target as HTMLElement)?.closest('input,textarea,select');
    if (normal) return;
    const modifier = mac ? event.metaKey : event.ctrlKey;
    let command: string | undefined;
    if (modifier) {
      switch (event.key.toLowerCase()) {
        case 'n':
          if (platform.desktop ? !event.altKey : event.altKey) command = 'app.new';
          break;
        case 'o':
          command = 'app.open';
          break;
        case 's':
          command = event.shiftKey ? 'app.saveAs' : 'app.save';
          break;
        case 'z':
          command = event.shiftKey ? 'app.redo' : 'app.undo';
          break;
        case 'y':
          command = 'app.redo';
          break;
        case 'arrowleft':
          event.preventDefault();
          run(() => interruptAutoLocate(() => workbench.navigateImage(-1)));
          return;
        case 'arrowright':
          event.preventDefault();
          run(() => interruptAutoLocate(() => workbench.navigateImage(1)));
          return;
      }
    }
    if (command) {
      event.preventDefault();
      run(() => action(command!));
    } else if (event.key === 'Tab' && marker) {
      event.preventDefault();
      run(() => selectAndLocate(() => workbench.navigateMarker(event.shiftKey ? -1 : 1)));
    }
  }
  function jumpPage() {
    const value = Number(jumpValue);
    if (project && Number.isInteger(value) && value >= 1 && value <= project.images.length)
      run(() => interruptAutoLocate(() => workbench.selectImage(project.images[value - 1].id)));
    jump = false;
  }
  async function dropFiles(event: DragEvent) {
    event.preventDefault();
    const files = picked(event.dataTransfer?.files ?? null);
    if (!files.length) return;
    if (modal === 'new') {
      appendNew(files);
      return;
    }
    if (modal === 'open') {
      await busy(() => addCandidates(files));
      return;
    }
    const doc = files.find((f) => /\.(bf|txt|lp)$/i.test(f.name));
    if (doc) {
      await openFile(doc);
      return;
    }
    if (project) await busy(async () => workbench.addImages(await workbench.importImages(files)));
    else {
      await newProject();
      newFiles = files;
    }
  }
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference('theme', theme);
  });
  $effect(() => {
    writePreference('editor', JSON.stringify(editorPreferences));
  });
  $effect(() => {
    writePreference(
      'layout',
      JSON.stringify({ sidebar, leftOpen, rightOpen, leftWidth, rightWidth, editorHeight }),
    );
  });
  $effect(() => {
    const title = windowTitle;
    document.title = title;
    if (platform.desktop)
      void platform.setWindowTitle(title).catch((error) => workbench.notice(message(error)));
  });
  $effect(() => {
    if (!platform.desktop) return;
    const menu = {
        enabled: !modal,
        hasProject: !!project && !modal,
        canUndo: !!project?.canUndo && !modal,
        canRedo: !!project?.canRedo && !modal,
        undoLabel: project?.undoLabel,
        redoLabel: project?.redoLabel,
        recentFiles: recent,
        leftOpen,
        rightOpen,
      },
      key = JSON.stringify(menu);
    if (key !== lastMenu) {
      lastMenu = key;
      void platform.syncMenu(menu).catch((error) => workbench.notice(message(error)));
    }
  });
  $effect(() => {
    workbench.editorBarrier = async (allowTransition) => {
      await translationPanel?.barrier(allowTransition);
    };
  });
  $effect(() => {
    popups.setScope($workbench.activeId, $workbench.imageId);
    if (modal) popups.close('modal');
    const active = $popups;
    if (active?.marker && !image?.markers.some((item) => item.id === active.marker!.id))
      popups.close('target-removed', active.token);
  });
  $effect(() => {
    const selected = $workbench.imageId;
    if (selected)
      void tick().then(() =>
        document.querySelector('.image-row.current')?.scrollIntoView({ block: 'nearest' }),
      );
  });
  $effect(() => {
    if (!modal && !working && $workbench.ready) run(drainExternalOpen);
  });
  $effect(() => {
    if (!modal && !working) {
      workbench.releaseStagedAssets();
      candidates = [];
      openDraft = null;
    }
  });
  onMount(() => {
    tipIndex = Math.floor(Math.random() * tips.length);
    void workbench.initialize();
    let disposed = false;
    const cleanups: (() => void)[] = [popups.mount()];
    if (platform.desktop)
      cleanups.push(
        observeWindowChrome(
          platform,
          chrome,
          (state) => (chrome = state),
          (error) => workbench.notice(message(error)),
        ),
      );
    void Promise.all([
      platform.listenActions((name) => run(() => action(name))),
      platform.listenOpen((paths) => {
        externalOpenQueue.push(...paths);
        run(drainExternalOpen);
      }),
      platform.listenClose(closeWindow),
    ]).then((unlisteners) => {
      if (disposed) unlisteners.forEach((stop) => stop());
      else cleanups.push(...unlisteners);
    });
    void platform.recentFiles().then((files) => (recent = files));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        $workbench.pending ||
        $workbench.geometryPending ||
        $workbench.projects.some((p) => workbench.dirty(p))
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    // A later pointer/view interaction must not be recentered by an older navigation.
    const interruptLocate = () => {
      locateRequest++;
    };
    window.addEventListener('pointerdown', interruptLocate, true);
    window.addEventListener('wheel', interruptLocate, { capture: true, passive: true });
    window.addEventListener('blur', interruptLocate);
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pointerdown', interruptLocate, true);
      window.removeEventListener('wheel', interruptLocate, true);
      window.removeEventListener('blur', interruptLocate);
      workbench.dispose();
    };
  });
</script>

<svelte:window
  onkeydown={keydown}
  onpointermove={(event) => {
    resizeMove(event);
  }}
  onpointerup={(event) => {
    resize = null;
  }}
  onpointercancel={() => {
    resize = null;
  }}
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => run(() => dropFiles(event))}
/>

<div class="app-shell" inert={!!modal} role="application" aria-label="Bubblefish 工作区">
  <WorkspaceHeader
    {workbench}
    {chrome}
    {recent}
    {leftOpen}
    {rightOpen}
    onminimize={() => run(() => platform.minimizeWindow())}
    onmaximize={() => run(() => platform.toggleMaximizeWindow())}
    onquit={() => run(closeWindow)}
    onaction={(name) => run(() => action(name))}
    onnew={() => run(newProject)}
    onopen={() => run(chooseOpen)}
    onproject={(projectId) =>
      run(() => interruptAutoLocate(() => workbench.switchProject(projectId)))}
    onclose={(projectId) => run(() => interruptAutoLocate(() => workbench.close(projectId)))}
    onlefttoggle={() => (leftOpen = !leftOpen)}
    onrighttoggle={() =>
      run(async () => {
        await workbench.barrier();
        rightOpen = !rightOpen;
      })}
    onzoom={(mode) => canvas?.setMode(mode)}
    onsettings={() => (modal = 'settings')}
  />

  <div class="work-area">
    <aside class="activity-bar" aria-label="功能栏">
      <button
        class:active={leftOpen && sidebar === 'images'}
        title="图片"
        aria-label="图片面板"
        onclick={() => {
          if (sidebar === 'images') leftOpen = !leftOpen;
          else {
            sidebar = 'images';
            leftOpen = true;
          }
        }}><Icon name="images" size={22} /></button
      >
      <button
        class:active={leftOpen && sidebar === 'settings'}
        title="项目配置"
        aria-label="项目配置"
        onclick={() => {
          if (sidebar === 'settings') leftOpen = !leftOpen;
          else {
            sidebar = 'settings';
            leftOpen = true;
          }
        }}><Icon name="settings" size={22} /></button
      >
      <div class="activity-spacer"></div>
      <button title="快照" aria-label="快照" onclick={() => run(() => action('app.snapshots'))}
        ><Icon name="history" size={21} /></button
      ><button title="设置" aria-label="设置" onclick={() => (modal = 'settings')}
        ><Icon name="sun" size={21} /></button
      >
    </aside>
    {#if leftOpen}
      <ImageSidebar
        {project}
        assets={workbench.assets}
        selectedImageId={$workbench.imageId}
        mode={sidebar}
        width={leftWidth}
        onselect={(imageId) => run(() => interruptAutoLocate(() => workbench.selectImage(imageId)))}
        onadd={() => run(addImages)}
        onremove={(imageId) => run(() => removeImage(imageId))}
        onreorder={(projectId, imageIds) =>
          workbench.documentCommand({ type: 'reorderImages', imageIds }, '重排图片', projectId)}
        onerror={(error) => workbench.notice(message(error))}
        onsort={() => run(sortImages)}
        onprojectchange={(patch, label) =>
          run(() => workbench.documentCommand({ type: 'updateProject', ...patch }, label))}
      />

      <div
        class="splitter vertical"
        role="separator"
        aria-label="调整左侧面板"
        aria-orientation="vertical"
        tabindex="-1"
        onpointerdown={(event) => startResize(event, 'left')}
      ></div>
    {/if}
    <main class="main-panel">
      <div class="canvas-toolbar">
        <div class="toolbar-group">
          <button
            class="icon-button"
            aria-label="撤销"
            title={`撤销${project?.undoLabel ?? ''} (${mod}Z)`}
            disabled={!project?.canUndo}
            onclick={() => run(() => action('app.undo'))}><Icon name="undo" size={17} /></button
          ><button
            class="icon-button"
            aria-label="重做"
            title={`重做${project?.redoLabel ?? ''} (${mod}Shift+Z)`}
            disabled={!project?.canRedo}
            onclick={() => run(() => action('app.redo'))}><Icon name="redo" size={17} /></button
          >
        </div>
        <span class="toolbar-filename">{image?.filename ?? '漫画翻译工作台'}</span><span
          class="toolbar-hint">{image ? '点击添加点标记 · 拖动框选' : '标记原文，写下译文'}</span
        >
      </div>
      {#if image}
        <Canvas
          bind:this={canvas}
          {image}
          {pendingGeometries}
          assets={workbench.assets}
          selectedId={$workbench.markerId}
          hoverPreview={editorPreferences.hoverPreview && !modal}
          hoveredId={hovered}
          onhover={(value) => (hovered = value)}
          onselect={(markerId) =>
            run(() => interruptAutoLocate(() => workbench.selectMarker(markerId)))}
          onadd={(geometry) => run(() => workbench.addMarker(geometry))}
          onchange={(markerId, geometry) =>
            workbench.commitGeometry(project!.id, image!.id, markerId, geometry)}
          onerror={(error) => workbench.notice(message(error))}
          onmenu={(markerId, name) => run(() => markerAction(markerId, name))}
          onview={(value) => (view = value)}
        />
      {:else}
        <div class="welcome">
          <div class="welcome-glow"></div>
          <img
            class="welcome-logo"
            src={`${import.meta.env.BASE_URL}icon-192.png`}
            alt="Bubblefish logo"
          /><span class="eyebrow">BUBBLEFISH NEXT</span>
          <h1>{project ? '准备好下一页故事' : '让每一句对白，跨越语言'}</h1>
          <p>{project ? '添加图片，继续你的漫画翻译项目' : '为漫画标记文字，专注写下你的翻译。'}</p>
          <div class="welcome-buttons">
            <button
              class="primary-button"
              disabled={!$workbench.ready}
              onclick={() => run(project ? addImages : newProject)}
              ><Icon name="plus" />{project ? '添加图片' : '新建项目'}</button
            ><button
              class="secondary-button"
              disabled={!$workbench.ready}
              onclick={() => run(chooseOpen)}><Icon name="folder" />打开项目</button
            >
          </div>
          <button class="welcome-tip" onclick={() => (tipIndex = (tipIndex + 1) % tips.length)}
            ><span>✧</span>{tips[tipIndex]}<span class="tip-next">↻</span></button
          >
          <span class="welcome-footnote">.bf · LabelPlus　/　所有编辑均在本地完成</span>
        </div>
      {/if}
    </main>
    {#if rightOpen}
      <div
        class="splitter vertical"
        role="separator"
        aria-label="调整翻译面板"
        aria-orientation="vertical"
        tabindex="-1"
        onpointerdown={(event) => startResize(event, 'right')}
      ></div>
      <TranslationPanel
        bind:this={translationPanel}
        {workbench}
        width={rightWidth}
        {editorHeight}
        bind:hovered
        onselect={(markerId) => selectAndLocate(() => workbench.selectMarker(markerId))}
        onlocate={(item) => canvas?.locate(item)}
        onmarkeraction={markerAction}
        onaction={action}
        onresize={(event) => startResize(event, 'editor')}
      />
    {/if}
  </div>
  <footer class="statusbar">
    <span class="status-left"
      ><span class="status-indicator" class:busy={$workbench.pending > 0}></span><span
        data-testid="ready"
        >{$workbench.ready ? ($workbench.pending ? '正在记录…' : '就绪') : '正在启动核心…'}</span
      >{#if project}<span class="status-separator">/</span>{project.images.reduce(
          (n, i) => n + i.markers.length,
          0,
        )} 个标记{/if}</span
    >
    <div class="status-right">
      {#if image}<span>{image.width} × {image.height}</span>
        <details
          class="zoom-menu"
          open={$popups?.id === 'zoom'}
          use:popups.boundary={{ id: 'zoom' }}
        >
          <summary
            data-popup-trigger
            onclick={(event) => {
              event.preventDefault();
              popups.toggle({ id: 'zoom', trigger: event.currentTarget });
            }}>{Math.round(view.scale * 100)}% <Icon name="down" size={11} /></summary
          >
          <div class="zoom-popover">
            <input
              aria-label="缩放比例"
              type="range"
              min="1"
              max="500"
              value={view.scale * 100}
              oninput={(event) => canvas?.zoomTo(Number(event.currentTarget.value) / 100)}
            />{#each [['fit', '适合屏幕'], ['width', '适合宽度'], ['height', '适合高度']] as [value, label]}<button
                class:chosen={view.mode === value}
                onclick={() => {
                  popups.close('action');
                  canvas?.setMode(value as ZoomMode);
                }}>{label}</button
              >{/each}
          </div>
        </details>{/if}
      <button
        class="page-arrow"
        aria-label="上一张图片"
        disabled={!project || page <= 0}
        onclick={() => run(() => workbench.navigateImage(-1))}>‹</button
      >
      {#if jump}<input
          class="page-jump"
          aria-label="跳转页码"
          bind:value={jumpValue}
          onkeydown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') jumpPage();
            if (event.key === 'Escape') jump = false;
          }}
          onblur={() => (jump = false)}
          use:focusInput
        />{:else}<button
          class="page-number"
          disabled={!project?.images.length}
          title="点击输入页码"
          onclick={() => {
            jumpValue = String(page + 1);
            jump = true;
          }}>{page + 1} / {project?.images.length ?? 0}</button
        >{/if}
      <button
        class="page-arrow"
        aria-label="下一张图片"
        disabled={!project || page >= project.images.length - 1}
        onclick={() => run(() => workbench.navigateImage(1))}>›</button
      >
    </div>
  </footer>
  {#if $workbench.notice}<div class="toast" role="status">
      <span>{$workbench.notice}</span><button
        aria-label="关闭提示"
        onclick={() => workbench.notice('')}><Icon name="close" size={16} /></button
      >
    </div>{/if}
  {#if $workbench.queueError}<div class="queue-error" role="alert">
      <strong>编辑尚未确认，草稿已保留</strong><span>{$workbench.queueError}</span><button
        onclick={() => workbench.retry()}>重试提交</button
      >
    </div>{/if}
  {#if $workbench.progress}<div class="progress-overlay">
      <div>
        <span>正在读取图片 {$workbench.progress.done} / {$workbench.progress.total}</span><progress
          value={$workbench.progress.done}
          max={$workbench.progress.total}
        ></progress>
      </div>
    </div>{/if}
</div>

{#if modal}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget && !working) modal = null;
    }}
  >
    <div
      class="modal"
      class:wide={modal === 'new' || modal === 'open'}
      role="dialog"
      aria-modal="true"
      aria-label={modal === 'new'
        ? '新建项目'
        : modal === 'open'
          ? '匹配项目图片'
          : modal === 'snapshots'
            ? '项目快照'
            : modal === 'export'
              ? '导出 LabelPlus'
              : '设置与外观'}
      tabindex="-1"
      use:modalFocus
    >
      <div class="modal-heading">
        <div>
          <span class="eyebrow">BUBBLEFISH</span>
          <h2>
            {modal === 'new'
              ? '新建项目'
              : modal === 'open'
                ? '匹配项目图片'
                : modal === 'snapshots'
                  ? '项目快照'
                  : modal === 'export'
                    ? '导出 LabelPlus'
                    : '设置与外观'}
          </h2>
        </div>
        <button
          class="icon-button"
          disabled={working}
          aria-label="关闭弹窗"
          onclick={() => (modal = null)}><Icon name="close" /></button
        >
      </div>
      {#if modal === 'new'}
        <label class="field-label"
          >项目名称<input
            aria-label="项目名称"
            bind:value={newName}
            placeholder="给这个故事起一个名字"
          /></label
        >
        <div class="modal-section-heading">
          <span>漫画图片 <small>{newFiles.length} 张</small></span><button
            class="subtle-button"
            onclick={() =>
              (newFiles = [...newFiles].sort((a, b) => naturalCompare(a.name, b.name)))}
            ><Icon name="sort" size={15} />按名称排序</button
          >
        </div>
        <label class="upload-zone"
          ><Icon name="images" size={28} /><strong>选择或拖入漫画图片</strong><small
            >PNG · JPG · GIF · WebP · BMP</small
          ><input
            aria-label="选择图片"
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,.bmp"
            multiple
            onchange={(event) => appendNew(picked(event.currentTarget.files))}
          /></label
        >
        <div class="new-file-list">
          {#each newFiles as file, index}<div
              role="group"
              aria-label={`待添加图片 ${index + 1}`}
              draggable="true"
              ondragstart={() => (dragNew = index)}
              ondragover={(event) => event.preventDefault()}
              ondrop={(event) => {
                event.stopPropagation();
                event.preventDefault();
                if (dragNew !== null) {
                  const next = [...newFiles];
                  const [moved] = next.splice(dragNew, 1);
                  next.splice(index, 0, moved);
                  newFiles = next;
                }
                dragNew = null;
              }}
            >
              <Icon name="grip" size={15} /><PendingPreview picked={file} /><span>{index + 1}</span
              ><strong>{file.name}</strong><button
                aria-label={`移除 ${file.name}`}
                onclick={() => (newFiles = newFiles.filter((_, i) => i !== index))}
                ><Icon name="close" size={14} /></button
              >
            </div>{/each}
        </div>
        <div class="modal-footer">
          <span class="muted">图片按列表顺序加入，可以拖动重排</span><button
            class="primary-button"
            disabled={working || !newName.trim() || !newFiles.length}
            onclick={() => run(createProject)}
            >{working ? '正在创建…' : '创建项目'}<Icon name="chevron" size={15} /></button
          >
        </div>
      {:else if modal === 'open' && openDraft}
        <p class="modal-description">
          {openDraft.document.name} · 标注文件不包含图片，请关联原始漫画页。
        </p>
        {#each openDraft.warnings as warning}<p class="warning-note">{warning}</p>{/each}
        <label class="upload-zone compact"
          ><Icon name="folder" size={22} /><strong>选择对应图片</strong><input
            aria-label="匹配图片"
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,.bmp"
            multiple
            onchange={(event) => {
              const files = picked(event.currentTarget.files);
              run(() => busy(() => addCandidates(files)));
            }}
          /></label
        >
        <div class="matching-list">
          {#each openDraft.document.images as required, index}<div>
              <span class:matched={!!assignments[required.id]} class="match-state"
                >{assignments[required.id] ? '✓' : '○'}</span
              ><span>{index + 1}. {required.filename}</span><select
                aria-label={`匹配 ${required.filename}`}
                value={assignments[required.id] ?? ''}
                onchange={(event) =>
                  (assignments = { ...assignments, [required.id]: event.currentTarget.value })}
                ><option value="">等待选择图片</option>{#each candidates as candidate}<option
                    value={candidate.assetId}
                    >{candidate.filename}{required.checksum &&
                    checksumKey(candidate.checksum) !== checksumKey(required.checksum)
                      ? '（校验不同）'
                      : ''}</option
                  >{/each}</select
              >
            </div>{/each}
        </div>
        <div class="modal-footer">
          <span class="muted"
            >已匹配 {Object.keys(assignments).filter((key) => assignments[key]).length} / {openDraft
              .document.images.length}</span
          ><button
            class="primary-button"
            disabled={working || !allMatched}
            onclick={() => run(() => busy(completeOpen))}
            >打开项目<Icon name="chevron" size={15} /></button
          >
        </div>
      {:else if modal === 'snapshots'}
        <p class="modal-description">
          自动保留本地标注快照。恢复会打开为新项目，并按需重新关联图片。
        </p>
        <div class="snapshot-list">
          {#each snapshotList as item}<div>
              <div>
                <strong>{item.projectName}</strong><small
                  >{new Date(item.date).toLocaleString()} · {Math.ceil(item.bytes.length / 1024)} KB</small
                >
              </div>
              <button title="恢复快照" onclick={() => run(() => restoreSnapshot(item))}>恢复</button
              ><button
                title={item.exportError
                  ? `已保留本地恢复快照；无法下载 BF：${item.exportError}`
                  : '下载快照'}
                disabled={!item.bytes.length}
                onclick={() =>
                  run(() =>
                    platform.save(item.bytes, {
                      suggestedName: `${item.projectName}.bf`,
                      saveAs: true,
                      format: 'bf',
                    }),
                  )}><Icon name="download" size={16} /></button
              ><button
                title="删除快照"
                onclick={() =>
                  run(async () => {
                    await snapshots.remove(item.id);
                    snapshotList = await snapshots.list();
                  })}><Icon name="trash" size={16} /></button
              >
            </div>{:else}<div class="panel-empty">
              <Icon name="history" size={30} />
              <p>还没有快照</p>
              <small>编辑满 30 秒或完成 20 次操作后自动生成</small>
            </div>{/each}
        </div>
      {:else if modal === 'export'}
        <p class="modal-description">
          LabelPlus 仅支持点标记。矩形将按上边中点导出，文字和样式继续使用兼容语法。
        </p>
        <p class="muted text-sm">
          导出不会改变项目的保存状态。若内容无法由旧格式无损表达，会提示对应页面与标记。
        </p>
        <div class="modal-footer">
          <button class="secondary-button" onclick={() => (modal = null)}>取消</button><button
            class="primary-button"
            onclick={() =>
              run(async () => {
                modal = null;
                await workbench.save(true, 'labelplus');
              })}>导出 .txt</button
          >
        </div>
      {:else if modal === 'settings'}
        <p class="modal-description">工作台外观</p>
        <div class="theme-options">
          {#each [['ocean', '海洋', '清爽的蓝色工作台'], ['fruit', '果实', '温暖的橙色调'], ['dark', '夜间', '适合低亮度环境']] as [value, label, description]}<button
              class:chosen={theme === value}
              class={`theme-card ${value}`}
              onclick={() => (theme = value)}
              ><span class="theme-preview"><i></i><i></i><i></i></span><strong>{label}</strong
              ><small>{description}</small></button
            >{/each}
        </div>
        <fieldset class="editor-preferences">
          <legend>编辑器体验</legend>
          <label>
            <input
              type="checkbox"
              aria-label="悬浮气泡预览"
              bind:checked={editorPreferences.hoverPreview}
            />
            <span>悬浮气泡预览<small>鼠标悬浮图片标记时预览译文，方向跟随“横排”设置。</small></span>
          </label>
          <label>
            <input
              type="checkbox"
              aria-label="切换标记时自动定位到标记"
              bind:checked={editorPreferences.autoLocateMarker}
            />
            <span
              >切换标记时自动定位到标记<small
                >使用 Tab 或翻译列表切换时居中定位；图片点选保持当前视图。</small
              ></span
            >
          </label>
        </fieldset>
        <p class="settings-note">
          Bubblefish Next · 本地优先的漫画汉化辅助工具<br />项目格式兼容 BF 1.0 与 LabelPlus。
        </p>
      {/if}
    </div>
  </div>
{/if}
