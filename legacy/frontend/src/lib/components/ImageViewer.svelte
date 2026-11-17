<script lang="ts">
	import { imageLoaderState, showLoadingIndicator } from '$lib/services/imageLoaderService';
	import { currentImage } from '$lib/services/imageService';
	import { 
		imageViewerService,
		recenterRequested,
		isTransitioning,
		zoomMode,
		viewX,
		viewY,
		scale,
	} from '$lib/services/imageViewerService';
	import { imageViewerActions } from '$lib/stores/imageViewerStore';
	import { sidebarState } from '$lib/services/layoutService';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	import LoadingSpinner from './LoadingSpinner.svelte';
	import Markers from './markers/Markers.svelte';

	// DOM refs
	let viewportElement = $state<HTMLElement>();
	let resizeObserver: ResizeObserver | null = null;

	// Image dimensions
	let imageWidth = $state(0);
	let imageHeight = $state(0);
	let displayWidth = $state(100);
	let displayHeight = $state(100);

	// State
	let isInitialized = $state(false);
	let previousUrl = $state<string | null>(null);
	let previousZoomMode = $state<'fit-screen' | 'fit-width' | 'fit-height' | 'free'>('fit-screen');
	
	// Reactive modifier key states from service
	const ctrlOrCmd = keyboardShortcutService.ctrlOrCmd;
	const shift = keyboardShortcutService.shift;
	
	// Rectangle drawing state
	let isDrawingRectangle = $state(false);
	let rectangleStartX = $state(0);
	let rectangleStartY = $state(0);
	let rectangleEndX = $state(0);
	let rectangleEndY = $state(0);
	let rectangleDrawElement = $state<HTMLDivElement | null>(null);

	// Calculate display size
	function updateDisplaySize() {
		if (!viewportElement || !imageWidth || !imageHeight) return;
		
		const size = imageViewerService.calculateDisplaySize(
			imageWidth,
			imageHeight,
			viewportElement.clientWidth,
			viewportElement.clientHeight
		);
		
		displayWidth = size.width;
		displayHeight = size.height;
	}

	// Apply zoom mode
	function applyZoomMode() {
		if (!viewportElement || !imageWidth || !imageHeight) return;
		imageViewerService.applyZoomMode(
			displayWidth,
			displayHeight,
			viewportElement.clientWidth,
			viewportElement.clientHeight,
			imageWidth,
			imageHeight,
			$zoomMode
		);
	}

	// Handle image load
	function handleImageLoad(event: Event) {
		const img = event.target as HTMLImageElement;
		imageWidth = img.naturalWidth;
		imageHeight = img.naturalHeight;
		
		// Update dynamic max scale based on new image dimensions
		imageViewerService.updateDynamicMaxScale(imageWidth, imageHeight);
		
		updateDisplaySize();
		
		if ($isTransitioning) {
			imageViewerService.completeTransition();
		}
		
		if (!isInitialized) {
			isInitialized = true;
			// Apply zoom mode (defaults to fit-screen for new images or free mode)
			const mode = $zoomMode === 'free' ? 'fit-screen' : $zoomMode;
			if (mode !== $zoomMode) {
				imageViewerService.setZoomMode(mode);
			}
			queueMicrotask(applyZoomMode);
		} else if ($recenterRequested) {
			// When switching images, apply current zoom mode or fit-screen if free
			const mode = $zoomMode === 'free' ? 'fit-screen' : $zoomMode;
			if (mode !== $zoomMode) {
				imageViewerService.setZoomMode(mode);
			}
			queueMicrotask(applyZoomMode);
		}
	}


	// Watch URL changes
	$effect(() => {
		const newUrl = $imageLoaderState.imageUrl;
		if (newUrl && newUrl !== previousUrl) {
			previousUrl = newUrl;
			imageViewerService.startTransition();
			imageViewerService.resetTransform();
			// Reset to appropriate mode when changing images
			if ($zoomMode === 'free') {
				imageViewerService.setZoomMode('fit-screen');
			}
		}
	});

	// Watch current image for pre-loaded dimensions
	$effect(() => {
		const image = $currentImage;
		if (image?.width && image?.height && !$isTransitioning) {
			imageWidth = image.width;
			imageHeight = image.height;
			
			// Update dynamic max scale based on pre-loaded dimensions
			imageViewerService.updateDynamicMaxScale(imageWidth, imageHeight);
			
			updateDisplaySize();
			
			if (!isInitialized) {
				isInitialized = true;
				// Apply zoom mode for pre-loaded images
				const mode = $zoomMode === 'free' ? 'fit-screen' : $zoomMode;
				if (mode !== $zoomMode) {
					imageViewerService.setZoomMode(mode);
				}
				queueMicrotask(applyZoomMode);
			}
		}
	});

	// Watch recenter requests
	$effect(() => {
		if ($recenterRequested && isInitialized && displayWidth > 0) {
			// Apply current zoom mode or fit-screen if free
			const mode = $zoomMode === 'free' ? 'fit-screen' : $zoomMode;
			if (mode !== $zoomMode) {
				imageViewerService.setZoomMode(mode);
			}
			queueMicrotask(applyZoomMode);
		}
	});

	// Watch zoom mode changes
	$effect(() => {
		const currentZoomMode = $zoomMode;
		if (currentZoomMode !== previousZoomMode && currentZoomMode !== 'free' && isInitialized) {
			// Apply new zoom mode when it changes to a specific mode
			queueMicrotask(applyZoomMode);
		}
		previousZoomMode = currentZoomMode;
	});

	// Watch sidebar changes
	$effect(() => {
		void $sidebarState.leftSidebarOpen;
		void $sidebarState.rightSidebarOpen;
		void $sidebarState.bottomPanelOpen;
		
		// Re-apply current zoom mode when sidebar changes (if not free mode)
		if ($zoomMode !== 'free' && isInitialized) {
			setTimeout(applyZoomMode, 100);
		}
		
		// Check bounds after sidebar changes
		if (viewportElement && displayWidth > 0 && displayHeight > 0) {
			setTimeout(() => {
				if (!viewportElement) return;
				const isOutOfBounds = imageViewerService.checkImageOutOfBounds(
					displayWidth,
					displayHeight,
					viewportElement.clientWidth,
					viewportElement.clientHeight
				);
				imageViewerActions.setImageOutOfBounds(isOutOfBounds);
			}, 150);
		}
	});

	// Watch viewport resize
	$effect(() => {
		if (viewportElement) {
			resizeObserver?.disconnect();
			
			resizeObserver = new ResizeObserver(() => {
				updateDisplaySize();
				// Re-apply current zoom mode on resize (if not free mode)
				if ($zoomMode !== 'free') {
					applyZoomMode();
				}
				
				// Check bounds after resize
				if (viewportElement && displayWidth > 0 && displayHeight > 0) {
					const isOutOfBounds = imageViewerService.checkImageOutOfBounds(
						displayWidth,
						displayHeight,
						viewportElement.clientWidth,
						viewportElement.clientHeight
					);
					imageViewerActions.setImageOutOfBounds(isOutOfBounds);
				}
			});
			
			resizeObserver.observe(viewportElement);
		}
		
		return () => {
			resizeObserver?.disconnect();
			resizeObserver = null;
		};
	});
	
	// Watch position and scale changes for bounds checking
	$effect(() => {
		void $viewX;
		void $viewY;
		void $scale;
		
		if (viewportElement && displayWidth > 0 && displayHeight > 0 && isInitialized) {
			const isOutOfBounds = imageViewerService.checkImageOutOfBounds(
				displayWidth,
				displayHeight,
				viewportElement.clientWidth,
				viewportElement.clientHeight
			);
			imageViewerActions.setImageOutOfBounds(isOutOfBounds);
		}
	});

	// Touch handling for pinch zoom and pan
	let touchStartDistance = 0;
	let touchStartScale = 1;
	let touchStartCenter = { x: 0, y: 0 };
	let touchStartViewX = 0;
	let touchStartViewY = 0;
	
	function getTouchDistance(touches: TouchList): number {
		if (touches.length < 2) return 0;
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}
	
	function getTouchCenter(touches: TouchList): { x: number; y: number } {
		if (touches.length < 2) return { x: 0, y: 0 };
		return {
			x: (touches[0].clientX + touches[1].clientX) / 2,
			y: (touches[0].clientY + touches[1].clientY) / 2
		};
	}
	
	function handleTouchStart(event: TouchEvent) {
		if (event.touches.length === 2) {
			event.preventDefault();
			touchStartDistance = getTouchDistance(event.touches);
			touchStartScale = $scale;
			touchStartCenter = getTouchCenter(event.touches);
			touchStartViewX = $viewX;
			touchStartViewY = $viewY;
		}
	}
	
	function handleTouchMove(event: TouchEvent) {
		if (event.touches.length === 2 && touchStartDistance > 0) {
			event.preventDefault();
			
			const currentDistance = getTouchDistance(event.touches);
			const currentCenter = getTouchCenter(event.touches);
			
			// Calculate scale change
			const scaleFactor = currentDistance / touchStartDistance;
			const newScale = touchStartScale * scaleFactor;
			
			// Calculate pan offset
			const panX = currentCenter.x - touchStartCenter.x;
			const panY = currentCenter.y - touchStartCenter.y;
			
			// Apply pan (relative to the starting position)
			const newViewX = touchStartViewX + panX;
			const newViewY = touchStartViewY + panY;
			
			// Get touch center relative to viewport for zoom anchor point
			const rect = viewportElement?.getBoundingClientRect();
			if (rect) {
				// First apply the pan
				imageViewerService.updateTransform($scale, newViewX, newViewY);
				
				// Then apply zoom if scale changed significantly
				if (Math.abs(scaleFactor - 1) > 0.01) {
					const centerX = currentCenter.x - rect.left;
					const centerY = currentCenter.y - rect.top;
					imageViewerService.zoomAtPoint(centerX, centerY, newScale);
					
					// Update the start position after zoom to maintain smooth panning
					touchStartViewX = $viewX - panX;
					touchStartViewY = $viewY - panY;
				}
			}
		}
	}
	
	function handleTouchEnd(event: TouchEvent) {
		if (event.touches.length < 2) {
			touchStartDistance = 0;
			touchStartScale = 1;
			touchStartCenter = { x: 0, y: 0 };
			touchStartViewX = 0;
			touchStartViewY = 0;
		}
	}

	// Event handlers
	function handleImageMouseDown(event: MouseEvent) {
		// Always start drag tracking (for detection)
		event.preventDefault();
		event.stopPropagation();
		
		if (!$ctrlOrCmd) {
			// Start rectangle drawing
			const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
			// When zoomed, we need to account for the scale to get correct percentage coordinates
			const scaledWidth = rect.width / $scale;
			const scaledHeight = rect.height / $scale;
			const x = ((event.clientX - rect.left) / $scale / scaledWidth) * 100;
			const y = ((event.clientY - rect.top) / $scale / scaledHeight) * 100;
			
			rectangleStartX = x;
			rectangleStartY = y;
			rectangleEndX = x;
			rectangleEndY = y;
			isDrawingRectangle = true;
		}
		
		imageViewerService.startDrag(event);
	}

	function handleMouseMove(event: MouseEvent) {
		// Always update drag state for detection
		imageViewerService.updateDrag(event);
		
		// Update rectangle drawing if in progress
		if (isDrawingRectangle && rectangleDrawElement) {
			const rect = rectangleDrawElement.getBoundingClientRect();
			// When zoomed, we need to account for the scale to get correct percentage coordinates
			const scaledWidth = rect.width / $scale;
			const scaledHeight = rect.height / $scale;
			// Don't clamp during drawing to allow visual feedback of dragging outside
			const x = ((event.clientX - rect.left) / $scale / scaledWidth) * 100;
			const y = ((event.clientY - rect.top) / $scale / scaledHeight) * 100;
			
			// Store the raw values, we'll clamp them when creating the marker
			rectangleEndX = x;
			rectangleEndY = y;
		}
		
		// Only move image if ctrl/cmd is pressed
		if ($ctrlOrCmd) {
			imageViewerService.moveImage(event);
		}
	}

	function handleMouseUp() {
		// Global mouse up - only end drag if not handled by image
		if (imageViewerService.getViewerState().isDragging) {
			imageViewerService.endDrag();
		}
		
		// End rectangle drawing and create marker if it was in progress
		if (isDrawingRectangle) {
			// Ensure coordinates are within bounds
			const minX = Math.max(0, Math.min(100, Math.min(rectangleStartX, rectangleEndX)));
			const minY = Math.max(0, Math.min(100, Math.min(rectangleStartY, rectangleEndY)));
			const maxX = Math.max(0, Math.min(100, Math.max(rectangleStartX, rectangleEndX)));
			const maxY = Math.max(0, Math.min(100, Math.max(rectangleStartY, rectangleEndY)));
			const width = maxX - minX;
			const height = maxY - minY;
			
			// Only create marker if rectangle has meaningful size (at least 1% width and height)
			if (width > 1 && height > 1) {
				window.dispatchEvent(new CustomEvent('addRectangleMarker', {
					detail: { x: minX, y: minY, width, height, displayWidth, displayHeight }
				}));
			} else {
				// Too small, treat as point marker at the start position
				const x = Math.max(0, Math.min(100, rectangleStartX));
				const y = Math.max(0, Math.min(100, rectangleStartY));
				
				window.dispatchEvent(new CustomEvent('addMarker', {
					detail: { x, y, displayWidth, displayHeight }
				}));
			}
			
			isDrawingRectangle = false;
		}
	}

	function handleImageMouseUp(event: MouseEvent) {
		// Check if dragged
		const wasDragged = imageViewerService.wasDragged(event);
		
		// Always end drag state
		imageViewerService.endDrag();
		
		// If we're drawing a rectangle, this was handled in the global mouseup
		// to ensure it works even when mouse is released outside the image
		if (isDrawingRectangle) {
			// Rectangle drawing is handled in global handleMouseUp
			return;
		}
		
		if (wasDragged) {
			// Was dragging image, don't add marker
			return;
		}
		
		// Add marker only if ctrl/cmd is NOT pressed
		if (!$ctrlOrCmd) {
			event.stopPropagation();
			event.preventDefault();
			
			// Was a click without ctrl/cmd, add point marker
			const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
			// When zoomed, we need to account for the scale to get correct percentage coordinates
			const scaledWidth = rect.width / $scale;
			const scaledHeight = rect.height / $scale;
			const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / $scale / scaledWidth) * 100));
			const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / $scale / scaledHeight) * 100));
			
			window.dispatchEvent(new CustomEvent('addMarker', {
				detail: { x, y, displayWidth, displayHeight }
			}));
		}
		// If ctrl/cmd is pressed and it's a click, do nothing (ignore)
	}

	function handleImageWheel(event: WheelEvent) {
		if (!viewportElement) return;
		
		// Handle pinch-to-zoom from touchpad (comes as wheel event with ctrlKey)
		// or manual zoom with ctrl/cmd + scroll wheel
		if (event.ctrlKey || event.metaKey || $ctrlOrCmd) {
			event.preventDefault();
			event.stopPropagation();
			
			// For touchpad pinch gestures, use deltaY directly as zoom factor
			// For mouse wheel with ctrl/cmd, use the existing handleWheelZoom
			if (event.ctrlKey && !event.shiftKey && Math.abs(event.deltaY) !== 0) {
				// This is likely a pinch gesture from touchpad
				const rect = viewportElement.getBoundingClientRect();
				const mouseX = event.clientX - rect.left;
				const mouseY = event.clientY - rect.top;
				const currentScale = $scale;
				
				// Touchpad pinch gestures provide smooth delta values
				// Use exponential scaling for smoother zoom
				const zoomFactor = Math.exp(-event.deltaY * 0.01);
				const newScale = currentScale * zoomFactor;
				
				imageViewerService.zoomAtPoint(mouseX, mouseY, newScale);
			} else {
				// Regular mouse wheel zoom with ctrl/cmd
				imageViewerService.handleWheelZoom(event, viewportElement.getBoundingClientRect());
			}
		}
		// Otherwise, let the event bubble up for viewport scrolling
	}
	
	function handleViewportWheel(event: WheelEvent) {
		if (!viewportElement) return;
		
		// Implement manual scrolling on the viewport
		const scrollSpeed = 10; // pixels per wheel tick
		const deltaX = event.deltaX;
		const deltaY = event.deltaY;
		
		event.preventDefault();
		const currentTransform = imageViewerService.getTransform();
		const currentX = currentTransform.viewX;
		const currentY = currentTransform.viewY;
		const currentScale = currentTransform.scale;
		
		let newX = currentX;
		let newY = currentY;
		
		// Handle horizontal and vertical scrolling
		if ($shift) {
			// Shift pressed: swap axes
			// Vertical wheel becomes horizontal movement
			// Horizontal wheel becomes vertical movement
			newX = currentX - deltaY * (scrollSpeed / 10);
			newY = currentY - deltaX * (scrollSpeed / 10);
		} else {
			// Normal mode:
			// Horizontal wheel moves horizontally
			// Vertical wheel moves vertically
			newX = currentX - deltaX * (scrollSpeed / 10);
			newY = currentY - deltaY * (scrollSpeed / 10);
		}
		
		imageViewerService.updateTransform(currentScale, newX, newY);
	}

	// Pan to marker
	export function panToMarker(marker: { x: number; y: number }) {
		if (!viewportElement) return;
		imageViewerService.panToMarker(
			marker,
			displayWidth,
			displayHeight,
			viewportElement.clientWidth,
			viewportElement.clientHeight
		);
	}
	
	// Reset position to center
	export function resetPosition() {
		if (!viewportElement || !imageWidth || !imageHeight) return;
		imageViewerService.resetPosition(
			displayWidth,
			displayHeight,
			viewportElement.clientWidth,
			viewportElement.clientHeight,
			imageWidth,
			imageHeight
		);
	}

	// Expose globally
	$effect(() => {
		if (typeof window !== 'undefined') {
			(window as any).__panToMarker = panToMarker;
			(window as any).__resetImagePosition = resetPosition;
		}
		return () => {
			if (typeof window !== 'undefined') {
				delete (window as any).__panToMarker;
				delete (window as any).__resetImagePosition;
			}
		};
	});
