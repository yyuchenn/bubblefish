import { writable, derived, get } from 'svelte/store';
import { imageViewerActions, imageViewerStore } from '../stores/imageViewerStore';
import type { TransformState, ZoomMode } from '../stores/imageViewerStore';

// Export the raw store for debug purposes only
export { imageViewerStore as imageViewerStoreRaw };

// Zoom constants
export const ZOOM_CONSTANTS = {
	MIN_SCALE: 0.5,
	DEFAULT_MAX_SCALE: 5,
	ZOOM_STEP: 0.1
} as const;

interface ViewerState {
	isDragging: boolean;
	dragStartX: number;
	dragStartY: number;
	dragOffsetX: number;
	dragOffsetY: number;
	lastDragDistance: number; // Store drag distance for click detection
	isTransitioning: boolean;
	recenterRequested: boolean;
	dynamicMaxScale: number; // Dynamic max scale based on image aspect ratio
}

class ImageViewerService {
	private viewerState = writable<ViewerState>({
		isDragging: false,
		dragStartX: 0,
		dragStartY: 0,
		dragOffsetX: 0,
		dragOffsetY: 0,
		lastDragDistance: 0,
		isTransitioning: false,
		recenterRequested: false,
		dynamicMaxScale: ZOOM_CONSTANTS.DEFAULT_MAX_SCALE
	});

	// Public readable stores
	public isDragging = derived(this.viewerState, $state => $state.isDragging);
	public isTransitioning = derived(this.viewerState, $state => $state.isTransitioning);
	public recenterRequested = derived(this.viewerState, $state => $state.recenterRequested);
	public dynamicMaxScale = derived(this.viewerState, $state => $state.dynamicMaxScale);
	public zoomMode = derived(imageViewerStore, $store => $store.zoomMode);
	public viewX = derived(imageViewerStore, $store => $store.viewX);
	public viewY = derived(imageViewerStore, $store => $store.viewY);
	public scale = derived(imageViewerStore, $store => $store.scale);
	public isImageOutOfBounds = derived(imageViewerStore, $store => $store.isImageOutOfBounds);

	/**
	 * Calculate display size to fit image in container (fit-screen mode)
	 */
	calculateDisplaySize(
		imageWidth: number,
		imageHeight: number,
		containerWidth: number,
		containerHeight: number
	): { width: number; height: number } {
		if (!imageWidth || !imageHeight || !containerWidth || !containerHeight) {
			return { width: 100, height: 100 };
		}

		const imageAspectRatio = imageWidth / imageHeight;
		let displayWidth: number;
		let displayHeight: number;

		if (imageAspectRatio > 1) {
			displayWidth = containerWidth;
			displayHeight = displayWidth / imageAspectRatio;
			if (displayHeight > containerHeight) {
				displayHeight = containerHeight;
				displayWidth = displayHeight * imageAspectRatio;
			}
		} else {
			displayHeight = containerHeight;
			displayWidth = displayHeight * imageAspectRatio;
			if (displayWidth > containerWidth) {
				displayWidth = containerWidth;
				displayHeight = displayWidth / imageAspectRatio;
			}
		}

		return {
			width: Math.round(displayWidth),
			height: Math.round(displayHeight)
		};
	}

	/**
	 * Calculate scale for fit-to-width mode
	 */
	calculateFitToWidthScale(
		imageWidth: number,
		imageHeight: number,
		containerWidth: number,
		containerHeight: number
	): number {
		if (!imageWidth || !imageHeight || !containerWidth || !containerHeight) {
			return 1;
		}

		// First get the display size (fit-screen)
		const displaySize = this.calculateDisplaySize(imageWidth, imageHeight, containerWidth, containerHeight);
		
		// Calculate scale to make the image width fill the container
		return containerWidth / displaySize.width;
	}

	/**
	 * Calculate scale for fit-to-height mode
	 */
	calculateFitToHeightScale(
		imageWidth: number,
		imageHeight: number,
		containerWidth: number,
		containerHeight: number
	): number {
		if (!imageWidth || !imageHeight || !containerWidth || !containerHeight) {
			return 1;
		}

		// First get the display size (fit-screen)
		const displaySize = this.calculateDisplaySize(imageWidth, imageHeight, containerWidth, containerHeight);
		
		// Calculate scale to make the image height fill the container
		return containerHeight / displaySize.height;
	}

