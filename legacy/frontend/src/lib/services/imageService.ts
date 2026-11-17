// Image service - pure logic layer
import { coreAPI } from '../core/adapter';
import { imageStore } from '../stores/imageStore';
import { errorStore } from '../stores/errorStore';
import { loadingStore } from '../stores/loadingStore';
import type { ImageMetadata, ImageFormat } from '../types';
import { derived } from 'svelte/store';
import { eventSystem } from '../core/events';
import type { BusinessEvent } from '../core/events';

// Export read-only store subscriptions for components
export const images = derived(imageStore, $store => $store.images);
export const currentImageId = derived(imageStore, $store => $store.currentImageId);
export const currentImage = derived(imageStore, $store => 
  $store.images.find(img => img.id === $store.currentImageId) || null
);

// Export the raw store for debug purposes only
export { imageStore as imageStoreRaw };

export const canNavigatePrev = derived(imageStore, $store => {
  if (!$store.currentImageId || $store.images.length === 0) return false;
  const currentIndex = $store.images.findIndex(img => img.id === $store.currentImageId);
  return currentIndex > 0;
});
export const canNavigateNext = derived(imageStore, $store => {
  if (!$store.currentImageId || $store.images.length === 0) return false;
  const currentIndex = $store.images.findIndex(img => img.id === $store.currentImageId);
  return currentIndex < $store.images.length - 1;
});
export const currentImageIndex = derived(imageStore, $store => {
  if (!$store.currentImageId || $store.images.length === 0) return 0;
  const index = $store.images.findIndex(img => img.id === $store.currentImageId);
  return index >= 0 ? index + 1 : 0;
});
export const totalImages = derived(imageStore, $store => $store.images.length);

// Simple image loader without caching
class ImageLoader {
	async getImageUrl(imageId: number): Promise<string | null> {
		try {
			// Try to get file path first (Tauri desktop optimization)
			const filePath = await coreAPI.getImageFilePath(imageId);

			if (filePath) {
				// Use file path for best performance
				let fileUrl: string;
				try {
					const { convertFileSrc } = await import('@tauri-apps/api/core');
					fileUrl = convertFileSrc(filePath);
					
					// Add timestamp to ensure fresh image
					const timestamp = Date.now();
					fileUrl = fileUrl.includes('?') ? `${fileUrl}&t=${timestamp}` : `${fileUrl}?t=${timestamp}`;
				} catch (error) {
					console.error('Failed to convert file path:', error);
					// Fallback
					const timestamp = Date.now();
					fileUrl = `file://${filePath}?t=${timestamp}`;
				}

				return fileUrl;
			}

			// Fall back to binary data (WASM version or Binary data)
			const binaryData = await coreAPI.getImageBinaryData(imageId);
			const mimeType = await coreAPI.getImageMimeType(imageId);

			if (binaryData && mimeType) {
				// Create Blob URL
				try {
					const safeUint8Array = new Uint8Array(binaryData);
					const blob = new Blob([safeUint8Array], { type: mimeType });
					return URL.createObjectURL(blob);
				} catch (error) {
					console.error('Blob creation failed:', error);
					return null;
				}
			}
		} catch (error) {
			console.error('Failed to load image:', error);
			throw error;
		}

		return null;
	}
}

// Create loader instance
const imageLoader = new ImageLoader();

