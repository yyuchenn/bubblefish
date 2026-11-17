<script lang="ts">
	import type { Marker } from '$lib/types';
	import { markerService } from '$lib/services/markerService';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	import { currentImageId } from '$lib/services/imageService';
	
	interface Props {
		marker: Marker;
		imageX: number;
		imageY: number;
		imageWidth: number;
		imageHeight: number;
		imageScale: number;
		isSelected: boolean;
		isHovered: boolean;
		isDragging: boolean;
		draggedPosition: { x: number; y: number } | null;
		onMouseDown: (event: MouseEvent) => void;
		onTouchStart: (event: TouchEvent) => void;
		onContextMenu: (event: MouseEvent) => void;
		onWheel: (event: WheelEvent) => void;
		disableInteraction?: boolean;
	}
	
	const {
		marker,
		imageX,
		imageY,
		imageWidth,
		imageHeight,
		imageScale,
		isSelected,
		isHovered,
		isDragging,
		draggedPosition,
		onMouseDown,
		onTouchStart,
		onContextMenu,
		onWheel,
		disableInteraction = false
	}: Props = $props();
	
	// Extract coordinates from geometry - only support rectangle type
	const markerX = $derived(
		marker.geometry.type === 'rectangle' 
			? (isDragging && draggedPosition ? draggedPosition.x : marker.geometry.x)
			: 0
	);
	const markerY = $derived(
		marker.geometry.type === 'rectangle' 
			? (isDragging && draggedPosition ? draggedPosition.y : marker.geometry.y)
			: 0
	);
	const markerWidth = $derived(
		marker.geometry.type === 'rectangle' ? marker.geometry.width : 0
	);
	const markerHeight = $derived(
		marker.geometry.type === 'rectangle' ? marker.geometry.height : 0
	);
	
	const pixelX = $derived(imageX + (markerX / 100) * imageWidth * imageScale);
	const pixelY = $derived(imageY + (markerY / 100) * imageHeight * imageScale);
	const pixelWidth = $derived((markerWidth / 100) * imageWidth * imageScale);
	const pixelHeight = $derived((markerHeight / 100) * imageHeight * imageScale);
	
	// Position for the label - at top center, outside the rectangle
	const labelX = $derived(pixelX + pixelWidth / 2);
	const labelY = $derived(pixelY - 20); // 20px above the rectangle top edge
	
	// 计算z-index：选中的marker在最上层(1000+)，其他根据imageIndex排序
	const zIndex = $derived(isSelected ? 1000 + marker.imageIndex : marker.imageIndex);
	
	// 获取 Ctrl/Cmd 键状态
	const ctrlOrCmd = keyboardShortcutService.ctrlOrCmd;
	
	// Resize state
	let isResizing = $state(false);
	let resizeHandle = $state<string>('');
	let resizeStartX = $state(0);
	let resizeStartY = $state(0);
	let resizeStartRect = $state({ x: 0, y: 0, width: 0, height: 0 });
	
	// Handle size in pixels
	const HANDLE_SIZE = 8;
	
	// Clean up event listeners on component destroy
	$effect(() => {
		return () => {
			if (isResizing) {
				window.removeEventListener('mousemove', handleResizeMove, true);
				window.removeEventListener('mouseup', handleResizeEnd, true);
			}
		};
	});
	
	// Calculate minimum size based on image aspect ratio
	// Minimum is 2% of the smaller dimension, forming a square in display
	// Square side length = min(imageWidth, imageHeight) * 0.02
	const aspectRatio = $derived(imageWidth / imageHeight);
	
	// To display as square: width% * imageWidth = height% * imageHeight
	// So: width% / height% = imageHeight / imageWidth = 1 / aspectRatio
	const minMarkerWidth = $derived(
		aspectRatio > 1
			? 2.0 / aspectRatio  // Wider image: height is smaller, width% = 2% / aspectRatio
			: 2.0  // Taller image: width is smaller, width% = 2%
	);
	
	const minMarkerHeight = $derived(
		aspectRatio > 1
			? 2.0  // Wider image: height is smaller, height% = 2%
			: 2.0 * aspectRatio  // Taller image: width is smaller, height% = 2% * aspectRatio
	);
	
	// Function to start resizing
	function startResize(event: MouseEvent, handle: string) {
		if (marker.geometry.type !== 'rectangle') return;
		
		event.stopPropagation();
		event.preventDefault();
		
		isResizing = true;
		resizeHandle = handle;
		resizeStartX = event.clientX;
		resizeStartY = event.clientY;
		resizeStartRect = {
			x: marker.geometry.x,
			y: marker.geometry.y,
			width: marker.geometry.width,
			height: marker.geometry.height
		};
		
		// Add global mouse event listeners with capture to ensure they run first
		window.addEventListener('mousemove', handleResizeMove, true);
		window.addEventListener('mouseup', handleResizeEnd, true);
	}
	
	// Handle resize movement
	function handleResizeMove(event: MouseEvent) {
		if (!isResizing || marker.geometry.type !== 'rectangle') return;
		
		const deltaX = ((event.clientX - resizeStartX) / imageWidth / imageScale) * 100;
		const deltaY = ((event.clientY - resizeStartY) / imageHeight / imageScale) * 100;
		
		let newX = resizeStartRect.x;
		let newY = resizeStartRect.y;
		let newWidth = resizeStartRect.width;
		let newHeight = resizeStartRect.height;
		
		// Handle different resize handles - allow flipping
		switch (resizeHandle) {
			case 'nw': // Top-left
				newX = resizeStartRect.x + deltaX;
				newY = resizeStartRect.y + deltaY;
				newWidth = resizeStartRect.width - deltaX;
				newHeight = resizeStartRect.height - deltaY;
				break;
			case 'ne': // Top-right
				newY = resizeStartRect.y + deltaY;
				newWidth = resizeStartRect.width + deltaX;
				newHeight = resizeStartRect.height - deltaY;
				break;
			case 'sw': // Bottom-left
				newX = resizeStartRect.x + deltaX;
				newWidth = resizeStartRect.width - deltaX;
				newHeight = resizeStartRect.height + deltaY;
				break;
			case 'se': // Bottom-right
				newWidth = resizeStartRect.width + deltaX;
				newHeight = resizeStartRect.height + deltaY;
				break;
			case 'n': // Top
				newY = resizeStartRect.y + deltaY;
				newHeight = resizeStartRect.height - deltaY;
				break;
			case 's': // Bottom
				newHeight = resizeStartRect.height + deltaY;
				break;
			case 'w': // Left
				newX = resizeStartRect.x + deltaX;
				newWidth = resizeStartRect.width - deltaX;
				break;
			case 'e': // Right
				newWidth = resizeStartRect.width + deltaX;
				break;
		}
		
		// Handle flipping - swap coordinates if width/height becomes negative
		if (newWidth < 0) {
			newX = newX + newWidth;
			newWidth = Math.abs(newWidth);
		}
		if (newHeight < 0) {
			newY = newY + newHeight;
			newHeight = Math.abs(newHeight);
		}
		
		// Apply minimum size constraints
		newWidth = Math.max(minMarkerWidth, newWidth);
		newHeight = Math.max(minMarkerHeight, newHeight);
		
		// Apply boundary constraints
		newX = Math.max(0, newX);
		newY = Math.max(0, newY);
		newWidth = Math.min(100 - newX, newWidth);
		newHeight = Math.min(100 - newY, newHeight);
		
		// Update marker position and size optimistically
		markerService.updateMarkerGeometryOptimistic(marker.id, newX, newY, newWidth, newHeight);
	}
	
	// Handle resize end
	async function handleResizeEnd(event: MouseEvent) {
		if (!isResizing || marker.geometry.type !== 'rectangle') return;
		
		// Prevent event from bubbling up to create a point marker
		event.stopPropagation();
		event.preventDefault();
		
		window.removeEventListener('mousemove', handleResizeMove, true);
		window.removeEventListener('mouseup', handleResizeEnd, true);
		
		// Save the final size to backend if we have an image ID
		const imageId = $currentImageId;
		if (imageId) {
			await markerService.updateRectangleMarkerGeometry(
				marker.id,
				marker.geometry.x,
				marker.geometry.y,
				marker.geometry.width,
				marker.geometry.height,
				imageId
			);
		}
		
		isResizing = false;
		resizeHandle = '';
	}
