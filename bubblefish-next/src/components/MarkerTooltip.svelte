<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { RichText } from '../generated/core';

  let {
    translation,
    horizontal,
    anchor,
    viewportWidth,
    viewportHeight,
  }: {
    translation: RichText;
    horizontal: boolean;
    anchor: { left: number; right: number; top: number };
    viewportWidth: number;
    viewportHeight: number;
  } = $props();
  let element: HTMLDivElement, content: HTMLDivElement;
  let measuredWidth = $state(0),
    measuredHeight = $state(0),
    truncated = $state(false);
  const maxWidth = $derived(Math.max(1, Math.min(320, viewportWidth - 16)));
  const maxHeight = $derived(Math.max(1, Math.min(320, viewportHeight - 16)));
  const left = $derived(
    Math.max(
      8,
      Math.min(
        anchor.right + 12 + measuredWidth <= viewportWidth - 8
          ? anchor.right + 12
          : anchor.left - measuredWidth - 12,
        viewportWidth - measuredWidth - 8,
      ),
    ),
  );
  const top = $derived(Math.max(8, Math.min(anchor.top, viewportHeight - measuredHeight - 8)));
  function measure() {
    if (!element?.isConnected || !content) return;
    const bounds = element.getBoundingClientRect();
    measuredWidth = bounds.width;
    measuredHeight = bounds.height;
    truncated =
      content.scrollWidth > content.clientWidth + 1 ||
      content.scrollHeight > content.clientHeight + 1;
  }
  $effect(() => {
    translation;
    horizontal;
    maxWidth;
    maxHeight;
    void tick().then(measure);
  });
  onMount(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  });
</script>

<div
  class="marker-tooltip"
  class:horizontal
  class:truncated
  bind:this={element}
  role="tooltip"
  aria-label="译文预览"
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:--tooltip-max-width={`${maxWidth}px`}
  style:--tooltip-max-height={`${maxHeight}px`}
  style:visibility={measuredWidth ? 'visible' : 'hidden'}
>
  <div class="marker-tooltip-content" bind:this={content}>
    {#each translation.runs as run}<span
        class:bold={run.marks.includes('bold')}
        class:italic={run.marks.includes('italic')}
        class:strike={run.marks.includes('strike')}
        class:emphasis={run.marks.includes('emphasis')}>{run.text}</span
      >{/each}
  </div>
  {#if truncated}<span class="marker-tooltip-ellipsis" aria-label="译文过长，更多内容请在编辑器查看"
      >…</span
    >{/if}
</div>

<style>
  .marker-tooltip {
    position: absolute;
    z-index: 8;
    width: max-content;
    max-width: var(--tooltip-max-width);
    max-height: var(--tooltip-max-height);
    padding: 8px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--strong);
    box-shadow: 0 4px 18px #0003;
    pointer-events: none;
    user-select: none;
  }
  .marker-tooltip-content {
    max-width: max(1px, calc(var(--tooltip-max-width) - 18px));
    max-height: max(1px, calc(var(--tooltip-max-height) - 18px));
    overflow: hidden;
    font-size: 14px;
    font-weight: 400;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }
  .horizontal .marker-tooltip-content {
    writing-mode: horizontal-tb;
  }
  .bold {
    font-weight: 700;
  }
  .italic {
    font-style: italic;
  }
  .strike {
    text-decoration: line-through;
  }
  .emphasis {
    text-emphasis: filled dot;
    text-emphasis-position: under;
  }
  .marker-tooltip-ellipsis {
    position: absolute;
    right: 2px;
    bottom: 2px;
    padding: 0 3px;
    background: var(--surface);
    font-size: 14px;
    line-height: 16px;
  }
</style>
