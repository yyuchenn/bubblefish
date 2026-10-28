<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    plus: 'M12 5v14M5 12h14',
    folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1l-2 11H3V7Z',
    save: 'M5 3h12l4 4v14H3V3h2Zm2 0v7h10V3M7 21v-7h10v7',
    undo: 'M9 5 3 11l6 6M3 11h11a6 6 0 0 1 6 6',
    redo: 'm15 5 6 6-6 6m6-6H10a6 6 0 0 0-6 6',
    images: 'M4 3h16v18H4V3Zm0 13 5-5 4 4 3-3 4 4M8 7h.01',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
    chevron: 'm9 5 7 7-7 7',
    down: 'm6 9 6 6 6-6',
    close: 'm6 6 12 12M6 18 18 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    sort: 'M6 3v18m-3-3 3 3 3-3M13 6h8m-8 6h6m-6 6h4',
    history: 'M3 12a9 9 0 1 0 3-7L3 8m0-5v5h5m4 0v5l3 2',
    target: 'M12 3v3m0 12v3M3 12h3m12 0h3M6 6a8 8 0 1 1 0 12A8 8 0 0 1 6 6Z',
    sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z',
    check: 'm5 12 4 4L19 6',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
    'pane-left': 'M3 4h18v16H3V4Zm6 0v16',
    'pane-right': 'M3 4h18v16H3V4Zm12 0v16',
    'window-minimize': 'M5 12h14',
    'window-maximize': 'M5 5h14v14H5V5Z',
    'window-restore': 'M9 8V4h11v11h-4M4 9h11v11H4V9Z',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.more} /></svg
>