</script>

{#if marker.geometry.type === 'rectangle'}
	<!-- Rectangle outline -->
	<div
		class="marker absolute cursor-grab transition-opacity duration-200 ease-in-out select-none active:cursor-grabbing {disableInteraction || $ctrlOrCmd ? 'pointer-events-none' : 'pointer-events-auto'}"
		style="left: {pixelX}px; top: {pixelY}px; width: {pixelWidth}px; height: {pixelHeight}px; opacity: {isSelected || isHovered ? 1 : 0.6}; z-index: {zIndex};"
		data-marker-id={marker.id}
		onmousedown={onMouseDown}
		ontouchstart={onTouchStart}
		oncontextmenu={onContextMenu}
		onmouseenter={() => markerService.setHoveredMarker(marker.id)}
		onmouseleave={() => markerService.setHoveredMarker(null)}
		onwheel={onWheel}
		draggable="false"
		role="button"
		tabindex="0"
		aria-label="Rectangle Marker {marker.imageIndex}, drag to move, right-click for menu"
	>
		<!-- Rectangle border -->
		<div
			class="absolute inset-0 border-2 rounded-sm"
			style="border-color: {isSelected ? 'var(--color-primary)' : 'var(--color-secondary)'}; background-color: {isSelected ? 'rgba(var(--color-primary-rgb), 0.1)' : 'rgba(var(--color-secondary-rgb), 0.1)'};"
		></div>
		
		<!-- Resize handles (only shown when selected) -->
		{#if isSelected && !isDragging}
			<!-- Corner handles -->
			<div
				class="absolute bg-white border border-primary cursor-nw-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; left: -{HANDLE_SIZE/2}px; top: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 'nw')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-ne-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; right: -{HANDLE_SIZE/2}px; top: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 'ne')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-sw-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; left: -{HANDLE_SIZE/2}px; bottom: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 'sw')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-se-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; right: -{HANDLE_SIZE/2}px; bottom: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 'se')}
				role="button"
				tabindex="0"
			></div>
			
			<!-- Edge handles -->
			<div
				class="absolute bg-white border border-primary cursor-n-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; left: calc(50% - {HANDLE_SIZE/2}px); top: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 'n')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-s-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; left: calc(50% - {HANDLE_SIZE/2}px); bottom: -{HANDLE_SIZE/2}px;"
				onmousedown={(e) => startResize(e, 's')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-w-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; left: -{HANDLE_SIZE/2}px; top: calc(50% - {HANDLE_SIZE/2}px);"
				onmousedown={(e) => startResize(e, 'w')}
				role="button"
				tabindex="0"
			></div>
			<div
				class="absolute bg-white border border-primary cursor-e-resize"
				style="width: {HANDLE_SIZE}px; height: {HANDLE_SIZE}px; right: -{HANDLE_SIZE/2}px; top: calc(50% - {HANDLE_SIZE/2}px);"
				onmousedown={(e) => startResize(e, 'e')}
				role="button"
				tabindex="0"
			></div>
		{/if}
	</div>
	
	<!-- Number label - positioned at top center outside rectangle -->
	<div
		class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transform select-none transition-opacity duration-200 ease-in-out"
		style="left: {labelX}px; top: {labelY}px; z-index: {zIndex + 1}; opacity: {isSelected || isHovered ? 1 : 0.6};"
	>
		<div
			class="flex items-center justify-center w-8 h-8 rounded-md shadow-lg"
			style="background-color: {isSelected ? 'var(--color-primary)' : 'var(--color-secondary)'}; border: 2px solid var(--color-surface);"
		>
			<span
				class="text-sm font-bold"
				style="color: {isSelected ? 'var(--color-on-primary)' : 'var(--color-on-secondary)'};"
			>
				{marker.imageIndex}
			</span>
		</div>
	</div>
{/if}