	/**
	 * Calculate dynamic max scale based on image aspect ratio
	 * Max scale = max(longSide/shortSide * 2, 5)
	 * The factor of 2 accounts for container aspect ratio (assuming max 2:1)
	 */
	calculateDynamicMaxScale(imageWidth: number, imageHeight: number): number {
		if (!imageWidth || !imageHeight) {
			return ZOOM_CONSTANTS.DEFAULT_MAX_SCALE;
		}

		const longSide = Math.max(imageWidth, imageHeight);
		const shortSide = Math.min(imageWidth, imageHeight);
		const aspectRatioScale = (longSide / shortSide) * 2;
		
		return Math.max(aspectRatioScale, ZOOM_CONSTANTS.DEFAULT_MAX_SCALE);
	}

	/**
	 * Update dynamic max scale
	 */
	updateDynamicMaxScale(imageWidth: number, imageHeight: number): void {
		const maxScale = this.calculateDynamicMaxScale(imageWidth, imageHeight);
		this.viewerState.update(state => ({ ...state, dynamicMaxScale: maxScale }));
	}

	/**
	 * Get center position for image in container
	 */
	getCenterPosition(
		displayWidth: number,
		displayHeight: number,
		containerWidth: number,
		containerHeight: number
	): { x: number; y: number } {
		return {
			x: (containerWidth - displayWidth) / 2,
			y: (containerHeight - displayHeight) / 2
		};
	}

	/**
	 * Update transform
	 */
	updateTransform(scale: number, x: number, y: number): void {
		imageViewerActions.updateTransform(scale, x, y);
		this.clearRecenterRequest();
	}


	/**
	 * Apply the current zoom mode
	 */
	applyZoomMode(
		displayWidth: number,
		displayHeight: number,
		containerWidth: number,
		containerHeight: number,
		imageWidth: number,
		imageHeight: number,
		mode: ZoomMode
	): void {
		let targetScale = 1;
		
		switch (mode) {
			case 'fit-screen':
				targetScale = 1;
				break;
			case 'fit-width':
				targetScale = this.calculateFitToWidthScale(imageWidth, imageHeight, containerWidth, containerHeight);
				break;
			case 'fit-height':
				targetScale = this.calculateFitToHeightScale(imageWidth, imageHeight, containerWidth, containerHeight);
				break;
			case 'free':
				// Keep current scale
				return;
		}

		const scaledWidth = displayWidth * targetScale;
		const scaledHeight = displayHeight * targetScale;
		
		let posX: number;
		let posY: number;
		
		// Calculate position based on mode
		if (mode === 'fit-width' && scaledHeight > containerHeight) {
			// For fit-width: if height exceeds container, align to top
			posX = (containerWidth - scaledWidth) / 2; // Center horizontally
			posY = 0; // Align to top
		} else if (mode === 'fit-height' && scaledWidth > containerWidth) {
			// For fit-height: if width exceeds container, align to right (for manga reading)
			posX = containerWidth - scaledWidth; // Align to right
			posY = (containerHeight - scaledHeight) / 2; // Center vertically
		} else {
			// Default: center the image
			const pos = this.getCenterPosition(scaledWidth, scaledHeight, containerWidth, containerHeight);
			posX = pos.x;
			posY = pos.y;
		}
		
		const current = this.getTransform();
		
		// Only update if needed to avoid loops
		if (Math.abs(current.scale - targetScale) > 0.01 || 
		    Math.abs(current.viewX - posX) > 0.1 || 
		    Math.abs(current.viewY - posY) > 0.1) {
			this.updateTransform(targetScale, posX, posY);
		}
	}

	/**
	 * Reset and request recenter
	 */
	resetTransform(): void {
		imageViewerActions.setScale(1);
		this.requestRecenter();
	}

	/**
	 * Request recenter
	 */
	requestRecenter(): void {
		this.viewerState.update(state => ({ ...state, recenterRequested: true }));
	}

	/**
	 * Clear recenter request
	 */
	clearRecenterRequest(): void {
		this.viewerState.update(state => ({ ...state, recenterRequested: false }));
	}

	/**
	 * Set zoom mode
	 */
	setZoomMode(mode: ZoomMode): void {
		imageViewerActions.setZoomMode(mode);
	}

	/**
	 * Start image transition
	 */
	startTransition(): void {
		this.viewerState.update(state => ({ ...state, isTransitioning: true }));
	}

