<script lang="ts">
	import { selectedMarkerIds, markerData } from '$lib/stores/bunnyStore';
	import { markers } from '$lib/services/markerService';

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}

	let machineTranslation = '';
	let copied = false;

	// Get selected marker
	$: selectedMarker = $selectedMarkerIds.size === 1
		? $markers.find(m => $selectedMarkerIds.has(m.id))
		: null;

	// Update machine translation when selection changes
	$: if (selectedMarker) {
		const data = $markerData.get(selectedMarker.id);
		machineTranslation = data?.machineTranslation || '';
	} else {
		machineTranslation = '';
	}

	async function copyToClipboard() {
		if (!machineTranslation) return;

		try {
			await navigator.clipboard.writeText(machineTranslation);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (error) {
			console.error('Failed to copy to clipboard:', error);
		}
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 border-b border-theme-outline min-h-[36px]">
		<span class="text-xs font-medium text-theme-on-surface">机器翻译</span>
		<div class="flex gap-1 h-[28px] items-center">
			{#if selectedMarker && machineTranslation}
				<button
					class="px-2 py-1 text-xs rounded hover:bg-theme-surface-variant transition-colors flex items-center justify-center"
					on:click={copyToClipboard}
					title="复制到剪贴板"
				>
					{#if copied}
						<!-- Check icon -->
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="20 6 9 17 4 12"></polyline>
						</svg>
					{:else}
						<!-- Copy icon -->
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
					{/if}
				</button>
			{/if}
		</div>
	</div>
	
	<div class="flex-1 overflow-y-auto p-3" on:wheel={handleWheel}>
		{#if !selectedMarker}
			<div class="text-sm text-theme-on-surface-variant text-center">
				请选择一个标记查看机器翻译
			</div>
		{:else if !machineTranslation}
			<div class="text-sm text-theme-on-surface-variant text-center">
				该标记暂无机器翻译
			</div>
		{:else}
			<div class="text-sm text-theme-on-surface whitespace-pre-wrap">
				{machineTranslation}
			</div>
		{/if}
	</div>
</div>