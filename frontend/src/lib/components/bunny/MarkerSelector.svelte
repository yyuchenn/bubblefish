<script lang="ts">
	import { markers, selectedMarkerId, markerService } from '$lib/services/markerService';
	import { bunnyStore, selectedMarkerIds, markerData } from '$lib/stores/bunnyStore';

	// Track if we're in multi-selection mode
	let isMultiSelectMode = false;
	let scrollContainer: HTMLElement;
	let previousSelectedMarkerId: number | null = null;

	// Filter to only show rectangle markers
	$: rectangleMarkers = $markers.filter(m => m.geometry.type === 'rectangle');

	// Sync with global marker selection when in single-select mode
	$: if (!isMultiSelectMode && $selectedMarkerId && rectangleMarkers.find(m => m.id === $selectedMarkerId)) {
		// Clear bunny selection and select only the globally selected marker
		bunnyStore.clearSelection();
		bunnyStore.selectMarker($selectedMarkerId);

		// Auto-scroll only when the selected marker actually changes
		if ($selectedMarkerId !== previousSelectedMarkerId) {
			scrollToMarker($selectedMarkerId);
			previousSelectedMarkerId = $selectedMarkerId;
		}
	} else if (!$selectedMarkerId) {
		// Reset when no marker is selected
		previousSelectedMarkerId = null;
	}

	// When bunny selection changes in single-select mode, sync with global
	$: if (!isMultiSelectMode && $selectedMarkerIds.size === 1) {
		const markerId = Array.from($selectedMarkerIds)[0];
		if (markerId !== $selectedMarkerId) {
			markerService.setSelectedMarker(markerId);
		}
	}

	function handleMarkerClick(markerId: number, event: MouseEvent) {
		const target = event.target as HTMLElement;
		const isCheckbox = target.tagName === 'INPUT' && target.getAttribute('type') === 'checkbox';

		if (isCheckbox) {
			// Clicking checkbox enters/stays in multi-select mode
			isMultiSelectMode = true;
			bunnyStore.toggleMarkerSelection(markerId);
		} else {
			// Clicking elsewhere does single selection
			isMultiSelectMode = false;
			bunnyStore.clearSelection();
			bunnyStore.selectMarker(markerId);
			markerService.setSelectedMarker(markerId);
		}
	}

	function handleCheckboxClick(event: MouseEvent, markerId: number) {
		event.stopPropagation();
		isMultiSelectMode = true;
		bunnyStore.toggleMarkerSelection(markerId);
	}

	function selectAll() {
		isMultiSelectMode = true;
		const markerIds = rectangleMarkers.map(m => m.id);
		bunnyStore.selectAllMarkers(markerIds);
	}

	function clearSelection() {
		isMultiSelectMode = false;
		bunnyStore.clearSelection();
		markerService.setSelectedMarker(null);
	}

	function getMarkerStatus(markerId: number) {
		const data = $markerData.get(markerId);
		if (!data) return '';

		const hasOriginalText = !!data.originalText;
		const hasMachineTranslation = !!data.machineTranslation;

		if (hasOriginalText && hasMachineTranslation) return '✓✓';
		if (hasOriginalText) return '✓-';
		if (hasMachineTranslation) return '-✓';
		return '--';
	}

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}

	function scrollToMarker(markerId: number) {
		if (!scrollContainer) return;

		// Use requestAnimationFrame to ensure DOM is updated
		requestAnimationFrame(() => {
			const markerElement = scrollContainer.querySelector(`[data-marker-id="${markerId}"]`) as HTMLElement;
			if (!markerElement) return;

			const containerRect = scrollContainer.getBoundingClientRect();
			const elementRect = markerElement.getBoundingClientRect();

			// Check if element is visible
			const isAbove = elementRect.top < containerRect.top;
			const isBelow = elementRect.bottom > containerRect.bottom;

			if (isAbove || isBelow) {
				// Get the parent container of markers (the div with class="p-2 space-y-1")
				const markerList = markerElement.parentElement;
				if (!markerList) return;

				// Calculate the element's position relative to the scrollable container
				// We need to account for the padding of the parent container
				const elementIndex = Array.from(markerList.children).indexOf(markerElement);
				const elementHeight = markerElement.offsetHeight;
				const gapHeight = 4; // space-y-1 = 0.25rem = 4px
				const paddingTop = 8; // p-2 = 0.5rem = 8px

				// Calculate the actual offset from top
				const elementOffsetTop = paddingTop + (elementIndex * (elementHeight + gapHeight));
				const containerHeight = containerRect.height;

				// Center the element in the container if possible
				const targetScrollTop = elementOffsetTop - (containerHeight / 2) + (elementHeight / 2);

				scrollContainer.scrollTo({
					top: Math.max(0, targetScrollTop),
					behavior: 'smooth'
				});
			}
		});
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 border-b border-theme-outline min-h-[36px]">
		<span class="text-xs font-medium text-theme-on-surface">矩形标记</span>
		<div class="flex gap-1 h-[28px] items-center">
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
	
	<div class="flex-1 overflow-y-auto" on:wheel={handleWheel} bind:this={scrollContainer}>
		{#if rectangleMarkers.length === 0}
			<div class="p-4 text-center text-sm text-theme-on-surface-variant">
				当前图片无矩形标记
			</div>
		{:else}
			<div class="p-2 space-y-1">
				{#each rectangleMarkers as marker (marker.id)}
					<button
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-theme-surface-variant transition-colors
							{$selectedMarkerIds.has(marker.id) ? 'bg-theme-primary/10 border border-theme-primary' : 'border border-transparent'}
							{!isMultiSelectMode && marker.id === $selectedMarkerId ? 'ring-2 ring-theme-primary' : ''}"
						on:click={(e) => handleMarkerClick(marker.id, e)}
						data-marker-id={marker.id}
					>
						<input
							type="checkbox"
							checked={$selectedMarkerIds.has(marker.id)}
							on:click={(e) => handleCheckboxClick(e, marker.id)}
							class="pointer-events-auto"
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
		{#if isMultiSelectMode}
			多选: {$selectedMarkerIds.size} / {rectangleMarkers.length}
		{:else}
			已选择 {$selectedMarkerIds.size} / {rectangleMarkers.length}
		{/if}
	</div>
</div>

<style>
	input[type="checkbox"] {
		width: 14px;
		height: 14px;
	}
</style>