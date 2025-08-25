// Coordinator service - manages side effects and cross-service interactions
// This service listens to store changes and triggers appropriate side effects
// following the reactive programming paradigm

import { currentImage } from '../stores/imageStore';
import { markerService } from './markerService';
import { imageViewerService } from './imageViewerService';
import { snapshotService } from './snapshotService';

class CoordinatorService {
	private unsubscribers: Array<() => void> = [];
	private lastImageId: number | null = null;
	private initialized = false;

	async initialize() {
		if (this.initialized) return;
		this.initialized = true;

		// Initialize snapshot service
		try {
			await snapshotService.initialize();
			console.log('Snapshot service initialized');
		} catch (error) {
			console.error('Failed to initialize snapshot service:', error);
			// Continue even if snapshot service fails to initialize
		}

		// Subscribe to current image changes
		const unsubscribeImage = currentImage.subscribe(async (image) => {
			if (image && image.id !== this.lastImageId) {
				this.lastImageId = image.id;
				
				// Trigger side effects for image change
				await this.handleImageChange(image.id);
			}
		});
		this.unsubscribers.push(unsubscribeImage);

		console.log('CoordinatorService initialized');
	}

	private async handleImageChange(imageId: number) {
		try {
			// Load markers for the new image
			await markerService.loadImageMarkers(imageId);
			
			// Request transform reset for new image
			// The actual centering will be handled by ImageViewer when image loads
			imageViewerService.resetTransform();
		} catch (error) {
			console.error('Error handling image change:', error);
		}
	}

	destroy() {
		// Cleanup all subscriptions
		this.unsubscribers.forEach(unsubscribe => unsubscribe());
		this.unsubscribers = [];
		this.initialized = false;
		this.lastImageId = null;
		
		// Cleanup snapshot service
		snapshotService.destroy();
	}

	// Manual trigger for special cases where we need immediate side effects
	async triggerImageSideEffects(imageId: number) {
		await this.handleImageChange(imageId);
	}
}

// Create singleton instance
export const coordinatorService = new CoordinatorService();