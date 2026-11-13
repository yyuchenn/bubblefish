<script lang="ts">
  import { onMount } from 'svelte';
  import type { AssetStore } from '../runtime/assets';
  let { assetId, assets, alt }: { assetId: string; assets: AssetStore; alt: string } = $props();
  let element: HTMLDivElement,
    url = $state<string>(),
    visible = $state(false);
  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          visible = true;
          observer.disconnect();
          void assets.thumbnail(assetId).then((result) => (url = result));
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div class="thumbnail-image" bind:this={element}>
  {#if visible && url}<img src={url} {alt} draggable="false" />{:else}<span>▧</span>{/if}
</div>
