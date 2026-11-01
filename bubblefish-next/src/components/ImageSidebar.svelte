<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import Icon from './Icon.svelte';
  import Thumbnail from './Thumbnail.svelte';
  import type { ProjectDocument } from '../generated/core';
  import type { AssetStore } from '../runtime/assets';
  import type { ProjectView } from '../runtime/workbench';

  type ProjectChange = Partial<Pick<ProjectDocument, 'name' | 'sourceLanguage' | 'targetLanguage'>>;
  let {
    project,
    assets,
    selectedImageId,
    mode,
    width,
    onselect,
    onadd,
    onremove,
    onreorder,
    onerror,
    onsort,
    onprojectchange,
  }: {
    project?: ProjectView;
    assets: AssetStore;
    selectedImageId: string | null;
    mode: 'images' | 'settings';
    width: number;
    onselect: (id: string) => void;
    onadd: () => void;
    onremove: (id: string) => void;
    onreorder: (projectId: string, imageIds: string[]) => Promise<unknown>;
    onerror: (error: unknown) => void;
    onsort: () => void;
    onprojectchange: (patch: ProjectChange, label: string) => void;
  } = $props();

  interface ImageDrag {
    projectId: string;
    imageId: string;
    originalIds: string[];
    ids: string[];
    thumbnailUrl?: string;
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
    originalIds: string[];
    ids: string[];
    visible: boolean;
  }
  let listElement = $state<HTMLDivElement>(),
    drag = $state<ImageDrag | null>(null),
    pendingOrder = $state<PendingOrder | null>(null),
    holdImage = $state<string | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | undefined,
    holdPointer = -1,
    holdStart = { x: 0, y: 0 },
    pointerPosition = { x: 0, y: 0 },
    holdScope = '',
    heldImageIds: string[] = [],
    capturedPointer: HTMLElement | null = null,
    scrollFrame = 0,
    suppressImagePointerClick = false,
    orderToken = 0,
    previousScope = '';
  const dragImage = $derived(drag?.imageId ?? null);
  const draggedItem = $derived(project?.images.find((item) => item.id === dragImage));
  const orderedImages = $derived.by(() => {
    const images = project?.images ?? [];
    const preview = drag ?? (pendingOrder?.visible ? pendingOrder : null);
    if (!preview || preview.projectId !== project?.id || mode !== 'settings') return images;
    const byId = new Map(images.map((item) => [item.id, item]));
    return preview.ids.flatMap((id) => {
      const image = byId.get(id);
      return image ? [image] : [];
    });
  });
  const pageNumbers = $derived(
    new Map(project?.images.map((item, index) => [item.id, index + 1]) ?? []),
  );
  const languages = [
    ['japanese', '日语'],
    ['english', '英语'],
    ['simplifiedChinese', '简体中文'],
    ['traditionalChinese', '繁体中文'],
  ];

  function releasePointer() {
    const target = capturedPointer,
      pointer = holdPointer;
    capturedPointer = null;
    holdPointer = -1;
    if (target?.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
  }
  function cancelDrag() {
    if (holdPointer !== -1 || drag) suppressImagePointerClick = true;
    drag = null;
    holdImage = null;
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    releasePointer();
  }
  function hold(event: PointerEvent, imageId: string) {
    if (event.button !== 0) return;
    // A new primary press starts a genuine click sequence. A canceled hold's
    // eventual click remains suppressed for as long as that pointer stays down.
    suppressImagePointerClick = false;
    if (mode !== 'settings' || !project || holdPointer !== -1 || pendingOrder) return;
    holdPointer = event.pointerId;
    holdImage = imageId;
    holdStart = { x: event.clientX, y: event.clientY };
    pointerPosition = holdStart;
    holdScope = JSON.stringify([project.id, mode, selectedImageId]);
    heldImageIds = project.images.map((item) => item.id);
    const target = event.currentTarget as HTMLElement;
    holdTimer = setTimeout(() => {
      if (
        !project ||
        !listElement ||
        holdImage !== imageId ||
        holdScope !== JSON.stringify([project.id, mode, selectedImageId])
      )
        return;
      const row = target.closest<HTMLElement>('.image-row');
      if (!row?.isConnected) return cancelDrag();
      const bounds = row.getBoundingClientRect();
      const thumbnail = row.querySelector<HTMLImageElement>('.thumbnail-image img');
      const ids = project.images.map((item) => item.id);
      drag = {
        projectId: project.id,
        imageId,
        originalIds: ids,
        ids: [...ids],
        // Reuse only the thumbnail already displayed by this row. The floating
        // copy never requests an original image, decode, or another Thumbnail.
        thumbnailUrl:
          thumbnail?.complete && thumbnail.naturalWidth > 0
            ? thumbnail.currentSrc || thumbnail.src
            : undefined,
        x: pointerPosition.x,
        y: pointerPosition.y,
        offsetX: holdStart.x - bounds.left,
        offsetY: holdStart.y - bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      holdImage = null;
      // The list survives keyed row moves, keeping pointer capture stable.
      capturedPointer = listElement;
      listElement.setPointerCapture(event.pointerId);
      scrollFrame = requestAnimationFrame(scrollDrag);
    }, 1000);
  }
  function holdingMove(event: PointerEvent) {
    if (event.pointerId !== holdPointer) return;
    pointerPosition = { x: event.clientX, y: event.clientY };
    if (!drag && Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > 10) {
      cancelDrag();
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
    for (const row of listElement.querySelectorAll<HTMLElement>('.image-row')) {
      const id = row.dataset.imageId;
      if (!id || id === drag.imageId) continue;
      const rowBounds = row.getBoundingClientRect();
      const transform = getComputedStyle(row).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      if (drag.y > rowBounds.top - offset + rowBounds.height / 2) insertion += 1;
      ids.push(id);
    }
    ids.splice(insertion, 0, drag.imageId);
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
  function dropImage(event: PointerEvent) {
    if (event.pointerId !== holdPointer) return;
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollFrame);
    holdImage = null;
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
    suppressImagePointerClick = true;
    if (inside && final.ids.some((id, index) => id !== final.originalIds[index])) {
      const pending: PendingOrder = {
        token: ++orderToken,
        projectId: final.projectId,
        originalIds: [...final.originalIds],
        ids: [...final.ids],
        visible: true,
      };
      pendingOrder = pending;
      // A transport error keeps the callback pending until its command is
      // retried. Keep the candidate order until the authoritative view renders.
      void onreorder(pending.projectId, pending.ids)
        .catch(onerror)
        .finally(async () => {
          await tick();
          if (pendingOrder?.token === pending.token) pendingOrder = null;
        });
    }
    drag = null;
    releasePointer();
  }

  $effect(() => {
    const scope = JSON.stringify([project?.id, mode, selectedImageId]);
    const ids = project?.images.map((item) => item.id) ?? [];
    untrack(() => {
      if (scope !== previousScope) {
        previousScope = scope;
        cancelDrag();
        if (pendingOrder) pendingOrder.visible = false;
      } else if (
        holdImage &&
        (ids.length !== heldImageIds.length || ids.some((id, index) => id !== heldImageIds[index]))
      ) {
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
        ![pendingOrder.originalIds, pendingOrder.ids].some(
          (order) => ids.length === order.length && ids.every((id, index) => id === order[index]),
        )
      )
        pendingOrder.visible = false;
    });
  });
  onMount(() => () => {
    cancelDrag();
    pendingOrder = null;
  });

  function rename(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (!project || event.isComposing) return;
    if (event.key === 'Enter') {
      onprojectchange({ name: event.currentTarget.value }, '修改项目名称');
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.currentTarget.value = project.name;
      event.currentTarget.blur();
    }
  }
</script>

<svelte:window
  onpointermove={holdingMove}
  onpointerup={dropImage}
  onpointercancel={(event) => {
    if (event.pointerId === holdPointer) cancelDrag();
  }}
  onblur={cancelDrag}
  onkeydown={(event) => {
    if (event.key === 'Escape') cancelDrag();
  }}
/>

<aside class="left-panel" style:width={`${width}px`}>
  <div class="panel-heading">
    <span>{mode === 'images' ? '图片' : '项目配置'}</span>
    <span class="muted count">{project?.images.length ?? 0}</span>
    <div class="grow"></div>
    <button
      class="icon-button"
      title="添加图片"
      aria-label="添加图片"
      disabled={!project}
      onclick={onadd}><Icon name="plus" size={16} /></button
    >
  </div>
  {#if mode === 'settings' && project}
    <div class="project-settings">
      <label>
        项目名称<input
          aria-label="修改项目名称"
          value={project.name}
          onkeydown={rename}
          onblur={(event) => {
            if (project) event.currentTarget.value = project.name;
          }}
        />
      </label>
      <label>
        原文语言<select
          aria-label="原文语言"
          value={project.sourceLanguage}
          onchange={(event) =>
            onprojectchange({ sourceLanguage: event.currentTarget.value }, '修改原文语言')}
          >{#each languages as [value, label]}<option {value}>{label}</option>{/each}</select
        >
      </label>
      <label>
        译文语言<select
          aria-label="译文语言"
          value={project.targetLanguage}
          onchange={(event) =>
            onprojectchange({ targetLanguage: event.currentTarget.value }, '修改译文语言')}
          >{#each languages as [value, label]}<option {value}>{label}</option>{/each}</select
        >
      </label>
      <hr />
      <div class="section-label">图片管理</div>
      <button class="subtle-button" onclick={onsort}
        ><Icon name="sort" size={15} />按文件名自然排序</button
      >
    </div>
  {/if}
  <div
    class="image-list"
    class:reordering={!!drag || !!pendingOrder?.visible}
    bind:this={listElement}
    onscroll={updatePreview}
    onlostpointercapture={(event) => {
      if (event.pointerId === holdPointer && drag) cancelDrag();
    }}
  >
    {#each orderedImages as item (item.id)}
      <div
        animate:flip={{ duration: 140 }}
        class="image-row"
        role="group"
        aria-label={`图片管理 ${pageNumbers.get(item.id)}`}
        class:current={item.id === selectedImageId}
        class:dragging={dragImage === item.id}
        class:holding={holdImage === item.id}
        style:height={dragImage === item.id ? `${drag!.height}px` : undefined}
        data-image-id={item.id}
      >
        <button
          class="image-select"
          aria-label={`图片 ${pageNumbers.get(item.id)} ${item.filename}`}
          onpointerdown={(event) => hold(event, item.id)}
          onclick={(event) => {
            if (event.detail > 0 && suppressImagePointerClick) {
              suppressImagePointerClick = false;
              return;
            }
            if (!drag) onselect(item.id);
          }}
        >
          <Thumbnail assetId={item.assetId} {assets} alt={item.filename} />
          <span class="image-info">
            <span>{item.filename}</span>
            <small>{item.width} × {item.height} · {item.markers.length} 个标记</small>
          </span>
          <span class="page-index">{pageNumbers.get(item.id)}</span>
        </button>
        {#if mode === 'settings'}
          <button
            class="delete-image"
            title="删除图片"
            aria-label={`删除图片 ${pageNumbers.get(item.id)}`}
            onclick={() => onremove(item.id)}><Icon name="trash" size={14} /></button
          >
        {/if}
      </div>
    {:else}
      <div class="panel-empty">
        <Icon name="images" size={28} />
        <p>还没有图片</p>
        <small>{project ? '添加漫画页以开始标注' : '新建或打开一个项目'}</small>
      </div>
    {/each}
  </div>
  {#if project}
    <button class="add-images-button" onclick={onadd}><Icon name="plus" size={16} />添加图片</button
    >
  {/if}
</aside>
{#if drag && draggedItem}
  <div
    class="image-row image-drag-ghost"
    class:current={draggedItem.id === selectedImageId}
    style:left={`${drag.x - drag.offsetX}px`}
    style:top={`${drag.y - drag.offsetY}px`}
    style:width={`${drag.width}px`}
    style:height={`${drag.height}px`}
    data-drag-image-id={drag.imageId}
    data-testid="image-drag-ghost"
    aria-hidden="true"
  >
    <div class="image-select">
      <div class="thumbnail-image">
        {#if drag.thumbnailUrl}<img
            src={drag.thumbnailUrl}
            alt={draggedItem.filename}
            draggable="false"
          />{:else}<span>▧</span>{/if}
      </div>
      <span class="image-info">
        <span>{draggedItem.filename}</span>
        <small
          >{draggedItem.width} × {draggedItem.height} · {draggedItem.markers.length} 个标记</small
        >
      </span>
      <span class="page-index">{pageNumbers.get(draggedItem.id)}</span>
    </div>
    <span class="delete-image"><Icon name="trash" size={14} /></span>
  </div>
{/if}