	/**
	 * Complete image transition
	 */
	completeTransition(): void {
		this.viewerState.update(state => ({ ...state, isTransitioning: false }));
		this.requestRecenter();
	}

	/**
	 * Zoom at point
	 */
	zoomAtPoint(anchorX: number, anchorY: number, newScale: number): void {
		const state = this.getTransform();
		const maxScale = get(this.viewerState).dynamicMaxScale;
		newScale = Math.max(ZOOM_CONSTANTS.MIN_SCALE, Math.min(maxScale, newScale));
		
		if (newScale === state.scale) return;

		const imageAnchorX = (anchorX - state.viewX) / state.scale;
		const imageAnchorY = (anchorY - state.viewY) / state.scale;
		const newX = anchorX - imageAnchorX * newScale;
		const newY = anchorY - imageAnchorY * newScale;

		// Switch to free mode when manually zooming
		if (state.zoomMode !== 'free') {
			this.setZoomMode('free');
		}

		this.updateTransform(newScale, newX, newY);
	}

	/**
	 * Handle wheel zoom
	 */
	handleWheelZoom(event: WheelEvent, viewportRect: DOMRect): void {
		event.preventDefault();
		const delta = Math.sign(event.deltaY);
		const currentScale = this.getTransform().scale;
		const maxScale = get(this.viewerState).dynamicMaxScale;
		
		let newScale = currentScale;
		if (delta < 0) {
			newScale = Math.min(currentScale + ZOOM_CONSTANTS.ZOOM_STEP, maxScale);
		} else {
			newScale = Math.max(currentScale - ZOOM_CONSTANTS.ZOOM_STEP, ZOOM_CONSTANTS.MIN_SCALE);
		}

		if (newScale !== currentScale) {
			const mouseX = event.clientX - viewportRect.left;
			const mouseY = event.clientY - viewportRect.top;
			this.zoomAtPoint(mouseX, mouseY, newScale);
		}
	}

	/**
	 * Start drag
	 */
	startDrag(event: MouseEvent): void {
		const transform = this.getTransform();
		this.viewerState.update(state => ({
			...state,
			isDragging: false,
			dragStartX: event.clientX,
			dragStartY: event.clientY,
			dragOffsetX: event.clientX - transform.viewX,
			dragOffsetY: event.clientY - transform.viewY
		}));
	}

	/**
	 * Update drag state
	 */
	updateDrag(event: MouseEvent): boolean {
		const state = get(this.viewerState);
		if (!state.dragStartX && !state.dragStartY) return false;

		const deltaX = Math.abs(event.clientX - state.dragStartX);
		const deltaY = Math.abs(event.clientY - state.dragStartY);
		const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
		const threshold = 5;

		// Always update last drag distance for detection
		this.viewerState.update(s => ({ ...s, lastDragDistance: distance }));

		if (!state.isDragging && distance > threshold) {
			this.viewerState.update(s => ({ ...s, isDragging: true }));
		}

		return state.isDragging || get(this.viewerState).isDragging;
	}

	/**
	 * Move image based on current drag position
	 */
	moveImage(event: MouseEvent): void {
		const state = get(this.viewerState);
		if (!state.isDragging) return;

		const newX = event.clientX - state.dragOffsetX;
		const newY = event.clientY - state.dragOffsetY;
		const scale = this.getTransform().scale;
		this.updateTransform(scale, newX, newY);
	}

	/**
	 * End drag
	 */
	endDrag(): void {
		this.viewerState.update(state => ({
			...state,
			isDragging: false,
			dragStartX: 0,
			dragStartY: 0,
			dragOffsetX: 0,
			dragOffsetY: 0,
			lastDragDistance: 0
		}));
	}

	/**
	 * Check if dragged
	 */
	wasDragged(event: MouseEvent): boolean {
		const state = get(this.viewerState);
		// Use the stored last drag distance or calculate from current position
		if (state.lastDragDistance > 0) {
			return state.lastDragDistance > 5;
		}
		// Fallback: calculate from current position if still holding mouse
		if (state.dragStartX || state.dragStartY) {
			const deltaX = Math.abs(event.clientX - state.dragStartX);
			const deltaY = Math.abs(event.clientY - state.dragStartY);
			return Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 5;
		}
		return false;
	}

