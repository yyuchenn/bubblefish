import { derived, readable } from 'svelte/store';
import { imageCache } from './imageService';
import { currentImage } from '../stores/imageStore';
import { imageLoaderActions } from '../stores/imageLoaderStore';
import type { ImageLoaderState } from '../stores/imageLoaderStore';

// Track current loading
let loadingController: AbortController | null = null;

// Create a readable store from the internal store's subscribe
const loaderState = readable<ImageLoaderState>(
	imageLoaderActions.getState(),
	(set) => imageLoaderActions.subscribe(set)
);

// Create all derived stores (consistent with other services)
export const imageLoaderState = loaderState;

export const imageUrl = derived(
	loaderState,
	$state => $state.imageUrl
);

export const isLoading = derived(
	loaderState,
	$state => $state.loadingState === 'loading'
);

export const showLoadingIndicator = derived(
	loaderState,
	$state => {
		if ($state.loadingState !== 'loading' || !$state.loadingStartTime) {
			return false;
		}
		// Show loading indicator after 500ms delay
		return Date.now() - $state.loadingStartTime > 500;
	}
);

export const loadError = derived(
	loaderState,
	$state => $state.loadingState === 'error' ? $state.error : null
);

/**
 * Service responsible for loading images and managing loading state
 * - Fetches image URLs from cache
 * - Handles loading cancellation  
 * - Updates display state via store actions
 * - Provides read-only derived stores for components
 */
class ImageLoaderService {
	/**
	 * Load and switch to a new image
	 */
	async loadImage(imageId: number): Promise<void> {
		// Cancel previous loading
		this.cancelPendingLoad();

		try {
			// Start loading new image
			imageLoaderActions.startLoading();

			// Create new AbortController
			loadingController = new AbortController();
			const currentController = loadingController;

			// Get image URL from cache
			const imageUrl = await imageCache.getImageUrl(imageId);
			
			// Check if cancelled
			if (currentController.signal.aborted) {
				return;
			}

			if (!imageUrl) {
				throw new Error('Failed to get image URL');
			}

			// Update state with loaded image URL
			if (!currentController.signal.aborted) {
				imageLoaderActions.setLoaded(imageUrl);
			}
		} catch (error) {
			if (loadingController && !loadingController.signal.aborted) {
				console.error('Failed to load image:', error);
				imageLoaderActions.setError(
					error instanceof Error ? error.message : 'Failed to load image'
				);
			}
		}
	}

	/**
	 * Cancel any pending image load
	 */
	private cancelPendingLoad(): void {
		if (loadingController) {
			loadingController.abort();
			loadingController = null;
		}
	}

	/**
	 * Reset loader state
	 */
	reset(): void {
		this.cancelPendingLoad();
		imageLoaderActions.reset();
	}

	/**
	 * Clear current image
	 */
	clear(): void {
		this.cancelPendingLoad();
		imageLoaderActions.clear();
	}
}

// Create singleton instance
export const imageLoaderService = new ImageLoaderService();

// Auto-load images when currentImage changes
currentImage.subscribe(async ($image) => {
	if ($image) {
		await imageLoaderService.loadImage($image.id);
	} else {
		imageLoaderService.clear();
	}
});