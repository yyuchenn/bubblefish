<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
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
    onselect,
    onlocate,
    onmarkeraction,
    onaction,
    onresize,
  }: {
    workbench: Workbench;
    width: number;
    editorHeight: number;
    hovered?: string | null;
    onselect: (id: string | null) => Promise<unknown>;
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
  interface MarkerDrag {
    projectId: string;
    imageId: string;
    markerId: string;
    originalIds: string[];
    ids: string[];
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  }
  interface PendingOrder {
    token: number;
    projectId: string;
    imageId: string;
    ids: string[];
  }
  let drag = $state<MarkerDrag | null>(null),
    pendingOrder = $state<PendingOrder | null>(null),
    holdMarker = $state<string | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | undefined,
    holdStart = { x: 0, y: 0 },
    pointerPosition = { x: 0, y: 0 },
    holdPointer = -1,
    holdScope = '',
    capturedPointer: HTMLElement | null = null,
    suppressMarkerClickUntil = 0,
    scrollFrame = 0,
    orderToken = 0,
    previousScope = '';
  const project = $derived($workbench.projects.find((p) => p.id === $workbench.activeId));
  const image = $derived(project?.images.find((i) => i.id === $workbench.imageId));
  const marker = $derived(image?.markers.find((m) => m.id === $workbench.markerId));
  const dragMarker = $derived(drag?.markerId ?? null);
  const draggedItem = $derived(image?.markers.find((m) => m.id === dragMarker));
  const orderedMarkers = $derived.by(() => {
    const markers = image?.markers ?? [];
    const preview = drag ?? pendingOrder;
    if (!preview || preview.projectId !== project?.id || preview.imageId !== image?.id)
      return markers;
    const byId = new Map(markers.map((item) => [item.id, item]));
    return preview.ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  });
  const markerNumber = (id: string) =>
    (image?.markers.findIndex((item) => item.id === id) ?? -1) + 1;
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
  function releasePointer() {
    const target = capturedPointer,
      pointer = holdPointer;
    capturedPointer = null;
    holdPointer = -1;
    if (target?.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
  }
  function cancelDrag() {
    if (dragMarker) suppressMarkerClickUntil = performance.now() + 250;
    drag = null;
    holdMarker = null;
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    releasePointer();
    hovered = null;
    popups.close('interaction');
  }
  function hold(event: PointerEvent, markerId: string) {
    if (event.button !== 0 || holdPointer !== -1 || pendingOrder || !project || !image) return;
    holdStart = { x: event.clientX, y: event.clientY };
    pointerPosition = holdStart;
    holdPointer = event.pointerId;
    holdMarker = markerId;
    holdScope = JSON.stringify([project.id, image.id]);
    const target = event.currentTarget as HTMLElement;
    holdTimer = setTimeout(() => {
      if (
        !project ||
        !image ||
        !listElement ||
        holdMarker !== markerId ||
        holdScope !== JSON.stringify([project.id, image.id])
      )
        return;
      const bounds = target.closest<HTMLElement>('.translation-item')?.getBoundingClientRect();
      if (!bounds) return cancelDrag();
      const ids = image.markers.map((item) => item.id);
      drag = {
        projectId: project.id,
        imageId: image.id,
        markerId,
        originalIds: ids,
        ids: [...ids],
        x: pointerPosition.x,
        y: pointerPosition.y,
        offsetX: holdStart.x - bounds.left,
        offsetY: holdStart.y - bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      holdMarker = null;
      hovered = null;
      popups.close('interaction');
      // Capture on the stable list: the source row moves in the keyed preview.
      capturedPointer = listElement;
      listElement.setPointerCapture(event.pointerId);
      scrollFrame = requestAnimationFrame(scrollDrag);
    }, 1000);
  }
  function holdingMove(event: PointerEvent) {
    if (event.pointerId !== holdPointer) return;
    pointerPosition = { x: event.clientX, y: event.clientY };
    if (!dragMarker && Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > 10) {
      clearTimeout(holdTimer);
      holdMarker = null;
      holdPointer = -1;
      return;
    }
    if (drag) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updatePreview();
    }
  }
  function updatePreview() {
    if (!drag || !listElement) return;
    const bounds = listElement.getBoundingClientRect();
    if (drag.x < bounds.left || drag.x > bounds.right) return;
    const ids: string[] = [];
    let insertion = 0;
    for (const row of listElement.querySelectorAll<HTMLElement>('.translation-item')) {
      const id = row.dataset.markerId;
      if (!id || id === drag.markerId) continue;
      const rowBounds = row.getBoundingClientRect();
      // FLIP animates only the view; insertion follows each row's final layout.
      const transform = getComputedStyle(row).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      if (drag.y > rowBounds.top - offset + rowBounds.height / 2) insertion += 1;
      ids.push(id);
    }
    ids.splice(insertion, 0, drag.markerId);
    if (ids.some((id, index) => id !== drag!.ids[index])) drag.ids = ids;
  }
  function scrollDrag() {
    if (!drag || !listElement) return;
    const bounds = listElement.getBoundingClientRect();
    const before = listElement.scrollTop;
    if (drag.x >= bounds.left && drag.x <= bounds.right) {
      if (drag.y < bounds.top + 40)
        listElement.scrollTop -= Math.min(18, (bounds.top + 40 - drag.y) * 0.45);
      else if (drag.y > bounds.bottom - 40)
        listElement.scrollTop += Math.min(18, (drag.y - bounds.bottom + 40) * 0.45);
    }
    if (listElement.scrollTop !== before) updatePreview();
    scrollFrame = requestAnimationFrame(scrollDrag);
  }
  function dropMarker(event: PointerEvent) {
    if (event.pointerId !== holdPointer) return;
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    holdMarker = null;
    if (!drag || !listElement) {
      releasePointer();
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    updatePreview();
    const bounds = listElement.getBoundingClientRect();
    const final = drag;
    const inside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;
    suppressMarkerClickUntil = performance.now() + 250;
    if (inside && final.ids.some((id, index) => id !== final.originalIds[index])) {
      const pending: PendingOrder = {
        token: ++orderToken,
        projectId: final.projectId,
        imageId: final.imageId,
        ids: [...final.ids],
      };
      pendingOrder = pending;
      // Transport failures leave this promise pending until the same command is
      // retried. Keep the preview throughout that wait, then render the ACK first.
      void workbench
        .documentCommand(
          { type: 'reorderMarkers', imageId: pending.imageId, markerIds: pending.ids },
          '重排标记',
          pending.projectId,
        )
        .catch((error) => workbench.notice(message(error)))
        .finally(async () => {
          await tick();
          if (pendingOrder?.token === pending.token) pendingOrder = null;
        });
    }
    drag = null;
    hovered = null;
    releasePointer();
  }

  $effect(() => {
    const scope = JSON.stringify([project?.id, image?.id]);
    const ids = image?.markers.map((item) => item.id) ?? [];
    untrack(() => {
      if (scope !== previousScope) {
        previousScope = scope;
        cancelDrag();
        pendingOrder = null;
      } else if (holdMarker && !ids.includes(holdMarker)) {
        cancelDrag();
      } else if (
        drag &&
        (ids.length !== drag.originalIds.length ||
          ids.some((id, index) => id !== drag!.originalIds[index]))
      ) {
        cancelDrag();
      }
      if (
        pendingOrder &&
        (ids.length !== pendingOrder.ids.length || pendingOrder.ids.some((id) => !ids.includes(id)))
      )
        pendingOrder = null;
    });
  });

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
    cancelDrag();
    pendingOrder = null;
  });
</script>

<svelte:window
  onpointermove={holdingMove}
  onpointerup={dropMarker}
  onpointercancel={(event) => {
    if (event.pointerId === holdPointer) cancelDrag();
  }}
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
  <div
    class="translation-list"
    bind:this={listElement}
    onscroll={updatePreview}
    onlostpointercapture={(event) => {
      if (event.pointerId === holdPointer && drag) cancelDrag();
    }}
  >
    {#each orderedMarkers as item (item.id)}
      <div
        animate:flip={{ duration: 140 }}
        class="translation-item"
        class:selected={item.id === marker?.id}
        class:dragging={dragMarker === item.id}
        class:holding={holdMarker === item.id}
        class:hovered={hovered === item.id}
        style:height={dragMarker === item.id ? `${drag!.height}px` : undefined}
        data-marker-id={item.id}
        role="group"
        aria-label={`标记译文 ${markerNumber(item.id)}`}
        onpointerenter={() => {
          if (!drag) hovered = item.id;
        }}
        onpointerleave={() => {
          if (hovered === item.id) hovered = null;
        }}
      >
        <button
          class="translation-item-main"
          aria-label={`翻译项 ${markerNumber(item.id)}`}
          onpointerdown={(event) => hold(event, item.id)}
          onclick={() => {
            if (!dragMarker && performance.now() > suppressMarkerClickUntil)
              run(() => onselect(marker?.id === item.id ? null : item.id));
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (drag) return;
            popups.open({
              id: 'translation-context',
              trigger: event.currentTarget,
              marker: { id: item.id, x: event.clientX, y: event.clientY },
            });
          }}
        >
          <span class="translation-number">{markerNumber(item.id)}</span><span
            class="translation-preview">{text(item) || '输入翻译…'}</span
          ><Icon name="grip" size={13} />
        </button>
        <button
          class="locate-button"
          title="定位标记"
          aria-label={`定位标记 ${markerNumber(item.id)}`}
          onclick={() => {
            if (!drag && performance.now() > suppressMarkerClickUntil) onlocate(item);
          }}><Icon name="target" size={15} /></button
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
{#if drag && draggedItem}
  <div
    class="translation-item translation-drag-ghost"
    class:selected={draggedItem.id === marker?.id}
    style:left={`${drag.x - drag.offsetX}px`}
    style:top={`${drag.y - drag.offsetY}px`}
    style:width={`${drag.width}px`}
    style:height={`${drag.height}px`}
    data-drag-marker-id={drag.markerId}
    data-testid="translation-drag-ghost"
    aria-hidden="true"
  >
    <div class="translation-item-main">
      <span class="translation-number">{markerNumber(draggedItem.id)}</span>
      <span class="translation-preview">{text(draggedItem) || '输入翻译…'}</span>
      <Icon name="grip" size={13} />
    </div>
    <span class="locate-button"><Icon name="target" size={15} /></span>
  </div>
{/if}
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