	/**
	 * Check if image is completely outside viewport bounds
	 */
	checkImageOutOfBounds(
		displayWidth: number,
		displayHeight: number,
		containerWidth: number,
		containerHeight: number
	): boolean {
		const transform = this.getTransform();
		const scaledWidth = displayWidth * transform.scale;
		const scaledHeight = displayHeight * transform.scale;
		
		// Check if image is completely to the left of viewport
		if (transform.viewX + scaledWidth <= 0) return true;
		
		// Check if image is completely to the right of viewport
		if (transform.viewX >= containerWidth) return true;
		
		// Check if image is completely above viewport
		if (transform.viewY + scaledHeight <= 0) return true;
		
		// Check if image is completely below viewport
		if (transform.viewY >= containerHeight) return true;
		
		return false;
	}

	/**
	 * Reset position to center for current zoom mode
	 */
	resetPosition(
		displayWidth: number,
		displayHeight: number,
		containerWidth: number,
		containerHeight: number,
		imageWidth: number,
		imageHeight: number
	): void {
		const transform = this.getTransform();
		
		// re-apply current zoom mode
		this.applyZoomMode(
			displayWidth,
			displayHeight,
			containerWidth,
			containerHeight,
			imageWidth,
			imageHeight,
			transform.zoomMode !== 'free' ? transform.zoomMode : 'fit-screen'
		);
	}

	/**
	 * Pan to marker
	 */
	panToMarker(
		marker: { x: number; y: number },
		displayWidth: number,
		displayHeight: number,
		containerWidth: number,
		containerHeight: number
	): void {
		const currentScale = this.getTransform().scale;
		const scaledWidth = displayWidth * currentScale;
		const scaledHeight = displayHeight * currentScale;
		
		const markerX = (marker.x / 100) * scaledWidth;
		const markerY = (marker.y / 100) * scaledHeight;
		
		const targetX = containerWidth / 2 - markerX;
		const targetY = containerHeight / 2 - markerY + 24; // Offset for marker size
		
		let newX = targetX;
		let newY = targetY;
		
		// Constrain position
		if (scaledWidth > containerWidth) {
			newX = Math.max(containerWidth - scaledWidth, Math.min(0, targetX));
		} else {
			const centerX = (containerWidth - scaledWidth) / 2;
			const maxOffset = scaledWidth * 0.3;
			newX = Math.max(centerX - maxOffset, Math.min(centerX + maxOffset, targetX));
		}
		
		if (scaledHeight > containerHeight) {
			newY = Math.max(containerHeight - scaledHeight, Math.min(0, targetY));
		} else {
			const centerY = (containerHeight - scaledHeight) / 2;
			const maxOffset = scaledHeight * 0.3;
			newY = Math.max(centerY - maxOffset, Math.min(centerY + maxOffset, targetY));
		}
		
		// Switch to free mode when panning to marker
		if (this.getTransform().zoomMode !== 'free') {
			this.setZoomMode('free');
		}
		
		this.updateTransform(currentScale, newX, newY);
	}

	/**
	 * Get current transform
	 */
	getTransform(): TransformState {
		return imageViewerActions.getTransform();
	}

	/**
	 * Get viewer state
	 */
	getViewerState(): ViewerState {
		return get(this.viewerState);
	}

	/**
	 * Reset service
	 */
	reset(): void {
		this.updateTransform(1, 0, 0);
		this.viewerState.set({
			isDragging: false,
			dragStartX: 0,
			dragStartY: 0,
			dragOffsetX: 0,
			dragOffsetY: 0,
			lastDragDistance: 0,
			isTransitioning: false,
			recenterRequested: false,
			dynamicMaxScale: ZOOM_CONSTANTS.DEFAULT_MAX_SCALE
		});
	}
}

// Export singleton
export const imageViewerService = new ImageViewerService();

// Export derived stores directly for cleaner imports
export const isDragging = imageViewerService.isDragging;
export const isTransitioning = imageViewerService.isTransitioning;
export const recenterRequested = imageViewerService.recenterRequested;
export const dynamicMaxScale = imageViewerService.dynamicMaxScale;
export const zoomMode = imageViewerService.zoomMode;
export const viewX = imageViewerService.viewX;
export const viewY = imageViewerService.viewY;
export const scale = imageViewerService.scale;
export const isImageOutOfBounds = imageViewerService.isImageOutOfBounds;