<script lang="ts">
  import { onMount } from 'svelte';
  import type { Geometry, ImageDocument, Marker } from '../generated/core';
  import type { AssetStore } from '../runtime/assets';
  import { usePopups } from '../runtime/popups';
  export type ZoomMode = 'fit' | 'width' | 'height' | 'free';
  let {
    image,
    assets,
    selectedId,
    pendingGeometries = {},
    hoveredId,
    onhover,
    onselect,
    onadd,
    onchange,
    onerror,
    onmenu,
    onview,
  }: {
    image: ImageDocument;
    assets: AssetStore;
    selectedId: string | null;
    pendingGeometries?: Record<string, Geometry>;
    hoveredId: string | null;
    onhover: (id: string | null) => void;
    onselect: (id: string) => void;
    onadd: (geometry: Geometry) => void;
    onchange: (id: string, geometry: Geometry) => Promise<unknown>;
    onerror: (error: unknown) => void;
    onmenu: (id: string, action: 'delete' | 'convert') => void;
    onview: (view: { scale: number; mode: ZoomMode; outside: boolean }) => void;
  } = $props();
  let viewport: HTMLDivElement;
  let width = $state(0),
    height = $state(0),
    scale = $state(1),
    x = $state(0),
    y = $state(0);
  let mode = $state<ZoomMode>('fit');
  let preview = $state<{ id?: string; geometry: Geometry } | null>(null);
  const popups = usePopups();
  const context = $derived($popups?.id === 'canvas-context' ? ($popups.marker ?? null) : null);
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  type Gesture = {
    type: 'pan' | 'draw' | 'move' | 'resize';
    id: number;
    sx: number;
    sy: number;
    point: { x: number; y: number };
    original?: Geometry;
    markerId?: string;
    handle?: string;
    viewX: number;
    viewY: number;
  };
  let gesture: Gesture | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: {
    distance: number;
    scale: number;
    centerX: number;
    centerY: number;
    viewX: number;
    viewY: number;
  } | null = null;
  let lastImageId = '';
  const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
  const outside = $derived(
    x + image.width * scale < 0 || y + image.height * scale < 0 || x > width || y > height,
  );
  const src = $derived(assets.get(image.assetId)?.url ?? '');
  function displayGeometry(marker: Marker): Geometry {
    return preview?.id === marker.id
      ? preview.geometry
      : (pendingGeometries[marker.id] ?? marker.geometry);
  }
  function point(clientX: number, clientY: number) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left - x) / (image.width * scale)),
      y: clamp((clientY - rect.top - y) / (image.height * scale)),
    };
  }
  function rect(a: { x: number; y: number }, b: { x: number; y: number }): Geometry {
    return {
      type: 'rectangle',
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }
  export function setMode(value: ZoomMode) {
    mode = value;
    if (!width || !height || !image.width || !image.height) return;
    const fitWidth = Math.max(1, width - 40) / image.width,
      fitHeight = Math.max(1, height - 40) / image.height;
    if (value !== 'free')
      scale = clamp(
        value === 'width'
          ? fitWidth
          : value === 'height'
            ? fitHeight
            : Math.min(fitWidth, fitHeight),
        0.001,
        10,
      );
    x = (width - image.width * scale) / 2;
    y = (height - image.height * scale) / 2;
    if (value === 'width' && image.height * scale > height) y = 20;
    if (value === 'height' && image.width * scale > width) x = width - image.width * scale - 20;
  }
  export function zoomTo(value: number, anchorX = width / 2, anchorY = height / 2) {
    const next = clamp(value, 0.001, 10),
      ratio = next / scale;
    x = anchorX - (anchorX - x) * ratio;
    y = anchorY - (anchorY - y) * ratio;
    scale = next;
    mode = 'free';
  }
  export function reset() {
    setMode(mode === 'free' ? 'fit' : mode);
  }
  export function locate(marker: Marker) {
    const geometry = displayGeometry(marker);
    const cx = geometry.x + (geometry.type === 'rectangle' ? geometry.width / 2 : 0),
      cy = geometry.y + (geometry.type === 'rectangle' ? geometry.height / 2 : 0);
    x = width / 2 - cx * image.width * scale;
    y = height / 2 - cy * image.height * scale;
  }
  function pinchInfo() {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
  }
  function down(event: PointerEvent) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    popups.close('interaction');
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      gesture = null;
      preview = null;
      pinch = { ...pinchInfo(), scale, viewX: x, viewY: y };
      event.preventDefault();
      return;
    }
    if (pointers.size > 2) return;
    const bounds = viewport.getBoundingClientRect(),
      localX = event.clientX - bounds.left,
      localY = event.clientY - bounds.top;
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      (localX < x ||
        localY < y ||
        localX > x + image.width * scale ||
        localY > y + image.height * scale)
    ) {
      gesture = null;
      return;
    }
    gesture = {
      type: event.ctrlKey || event.metaKey ? 'pan' : 'draw',
      id: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      point: point(event.clientX, event.clientY),
      viewX: x,
      viewY: y,
    };
    event.preventDefault();
  }
  function markerDown(event: PointerEvent, marker: Marker, handle?: string) {
    if (event.ctrlKey || event.metaKey) return;
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    event.stopPropagation();
    event.preventDefault();
    popups.close('interaction');
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (pointers.size >= 2) {
      gesture = null;
      preview = null;
      pinch = { ...pinchInfo(), scale, viewX: x, viewY: y };
      return;
    }
    onselect(marker.id);
    gesture = {
      type: handle ? 'resize' : 'move',
      id: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      point: point(event.clientX, event.clientY),
      original: { ...displayGeometry(marker) },
      markerId: marker.id,
      handle,
      viewX: x,
      viewY: y,
    };
  }
  function move(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const info = pinchInfo(),
        bounds = viewport.getBoundingClientRect();
      const next = clamp((pinch.scale * info.distance) / Math.max(1, pinch.distance), 0.001, 10),
        ratio = next / pinch.scale;
      x = info.centerX - bounds.left - (pinch.centerX - bounds.left - pinch.viewX) * ratio;
      y = info.centerY - bounds.top - (pinch.centerY - bounds.top - pinch.viewY) * ratio;
      scale = next;
      mode = 'free';
      return;
    }
    if (!gesture || gesture.id !== event.pointerId) return;
    const g = gesture,
      current = point(event.clientX, event.clientY);
    if (g.type === 'pan') {
      x = g.viewX + event.clientX - g.sx;
      y = g.viewY + event.clientY - g.sy;
      return;
    }
    if (g.type === 'draw') {
      preview = { geometry: rect(g.point, current) };
      return;
    }
    const original = g.original!;
    const dx = (event.clientX - g.sx) / (image.width * scale),
      dy = (event.clientY - g.sy) / (image.height * scale);
    if (g.type === 'move') {
      preview = {
        id: g.markerId,
        geometry: {
          ...original,
          x: clamp(original.x + dx, 0, original.type === 'rectangle' ? 1 - original.width : 1),
          y: clamp(original.y + dy, 0, original.type === 'rectangle' ? 1 - original.height : 1),
        },
      };
    } else if (original.type === 'rectangle') {
      let left = original.x,
        top = original.y,
        right = original.x + original.width,
        bottom = original.y + original.height;
      if (g.handle!.includes('w')) left = clamp(left + dx);
      if (g.handle!.includes('e')) right = clamp(right + dx);
      if (g.handle!.includes('n')) top = clamp(top + dy);
      if (g.handle!.includes('s')) bottom = clamp(bottom + dy);
      const next = rect({ x: left, y: top }, { x: right, y: bottom });
      if (next.type === 'rectangle' && next.width >= 0.001 && next.height >= 0.001)
        preview = { id: g.markerId, geometry: next };
    }
  }
  function up(event: PointerEvent, cancel = false) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      gesture = null;
      preview = null;
      return;
    }
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    if (!cancel) {
      if (g.type === 'draw') {
        const drawn = rect(g.point, point(event.clientX, event.clientY));
        onadd(
          drawn.type === 'rectangle' && drawn.width >= 0.01 && drawn.height >= 0.01
            ? drawn
            : { type: 'point', ...g.point },
        );
      } else if (
        g.markerId &&
        preview &&
        Math.hypot(event.clientX - g.sx, event.clientY - g.sy) > 2
      )
        void onchange(g.markerId, preview.geometry).catch(onerror);
    }
    gesture = null;
    preview = null;
  }
  function wheel(event: WheelEvent) {
    event.preventDefault();
    popups.close('interaction');
    if (event.ctrlKey || event.metaKey) {
      const r = viewport.getBoundingClientRect();
      zoomTo(
        scale * Math.exp(-event.deltaY * 0.002),
        event.clientX - r.left,
        event.clientY - r.top,
      );
    } else if (event.shiftKey) {
      x -= event.deltaY;
      y -= event.deltaX;
    } else {
      x -= event.deltaX;
      y -= event.deltaY;
    }
  }
  function openMenu(event: MouseEvent, markerId: string) {
    event.preventDefault();
    event.stopPropagation();
    onselect(markerId);
    const r = viewport.getBoundingClientRect();
    popups.open({
      id: 'canvas-context',
      trigger: event.currentTarget as HTMLElement,
      marker: {
        id: markerId,
        x: clamp(event.clientX - r.left, 0, Math.max(0, width - 180)),
        y: clamp(event.clientY - r.top, 0, Math.max(0, height - 100)),
      },
    });
  }
  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
      height = entries[0].contentRect.height;
      if (mode !== 'free') setMode(mode);
    });
    observer.observe(viewport);
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('wheel', wheel);
    };
  });
  $effect(() => {
    if (image.id !== lastImageId) {
      lastImageId = image.id;
      gesture = null;
      preview = null;
      pointers.clear();
      pinch = null;
      setMode(mode === 'free' ? 'fit' : mode);
    }
  });
  $effect(() => {
    onview({ scale, mode, outside });
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      gesture = null;
      preview = null;
      popups.close('escape');
      pointers.clear();
      pinch = null;
    }
  }}
  onblur={() => {
    gesture = null;
    preview = null;
    pointers.clear();
    pinch = null;
  }}
