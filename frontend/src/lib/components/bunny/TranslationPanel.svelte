<script lang="ts">
	import { selectedMarkerIds, markerData } from '$lib/stores/bunnyStore';
	import { markers } from '$lib/services/markerService';

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}
	
	let translationText = '';
	let isEditing = false;
	
	// Get selected marker
	$: selectedMarker = $selectedMarkerIds.size === 1 
		? $markers.find(m => $selectedMarkerIds.has(m.id))
		: null;
	
	// Update translation text when selection changes
	$: if (selectedMarker) {
		const data = $markerData.get(selectedMarker.id);
		translationText = data?.translation || '';
	} else {
		translationText = '';
	}
	
	async function saveTranslation() {
		if (!selectedMarker) return;
		
		// Save to store and backend
		const { bunnyStore } = await import('$lib/stores/bunnyStore');
		bunnyStore.setTranslation(selectedMarker.id, translationText);
		
		// Update marker translation
		const { coreAPI } = await import('$lib/core/adapter');
		try {
			await coreAPI.updateMarkerTranslation(selectedMarker.id, translationText);
		} catch (error) {
			console.error('Failed to update marker translation:', error);
		}
		
		isEditing = false;
	}
	
	function cancelEdit() {
		if (selectedMarker) {
			const data = $markerData.get(selectedMarker.id);
			translationText = data?.translation || '';
		}
		isEditing = false;
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 border-b border-theme-outline">
		<span class="text-xs font-medium text-theme-on-surface">翻译文本</span>
		{#if selectedMarker && translationText}
			<div class="flex gap-1">
				{#if isEditing}
					<button
						class="px-2 py-1 text-xs rounded bg-theme-primary text-theme-on-primary hover:opacity-90"
						on:click={saveTranslation}
					>
						保存
					</button>
					<button
						class="px-2 py-1 text-xs rounded hover:bg-theme-surface-variant"
						on:click={cancelEdit}
					>
						取消
					</button>
				{:else}
					<button
						class="px-2 py-1 text-xs rounded hover:bg-theme-surface-variant"
						on:click={() => isEditing = true}
					>
						编辑
					</button>
				{/if}
			</div>
		{/if}
	</div>
	
	<div class="flex-1 overflow-y-auto p-3" on:wheel={handleWheel}>
		{#if !selectedMarker}
			<div class="text-sm text-theme-on-surface-variant text-center">
				请选择一个标记查看翻译文本
			</div>
		{:else if !translationText}
			<div class="text-sm text-theme-on-surface-variant text-center">
				该标记暂无翻译文本
			</div>
		{:else if isEditing}
			<textarea
				bind:value={translationText}
				class="w-full h-full p-2 text-sm bg-theme-surface border border-theme-outline rounded resize-none focus:outline-none focus:border-theme-primary"
				placeholder="输入翻译文本..."
			></textarea>
		{:else}
			<div class="text-sm text-theme-on-surface whitespace-pre-wrap">
				{translationText}
			</div>
		{/if}
	</div>
</div>