</script>

<svelte:window 
	on:mousemove={handleMouseMove} 
	on:mouseup={handleMouseUp} 
/>

<div class="absolute inset-0 overflow-hidden" bind:this={viewportElement} onwheel={handleViewportWheel}>
	<!-- Image -->
	{#if $imageLoaderState.imageUrl}
		{#key $imageLoaderState.imageUrl}
			<div
				class="absolute z-0 select-none transition-opacity duration-200"
				class:opacity-0={$isTransitioning}
				class:opacity-100={!$isTransitioning}
				style="left: {$isTransitioning ? (viewportElement ? (viewportElement.clientWidth - displayWidth) / 2 : 0) : $viewX}px; 
					   top: {$isTransitioning ? (viewportElement ? (viewportElement.clientHeight - displayHeight) / 2 : 0) : $viewY}px;"
				ondragstart={(e) => e.preventDefault()}
				role="presentation"
			>
				<div
					class="relative select-none"
					class:cursor-grab={$ctrlOrCmd}
					class:cursor-crosshair={!$ctrlOrCmd}
					class:active:cursor-grabbing={$ctrlOrCmd}
					onmousedown={handleImageMouseDown}
					onmouseup={handleImageMouseUp}
					onwheel={handleImageWheel}
					ontouchstart={handleTouchStart}
					ontouchmove={handleTouchMove}
					ontouchend={handleTouchEnd}
					onkeydown={(e) => e.key === 'Enter' && handleImageMouseUp(e as unknown as MouseEvent)}
					role="button"
					tabindex="0"
					aria-label="Click to add marker"
					style="transform: scale({$isTransitioning ? 1 : $scale}); transform-origin: 0 0;"
					bind:this={rectangleDrawElement}
				>
					<img
						src={$imageLoaderState.imageUrl}
						alt=""
						draggable="false"
						class="block"
						style="width: {displayWidth}px; height: {displayHeight}px; max-width: none; max-height: none; image-rendering: crisp-edges;"
						onload={handleImageLoad}
					/>
					
					<!-- Rectangle drawing preview -->
					{#if isDrawingRectangle}
						{@const clampedStartX = Math.max(0, Math.min(100, rectangleStartX))}
						{@const clampedStartY = Math.max(0, Math.min(100, rectangleStartY))}
						{@const clampedEndX = Math.max(0, Math.min(100, rectangleEndX))}
						{@const clampedEndY = Math.max(0, Math.min(100, rectangleEndY))}
						{@const minX = Math.min(clampedStartX, clampedEndX)}
						{@const minY = Math.min(clampedStartY, clampedEndY)}
						{@const width = Math.abs(clampedEndX - clampedStartX)}
						{@const height = Math.abs(clampedEndY - clampedStartY)}
						{@const borderWidth = 2 / $scale}
						<div
							class="absolute bg-primary/10 pointer-events-none"
							style="left: {minX}%; top: {minY}%; width: {width}%; height: {height}%; box-shadow: inset 0 0 0 {borderWidth}px var(--color-primary);"
						></div>
					{/if}
				</div>
			</div>
		{/key}
	{/if}

	<!-- Markers -->
	{#if $imageLoaderState.imageUrl && !$isTransitioning}
		<Markers 
			imageWidth={displayWidth} 
			imageHeight={displayHeight} 
			imageX={$viewX}
			imageY={$viewY}
			imageScale={$scale}
			{isDrawingRectangle}
		/>
	{/if}

	<!-- Loading -->
	{#if $showLoadingIndicator}
		<div class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
			<LoadingSpinner />
		</div>
	{/if}

	<!-- Error -->
	{#if $imageLoaderState.loadingState === 'error'}
		<div class="absolute inset-0 z-20 flex items-center justify-center">
			<div class="text-center">
				<p class="text-red-500 mb-2">图片加载失败</p>
				<p class="text-sm text-gray-500">{$imageLoaderState.error}</p>
			</div>
		</div>
	{/if}
</div>