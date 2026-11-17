// Image viewer store - manages image viewer transformation state
import { writable, get } from 'svelte/store';

// Zoom modes
export type ZoomMode = 'fit-screen' | 'fit-width' | 'fit-height' | 'free';

// View transformation state interface
export interface TransformState {
	scale: number;
	viewX: number;
	viewY: number;
	zoomMode: ZoomMode; // Current zoom mode
	isImageOutOfBounds: boolean; // Whether image is completely outside visible area
}

// Initial transformation state
const initialTransformState: TransformState = {
	scale: 1,
	viewX: 0,
	viewY: 0,
	zoomMode: 'fit-screen', // Default to fit-screen mode
	isImageOutOfBounds: false
};

// Image viewer store
export const imageViewerStore = writable<TransformState>(initialTransformState);

// Image viewer store actions
export const imageViewerActions = {
	// Basic transformation operations
	updateTransform(scale: number, x: number, y: number) {
		imageViewerStore.update((state) => ({
			...state,
			scale,
			viewX: x,
			viewY: y
		}));
	},

	setScale(scale: number) {
		imageViewerStore.update((state) => ({
			...state,
			scale: Math.max(0.1, Math.min(10, scale)) // Limit scale range
		}));
	},

	setPosition(x: number, y: number) {
		imageViewerStore.update((state) => ({
			...state,
			viewX: x,
			viewY: y
		}));
	},

	resetTransform() {
		imageViewerStore.update((state) => ({
			...state,
			scale: 1
		}));
	},


	// Zoom mode management
	setZoomMode(mode: ZoomMode) {
		imageViewerStore.update((state) => ({
			...state,
			zoomMode: mode
		}));
	},

	// Get current transform state
	getTransform() {
		return get(imageViewerStore);
	},

	// Set image out of bounds state
	setImageOutOfBounds(isOutOfBounds: boolean) {
		imageViewerStore.update((state) => ({
			...state,
			isImageOutOfBounds: isOutOfBounds
		}));
	}
};