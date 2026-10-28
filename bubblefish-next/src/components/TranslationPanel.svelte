<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import TranslationEditor from './TranslationEditor.svelte';
  import { Workbench, message } from '../runtime/workbench';
  import type { Marker } from '../generated/core';
  import { usePopups } from '../runtime/popups';
  let {
    workbench,
    width,
    editorHeight,
    hovered = $bindable(null),
    onlocate,
    onmarkeraction,
    onaction,
    onresize,
  }: {
    workbench: Workbench;
    width: number;
    editorHeight: number;
    hovered?: string | null;
    onlocate: (marker: Marker) => void;
    onmarkeraction: (id: string, action: 'delete' | 'convert') => Promise<unknown>;
    onaction: (name: string) => Promise<unknown>;
    onresize: (event: PointerEvent) => void;
  } = $props();
  let editor = $state<TranslationEditor>(),
    listElement = $state<HTMLDivElement>();
  const popups = usePopups();
  const markerContext = $derived(
    $popups?.id === 'translation-context' ? ($popups.marker ?? null) : null,
  );
  let dragMarker = $state<string | null>(null),
    holdMarker = $state<string | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | undefined,
    holdStart = { x: 0, y: 0 },
    holdPointer = -1,
    suppressMarkerClickUntil = 0,
    dragClientY = 0,
    scrollFrame = 0;
  const project = $derived($workbench.projects.find((p) => p.id === $workbench.activeId));
  const image = $derived(project?.images.find((i) => i.id === $workbench.imageId));
  const marker = $derived(image?.markers.find((m) => m.id === $workbench.markerId));
  const text = (item: Marker) => item.translation.runs.map((r) => r.text).join('');
  const run = (operation: () => Promise<unknown>) => {
    void operation().catch((error) => workbench.notice(message(error)));
  };
  async function markerAction(id: string, action: 'delete' | 'convert') {
    popups.close('action');
    await onmarkeraction(id, action);
  }
  export async function barrier(allowTransition = false) {
    await editor?.barrier(allowTransition);
  }
  export async function exclusive(operation: () => Promise<unknown>) {
    if (editor) return editor.exclusive(operation);
    return operation();
  }
  function cancelDrag() {
    if (dragMarker) suppressMarkerClickUntil = performance.now() + 250;
    dragMarker = null;
    holdMarker = null;
    holdPointer = -1;
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    popups.close('interaction');
  }
  function hold(event: PointerEvent, markerId: string) {
    if (event.button !== 0) return;
    holdStart = { x: event.clientX, y: event.clientY };
    holdPointer = event.pointerId;
    holdMarker = markerId;
    dragClientY = event.clientY;
    const target = event.currentTarget as HTMLElement;
    holdTimer = setTimeout(() => {
      dragMarker = markerId;
      holdMarker = null;
      target.setPointerCapture(event.pointerId);
      scrollFrame = requestAnimationFrame(scrollDrag);
    }, 1000);
  }
  function holdingMove(event: PointerEvent) {
    if (event.pointerId !== holdPointer) return;
    if (!dragMarker && Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > 10) {
      clearTimeout(holdTimer);
      holdMarker = null;
    }
    dragClientY = event.clientY;
  }
  function scrollDrag() {
    if (!dragMarker || !listElement) return;
    const bounds = listElement.getBoundingClientRect();
    if (dragClientY < bounds.top + 40)
      listElement.scrollTop -= Math.min(18, (bounds.top + 40 - dragClientY) * 0.45);
    else if (dragClientY > bounds.bottom - 40)
      listElement.scrollTop += Math.min(18, (dragClientY - bounds.bottom + 40) * 0.45);
    scrollFrame = requestAnimationFrame(scrollDrag);
  }
  function dropMarker(event: PointerEvent) {
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    holdMarker = null;
    holdPointer = -1;
    if (!dragMarker || !image) {
      dragMarker = null;
      return;
    }
    suppressMarkerClickUntil = performance.now() + 250;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-marker-id]')?.dataset.markerId;
    if (target && target !== dragMarker) {
      const ids = image.markers.map((m) => m.id),
        from = ids.indexOf(dragMarker);
      ids.splice(from, 1);
      ids.splice(ids.indexOf(target), 0, dragMarker);
      run(() =>
        workbench.documentCommand(
          { type: 'reorderMarkers', imageId: image!.id, markerIds: ids },
          '重排标记',
        ),
      );
    }
    dragMarker = null;
  }

  $effect(() => {
    const selected = $workbench.markerId;
    if (selected)
      void tick().then(() =>
        listElement
          ?.querySelector(`[data-marker-id="${selected}"]`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
  });
  onMount(() => () => {
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
  });
</script>

<svelte:window
  onpointermove={holdingMove}
  onpointerup={dropMarker}
  onpointercancel={cancelDrag}
  onblur={cancelDrag}
  onkeydown={(event) => {
    if (event.key === 'Escape') cancelDrag();
  }}
/>
<aside class="translation-panel" style:width={`${width}px`}>
  <div class="panel-heading">
    <span>翻译</span><span class="muted count">{image?.markers.length ?? 0}</span>
    <div class="grow"></div>
    <span class="panel-tag"
      >{marker ? `#${(image?.markers.indexOf(marker) ?? 0) + 1}` : '当前页面'}</span
    >
  </div>
  <div class="translation-list" bind:this={listElement}>
    {#each image?.markers ?? [] as item, index (item.id)}
      <div
        class="translation-item"
        class:selected={item.id === marker?.id}
        class:dragging={dragMarker === item.id}
        class:holding={holdMarker === item.id}
        class:hovered={hovered === item.id}
        data-marker-id={item.id}
      >
        <button
          class="translation-item-main"
          aria-label={`翻译项 ${index + 1}`}
          onpointerdown={(event) => hold(event, item.id)}
          onclick={() => {
            if (!dragMarker && performance.now() > suppressMarkerClickUntil)
              run(() => workbench.selectMarker(marker?.id === item.id ? null : item.id));
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            popups.open({
              id: 'translation-context',
              trigger: event.currentTarget,
              marker: { id: item.id, x: event.clientX, y: event.clientY },
            });
          }}
          onpointerenter={() => (hovered = item.id)}
          onpointerleave={() => (hovered = null)}
        >
          <span class="translation-number">{index + 1}</span><span class="translation-preview"
            >{text(item) || '输入翻译…'}</span
          ><Icon name="grip" size={13} />
        </button>
        <button
          class="locate-button"
          title="定位标记"
          aria-label={`定位标记 ${index + 1}`}
          onclick={() => onlocate(item)}><Icon name="target" size={15} /></button
        >
      </div>
    {:else}<div class="panel-empty translation-empty">
        <span class="empty-bubble">···</span>
        <p>从第一句对白开始</p>
        <small>在图片上点击或拖动<br />创建文字标记</small>
      </div>{/each}
  </div>
  {#if marker && image}
    <div
      class="splitter horizontal"
      role="separator"
      aria-label="调整编辑器高度"
      aria-orientation="horizontal"
      tabindex="-1"
      onpointerdown={(event) => onresize(event)}
    ></div>
    <div class="editor-section" style:height={`${editorHeight}px`}>
      <div class="editor-heading">
        <span>编辑翻译 <strong>#{image.markers.indexOf(marker) + 1}</strong></span><button
          class="icon-button"
          aria-label="取消选择标记"
          onclick={() => run(() => workbench.selectMarker(null))}
          ><Icon name="close" size={14} /></button
        >
      </div>
      {#key `${project?.id}/${image.id}/${marker.id}`}<TranslationEditor
          bind:this={editor}
          {marker}
          imageId={image.id}
          restore={$workbench.editorRestore}
          autofocus={$workbench.editorAutoFocus}
          onchange={(value, history) => workbench.edit(image!.id, marker!.id, value, history)}
          onboundary={() => {}}
          onrecover={(draft) => workbench.retainDraft(project!.id, draft.imageId, draft.marker)}
          onaction={(name) => run(() => onaction(name))}
        />{/key}
      <div class="marker-options">
        <label
          ><input
            type="checkbox"
            checked={marker.style.overlayText}
            onchange={(event) =>
              run(() =>
                workbench.documentCommand(
                  {
                    type: 'updateMarker',
                    imageId: image!.id,
                    markerId: marker!.id,
                    style: { ...marker!.style, overlayText: event.currentTarget.checked },
                  },
                  '修改标记样式',
                ),
              )}
          />复杂背景</label
        ><label
          ><input
            type="checkbox"
            checked={marker.style.horizontal}
            onchange={(event) =>
              run(() =>
                workbench.documentCommand(
                  {
                    type: 'updateMarker',
                    imageId: image!.id,
                    markerId: marker!.id,
                    style: { ...marker!.style, horizontal: event.currentTarget.checked },
                  },
                  '修改文字方向',
                ),
              )}
          />横排</label
        >
      </div>
    </div>
  {:else}<div class="editor-placeholder">选中标记，编辑对应的译文</div>{/if}

  {#if $workbench.recoveryDrafts.length}
    {@const draft = $workbench.recoveryDrafts[0]}
    <div class="draft-recovery" role="status">
      <strong>新输入已保留为恢复草稿</strong>
      <textarea
        aria-label="恢复输入草稿"
        readonly
        value={draft.marker.translation.runs.map((r) => r.text).join('')}
        rows="2"></textarea>
      <div>
        <button onclick={() => run(() => workbench.restoreDraft(draft.id))}>恢复为标记</button
        ><button aria-label="丢弃恢复草稿" onclick={() => workbench.dismissDraft(draft.id)}
          >丢弃</button
        >
      </div>
    </div>
  {/if}
</aside>
{#if markerContext}<div
    class="context-menu floating"
    style:left={`${Math.min(markerContext.x, window.innerWidth - 190)}px`}
    style:top={`${Math.min(markerContext.y, window.innerHeight - 110)}px`}
    role="menu"
    use:popups.boundary={{ id: 'translation-context', token: $popups?.token }}
  >
    <button onclick={() => run(() => markerAction(markerContext!.id, 'convert'))}
      >转换点 / 矩形标记</button
    ><button class="danger" onclick={() => run(() => markerAction(markerContext!.id, 'delete'))}
      >删除标记</button
    >
  </div>{/if}
