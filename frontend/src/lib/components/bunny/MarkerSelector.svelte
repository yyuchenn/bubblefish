<script lang="ts">
	import { markers } from '$lib/services/markerService';
	import { bunnyStore, selectedMarkerIds, markerData } from '$lib/stores/bunnyStore';
	import type { Marker } from '$lib/types';
	
	// Filter to only show rectangle markers
	$: rectangleMarkers = $markers.filter(m => m.geometry.type === 'rectangle');
	
	function toggleMarker(markerId: number) {
		bunnyStore.toggleMarkerSelection(markerId);
	}
	
	function selectAll() {
		const markerIds = rectangleMarkers.map(m => m.id);
		bunnyStore.selectAllMarkers(markerIds);
	}
	
	function clearSelection() {
		bunnyStore.clearSelection();
	}
	
	function getMarkerStatus(markerId: number) {
		const data = $markerData.get(markerId);
		if (!data) return '';
		
		const hasOCR = !!data.ocrText;
		const hasTranslation = !!data.translation;
		
		if (hasOCR && hasTranslation) return '✓✓';
		if (hasOCR) return '✓-';
		if (hasTranslation) return '-✓';
		return '--';
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 border-b border-theme-outline">
		<span class="text-xs font-medium text-theme-on-surface">矩形标记</span>
		<div class="flex gap-1">
			<button
				class="px-2 py-1 text-xs rounded hover:bg-theme-surface-variant"
				on:click={selectAll}
				title="全选"
			>
				全选
			</button>
			<button
				class="px-2 py-1 text-xs rounded hover:bg-theme-surface-variant"
				on:click={clearSelection}
				title="清除"
			>
				清除
			</button>
		</div>
	</div>
	
	<div class="flex-1 overflow-y-auto">
		{#if rectangleMarkers.length === 0}
			<div class="p-4 text-center text-sm text-theme-on-surface-variant">
				当前图片无矩形标记
			</div>
		{:else}
			<div class="p-2 space-y-1">
				{#each rectangleMarkers as marker (marker.id)}
					<button
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-theme-surface-variant transition-colors
							{$selectedMarkerIds.has(marker.id) ? 'bg-theme-primary/10 border border-theme-primary' : 'border border-transparent'}"
						on:click={() => toggleMarker(marker.id)}
					>
						<input
							type="checkbox"
							checked={$selectedMarkerIds.has(marker.id)}
							class="pointer-events-none"
						/>
						<span class="flex-1 text-sm text-theme-on-surface">
							标记 {marker.imageIndex}
						</span>
						<span class="text-xs font-mono text-theme-on-surface-variant">
							{getMarkerStatus(marker.id)}
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
	
	<div class="px-3 py-2 border-t border-theme-outline text-xs text-theme-on-surface-variant">
		已选择 {$selectedMarkerIds.size} / {rectangleMarkers.length}
	</div>
</div>

<style>
	input[type="checkbox"] {
		width: 14px;
		height: 14px;
	}
</style>