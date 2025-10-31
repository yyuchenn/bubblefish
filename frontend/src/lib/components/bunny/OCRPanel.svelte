<script lang="ts">
	import { selectedMarkerIds, markerData } from '$lib/stores/bunnyStore';
	import { markers } from '$lib/services/markerService';

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}
	
	let originalText = '';
	let isEditing = false;

	// Get selected marker
	$: selectedMarker = $selectedMarkerIds.size === 1
		? $markers.find(m => $selectedMarkerIds.has(m.id))
		: null;

	// Update original text when selection changes
	$: if (selectedMarker) {
		const data = $markerData.get(selectedMarker.id);
		originalText = data?.originalText || '';
	} else {
		originalText = '';
	}

	async function saveOriginalText() {
		if (!selectedMarker) return;

		// Save to store only (OCR text is not persisted to backend)
		const { bunnyStore } = await import('$lib/stores/bunnyStore');
		bunnyStore.setOriginalText(selectedMarker.id, originalText);

		isEditing = false;
	}

	function cancelEdit() {
		if (selectedMarker) {
			const data = $markerData.get(selectedMarker.id);
			originalText = data?.originalText || '';
		}
		isEditing = false;
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 border-b border-theme-outline min-h-[36px]">
		<span class="text-xs font-medium text-theme-on-surface">原文</span>
		<div class="flex gap-1 h-[28px] items-center">
			{#if selectedMarker}
				{#if isEditing}
					<button
						class="px-2 py-1 text-xs rounded bg-theme-primary text-theme-on-primary hover:opacity-90"
						on:click={saveOriginalText}
					>
						保存
					</button>
					<button
						class="px-2 py-1 text-xs rounded bg-theme-surface text-theme-on-surface border border-theme-outline hover:bg-theme-surface-variant focus:outline-none focus:ring-1 focus:ring-theme-primary/60"
						on:click={cancelEdit}
					>
						取消
					</button>
				{:else}
					<button
						class="px-2 py-1 text-xs rounded bg-theme-surface text-theme-on-surface border border-theme-outline hover:bg-theme-surface-variant focus:outline-none focus:ring-1 focus:ring-theme-primary/60"
						on:click={() => isEditing = true}
					>
						编辑
					</button>
				{/if}
			{/if}
		</div>
	</div>
	
	<div class="flex-1 overflow-y-auto p-3" on:wheel={handleWheel}>
		{#if !selectedMarker}
			<div class="text-sm text-theme-on-surface-variant text-center">
				请选择一个标记查看原文
			</div>
		{:else if isEditing}
			<textarea
				bind:value={originalText}
				class="w-full h-full p-2 text-sm bg-theme-surface text-theme-on-surface border border-theme-outline rounded resize-none focus:outline-none focus:border-theme-primary"
				placeholder="输入原文..."
			></textarea>
		{:else if originalText}
			<div class="text-sm text-theme-on-surface whitespace-pre-wrap">
				{originalText}
			</div>
		{:else}
			<div class="text-sm text-theme-on-surface-variant text-center">
				该标记暂无原文
			</div>
		{/if}
	</div>
</div>