// Image service API
export const imageService = {
	// Image operations
	async refreshProjectImages(projectId: number): Promise<ImageMetadata[]> {
		const taskId = loadingStore.startTask('refreshImages');
		try {
			const images = await coreAPI.getProjectImagesMetadata(projectId);
			imageStore.setImages(images);
			return images;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to refresh images';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	async addImageFromBinary(projectId: number, format: ImageFormat, data: Uint8Array, name?: string): Promise<number | null> {
		const taskId = loadingStore.startTask('addImage');
		try {
			const imageId = await coreAPI.addImageFromBinary(projectId, format, data, name);
			if (imageId) {
				await this.refreshProjectImages(projectId);
			}
			return imageId;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to add image';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	async addImageFromPath(projectId: number, path: string): Promise<number | null> {
		const taskId = loadingStore.startTask('addImage');
		try {
			const imageId = await coreAPI.addImageFromPath(projectId, path);
			if (imageId) {
				await this.refreshProjectImages(projectId);
			}
			return imageId;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to add image from path';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	async removeImage(projectId: number, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('removeImage');
		try {
			const success = await coreAPI.removeImageFromProject(projectId, imageId);
			if (success) {
				// Remove from store
				imageStore.removeImage(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to remove image';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	async updateImageInfo(imageId: number, name?: string): Promise<boolean> {
		const taskId = loadingStore.startTask('updateImage');
		try {
			const success = await coreAPI.updateImageInfo(imageId, name);
			if (success && name !== undefined) {
				imageStore.updateImage(imageId, { name });
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update image info';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	async reorderImages(projectId: number, imageIds: number[]): Promise<boolean> {
		const taskId = loadingStore.startTask('reorderImages');
		try {
			const success = await coreAPI.reorderProjectImages(projectId, imageIds);
			if (success) {
				await this.refreshProjectImages(projectId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to reorder images';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Navigation
	setCurrentImage(imageId: number): void {
		imageStore.setCurrentImage(imageId);
	},

	nextImage(): void {
		imageStore.nextImage();
	},

	prevImage(): void {
		imageStore.prevImage();
	},

	clearCurrentImage(): void {
		imageStore.clearCurrentImage();
	},

	// Image loading
	async getImageUrl(imageId: number): Promise<string | null> {
		return imageLoader.getImageUrl(imageId);
	},

	// Store getters (for components)
	getCurrentImage(): ImageMetadata | null {
		return imageStore.getCurrentImage();
	},

	getCurrentImageId(): number | null {
		return imageStore.getCurrentImageId();
	},

	getImages(): ImageMetadata[] {
		return imageStore.getImages();
	},

	setImages(images: ImageMetadata[]) {
		imageStore.setImages(images);
	},

	getImageById(imageId: number): ImageMetadata | null {
		return imageStore.getImageById(imageId);
	},

	hasImages(): boolean {
		return imageStore.hasImages();
	},

	// Cleanup
	clearImages(): void {
		imageStore.reset();
	},

	// Initialize event listeners
	initialize(): () => void {
		// Listen for image-related business events
		const unsubscribe = eventSystem.addBusinessEventHandler((event: BusinessEvent) => {
			if (event.event_name === 'ProjectImagesReordered') {
				const data = event.data as { project_id: number; image_ids: number[] };
				// Reorder images in the store to match the new order
				const currentImages = imageStore.getImages();
				const reorderedImages: ImageMetadata[] = [];
				
				// Build new array in the order specified by image_ids
				for (const imageId of data.image_ids) {
					const image = currentImages.find(img => img.id === imageId);
					if (image) {
						reorderedImages.push(image);
					}
				}
				
				// Update the store with reordered images
				if (reorderedImages.length > 0) {
					imageStore.setImages(reorderedImages);
				}
			} else if (event.event_name === 'ImageAddedToProject') {
				const data = event.data as { project_id: number; image_id: number; position?: number };
				// Refresh the image list to get the new image
				const projectId = data.project_id;
				if (projectId) {
					// Don't await to avoid blocking
					imageService.refreshProjectImages(projectId).catch(error => {
						console.error('Failed to refresh images after add:', error);
					});
				}
			} else if (event.event_name === 'ImageRemovedFromProject') {
				const data = event.data as { project_id: number; image_id: number };
				// Remove the image from the store
				imageStore.removeImage(data.image_id);
			}
		});

		return unsubscribe;
	}
};

// Export loader for backward compatibility (if needed)
export const imageCache = imageLoader;