/>
<div
  class="canvas-viewport"
  data-popup-canvas
  bind:this={viewport}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={(event) => up(event)}
  onpointercancel={(event) => up(event, true)}
  role="application"
  aria-label="图片标注画布"
  tabindex="-1"
  oncontextmenu={(event) => event.preventDefault()}
>
  <div
    class="canvas-sheet"
    style:left={`${x}px`}
    style:top={`${y}px`}
    style:width={`${image.width * scale}px`}
    style:height={`${image.height * scale}px`}
  >
    <img {src} alt={image.filename} draggable="false" class="canvas-image" />
    {#each image.markers as marker, index (marker.id)}
      {@const geometry = displayGeometry(marker)}
      <div
        class="canvas-marker"
        class:selected={selectedId === marker.id}
        class:hovered={hoveredId === marker.id}
        class:point={geometry.type === 'point'}
        class:rectangle={geometry.type === 'rectangle'}
        style:left={`${geometry.x * 100}%`}
        style:top={`${geometry.y * 100}%`}
        style:width={geometry.type === 'rectangle' ? `${geometry.width * 100}%` : undefined}
        style:height={geometry.type === 'rectangle' ? `${geometry.height * 100}%` : undefined}
        onpointerdown={(event) => markerDown(event, marker)}
        oncontextmenu={(event) => openMenu(event, marker.id)}
        onpointerenter={() => onhover(marker.id)}
        onpointerleave={() => onhover(null)}
        role="button"
        tabindex="-1"
        aria-label={`标记 ${index + 1}`}
      >
        {#if geometry.type === 'point'}
          <svg class="point-pin" viewBox="0 0 24 32" aria-hidden="true">
            <path
              fill="#fff"
              d="M12 0C5.373 0 0 5.373 0 12c0 6.6 5.2 12.8 12 20 6.8-7.2 12-13.4 12-20C24 5.373 18.627 0 12 0Z"
            />
            <path
              fill="currentColor"
              d="M12 2C6.477 2 2 6.477 2 12c0 5.3 4.3 10.9 10 17.1 5.7-6.2 10-11.8 10-17.1C22 6.477 17.523 2 12 2Z"
            />
          </svg>
        {/if}
        <span class="marker-number">{index + 1}</span>
        {#if geometry.type === 'rectangle' && selectedId === marker.id}
          {#each handles as handle}<button
              class={`resize-handle ${handle}`}
              aria-label={`调整标记 ${handle}`}
              onpointerdown={(event) => markerDown(event, marker, handle)}
            ></button>{/each}
        {/if}
      </div>
    {/each}
    {#if preview && !preview.id && preview.geometry.type === 'rectangle'}
      <div
        class="draw-preview"
        style:left={`${preview.geometry.x * 100}%`}
        style:top={`${preview.geometry.y * 100}%`}
        style:width={`${preview.geometry.width * 100}%`}
        style:height={`${preview.geometry.height * 100}%`}
      ></div>
    {/if}
  </div>
  {#if outside}<button
      class="reset-image"
      onpointerdown={(event) => event.stopPropagation()}
      onclick={reset}>↺ 图片归位</button
    >{/if}
  {#if context}
    <div
      class="context-menu"
      style:left={`${context.x}px`}
      style:top={`${context.y}px`}
      onpointerdown={(event) => event.stopPropagation()}
      role="menu"
      tabindex="-1"
      use:popups.boundary={{ id: 'canvas-context', token: $popups?.token }}
    >
      <button
        onclick={() => {
          const id = context!.id;
          popups.close('action');
          onmenu(id, 'convert');
        }}
        >转换为{image.markers.find((m) => m.id === context!.id)?.geometry.type === 'point'
          ? '矩形'
          : '点'}标记</button
      >
      <button
        class="danger"
        onclick={() => {
          const id = context!.id;
          popups.close('action');
          onmenu(id, 'delete');
        }}>删除标记</button
      >
    </div>
  {/if}
</div>
