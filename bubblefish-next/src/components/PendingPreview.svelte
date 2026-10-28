<script lang="ts">
  import { onMount } from 'svelte';
  import type { PickedFile } from '../runtime/platform';
  import { createThumbnail } from '../runtime/thumbnails';
  let { picked }: { picked: PickedFile } = $props();
  let element: HTMLSpanElement,
    url = $state('');
  onMount(() => {
    let disposed = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void createThumbnail(picked, () => disposed)
        .then((value) => {
          if (!disposed) url = value ?? '';
        })
        .catch(() => {});
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      url = '';
    };
  });
</script>

<span class="pending-preview" bind:this={element}
  >{#if url}<img src={url} alt={picked.name} />{:else}▧{/if}</span
>
