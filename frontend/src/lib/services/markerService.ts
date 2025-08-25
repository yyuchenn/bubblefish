// Marker service - pure logic layer
import { coreAPI } from '../core/adapter';
import { markerStore } from '../stores/markerStore';
import { errorStore } from '../stores/errorStore';
import { loadingStore } from '../stores/loadingStore';
import type { Marker } from '../types';
import { derived } from 'svelte/store';

// Export read-only store subscriptions for components
export const markers = derived(markerStore, $store => $store.markers);
export const selectedMarkerId = derived(markerStore, $store => $store.selectedMarkerId);
export const hoveredMarkerId = derived(markerStore, $store => $store.hoveredMarkerId);
export const selectedMarker = derived(markerStore, $store => 
  $store.markers.find(m => m.id === $store.selectedMarkerId) || null
);

// Export the raw store for debug purposes only
export { markerStore as markerStoreRaw };

// Get store values directly
import { get } from 'svelte/store';
import { images, currentImageIndex, currentImageId } from './imageService';

// Marker service API
export const markerService = {
	// Load markers for an image
	async loadImageMarkers(imageId: number): Promise<Marker[]> {
		const taskId = loadingStore.startTask('loadMarkers');
		try {
			const markers = await coreAPI.getImageMarkers(imageId);
			markerStore.setMarkers(markers);
			return markers;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load markers';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Add a new point marker
	async addPointMarker(imageId: number, x: number, y: number, translation?: string): Promise<number | null> {
		const taskId = loadingStore.startTask('addMarker');
		try {
			const markerId = await coreAPI.addPointMarkerToImage(imageId, x, y, translation);
			if (markerId) {
				await this.loadImageMarkers(imageId);
				markerStore.setSelectedMarker(markerId);
			}
			return markerId;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to add marker';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Add a new rectangle marker
	async addRectangleMarker(imageId: number, x: number, y: number, width: number, height: number, translation?: string): Promise<number | null> {
		const taskId = loadingStore.startTask('addRectangleMarker');
		try {
			const markerId = await coreAPI.addRectangleMarkerToImage(imageId, x, y, width, height, translation);
			if (markerId) {
				await this.loadImageMarkers(imageId);
				markerStore.setSelectedMarker(markerId);
			}
			return markerId;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to add rectangle marker';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Update marker position (works for both point and rectangle markers)
	async updateMarkerPosition(markerId: number, x: number, y: number, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('updateMarker');
		try {
			// Get the marker to determine its type
			const marker = markerStore.getMarkerById(markerId);
			if (!marker) {
				throw new Error('Marker not found');
			}
			
			let success = false;
			if (marker.geometry.type === 'point') {
				success = await coreAPI.updatePointMarkerPosition(markerId, x, y);
			} else if (marker.geometry.type === 'rectangle') {
				// For rectangle, update position keeping the same width/height
				success = await coreAPI.updateRectangleMarkerGeometry(
					markerId, 
					x, 
					y, 
					marker.geometry.width, 
					marker.geometry.height
				);
			}
			
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update marker position';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Optimistic update for marker position (updates UI immediately)
	updateMarkerPositionOptimistic(markerId: number, x: number, y: number): void {
		markerStore.updateMarkerPosition(markerId, x, y);
	},

	// Optimistic update for rectangle marker geometry (updates UI immediately)
	updateMarkerGeometryOptimistic(markerId: number, x: number, y: number, width: number, height: number): void {
		markerStore.updateMarkerGeometry(markerId, x, y, width, height);
	},

	// Update rectangle marker geometry
	async updateRectangleMarkerGeometry(markerId: number, x: number, y: number, width: number, height: number, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('updateMarkerGeometry');
		try {
			const success = await coreAPI.updateRectangleMarkerGeometry(markerId, x, y, width, height);
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update marker geometry';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Update marker translation
	async updateMarkerTranslation(markerId: number, translation: string, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('updateMarker');
		try {
			const success = await coreAPI.updateMarkerTranslation(markerId, translation);
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update marker translation';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Update marker style
	async updateMarkerStyle(markerId: number, overlayText: boolean, horizontal: boolean, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('updateMarker');
		try {
			console.log('markerService.updateMarkerStyle:', { markerId, overlayText, horizontal });
			const success = await coreAPI.updateMarkerStyle(markerId, overlayText, horizontal);
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update marker style';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Move marker order within image
	async moveMarkerOrder(markerId: number, newIndex: number, imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('moveMarker');
		try {
			const success = await coreAPI.moveMarkerOrder(markerId, newIndex);
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to move marker order';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Remove a marker
	async removeMarker(imageId: number, markerId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('removeMarker');
		try {
			const success = await coreAPI.removeMarkerFromImage(imageId, markerId);
			if (success) {
				await this.loadImageMarkers(imageId);
				markerStore.setSelectedMarker(null);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to remove marker';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Clear all markers
	async clearAllMarkers(imageId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('clearMarkers');
		try {
			const success = await coreAPI.clearImageMarkers(imageId);
			if (success) {
				await this.loadImageMarkers(imageId);
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to clear markers';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Convert rectangle marker to point marker
	async convertRectangleToPoint(markerId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('convertMarker');
		try {
			const success = await coreAPI.convertRectangleToPointMarker(markerId);
			if (success) {
				// 重新加载当前图片的markers
				const currentImageIdValue = get(currentImageId);
				if (currentImageIdValue !== null) {
					await this.loadImageMarkers(currentImageIdValue);
				}
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to convert marker';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Convert point marker to rectangle marker
	async convertPointToRectangle(markerId: number): Promise<boolean> {
		const taskId = loadingStore.startTask('convertMarker');
		try {
			const success = await coreAPI.convertPointToRectangleMarker(markerId);
			if (success) {
				// 重新加载当前图片的markers
				const currentImageIdValue = get(currentImageId);
				if (currentImageIdValue !== null) {
					await this.loadImageMarkers(currentImageIdValue);
				}
			}
			return success;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to convert marker';
			errorStore.setError(message);
			throw error;
		} finally {
			loadingStore.endTask(taskId);
		}
	},

	// Batch operations
	async duplicateMarker(markerId: number, imageId: number): Promise<number | null> {
		const marker = markerStore.getMarkerById(markerId);
		
		if (marker) {
			// Create new marker at slightly offset position
			if (marker.geometry.type === 'point') {
				const newX = marker.geometry.x + 20;
				const newY = marker.geometry.y + 20;
				return await this.addPointMarker(imageId, newX, newY, marker.translation);
			} else if (marker.geometry.type === 'rectangle') {
				// For rectangle markers, offset the entire rectangle
				const offsetPercent = 5; // Offset by 5% 
				let newX = marker.geometry.x + offsetPercent;
				let newY = marker.geometry.y + offsetPercent;
				
				// Ensure the new rectangle stays within bounds
				newX = Math.min(newX, 100 - marker.geometry.width);
				newY = Math.min(newY, 100 - marker.geometry.height);
				
				return await this.addRectangleMarker(
					imageId, 
					newX, 
					newY, 
					marker.geometry.width,
					marker.geometry.height,
					marker.translation
				);
			}
		}
		return null;
	},

	async moveMarkerTo(markerId: number, fromImageId: number, toImageId: number): Promise<number | null> {
		const marker = markerStore.getMarkerById(markerId);
		
		if (marker) {
			// Create marker on new image based on geometry type
			let newMarkerId: number | null = null;
			
			if (marker.geometry.type === 'point') {
				newMarkerId = await this.addPointMarker(
					toImageId, 
					marker.geometry.x, 
					marker.geometry.y, 
					marker.translation
				);
			} else if (marker.geometry.type === 'rectangle') {
				// Move rectangle marker to new image
				newMarkerId = await this.addRectangleMarker(
					toImageId, 
					marker.geometry.x, 
					marker.geometry.y,
					marker.geometry.width,
					marker.geometry.height,
					marker.translation
				);
			}
			
			if (newMarkerId) {
				// Remove from original image
				await this.removeMarker(fromImageId, markerId);
				return newMarkerId;
			}
		}
		return null;
	},

	// UI state management
	setSelectedMarker(markerId: number | null): void {
		markerStore.setSelectedMarker(markerId);
	},

	setHoveredMarker(markerId: number | null): void {
		markerStore.setHoveredMarker(markerId);
	},

	clearMarkers(): void {
		markerStore.clearMarkers();
	},

	// Store getters (for components)
	getMarkers(): Marker[] {
		return markerStore.getMarkers();
	},

	getSelectedMarkerId(): number | null {
		return markerStore.getSelectedMarkerId();
	},

	getSelectedMarker(): Marker | null {
		return markerStore.getSelectedMarker();
	},

	getHoveredMarkerId(): number | null {
		return markerStore.getHoveredMarkerId();
	},

	getMarkerById(markerId: number): Marker | null {
		return markerStore.getMarkerById(markerId);
	},

	findMarkersInArea(x: number, y: number, width: number, height: number): Marker[] {
		return markerStore.findMarkersInArea(x, y, width, height);
	},

	findNearestMarker(x: number, y: number, maxDistance: number = 50): Marker | null {
		return markerStore.findNearestMarker(x, y, maxDistance);
	},

	getMarkerStats() {
		return markerStore.getMarkerStats();
	},

	hasMarkers(): boolean {
		return markerStore.hasMarkers();
	},

	// Navigate to next marker
	navigateToNextMarker(): void {
		const markersValue = get(markers);
		const imagesValue = get(images);
		const currentImageIndexValue = get(currentImageIndex);
		const isLastPage = currentImageIndexValue === imagesValue.length;
		
		if (markersValue.length === 0) {
			if (!isLastPage) {
				// Import imageService dynamically to avoid circular dependency
				import('./imageService').then(({ imageService }) => {
					imageService.nextImage();
				});
			}
			return;
		}
		
		const currentSelected = get(selectedMarker);
		const currentSelectedId = currentSelected?.id || null;
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		
		if (!currentSelectedId) {
			this.setSelectedMarker(sortedMarkers[0].id);
		} else {
			const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelectedId);
			if (currentIndex === -1 || currentIndex === sortedMarkers.length - 1) {
				if (!isLastPage) {
					import('./imageService').then(({ imageService }) => {
						imageService.nextImage();
						setTimeout(() => {
							const newMarkers = get(markers);
							if (newMarkers.length > 0) {
								const firstMarker = [...newMarkers].sort((a, b) => a.imageIndex - b.imageIndex)[0];
								this.setSelectedMarker(firstMarker.id);
							}
						});
					});
				}
			} else {
				this.setSelectedMarker(sortedMarkers[currentIndex + 1].id);
			}
		}
	},

	// Navigate to previous marker
	navigateToPrevMarker(): void {
		const markersValue = get(markers);
		const currentImageIndexValue = get(currentImageIndex);
		const isFirstPage = currentImageIndexValue === 1;
		
		if (markersValue.length === 0) {
			if (!isFirstPage) {
				import('./imageService').then(({ imageService }) => {
					imageService.prevImage();
				});
			}
			return;
		}
		
		const currentSelected = get(selectedMarker);
		const currentSelectedId = currentSelected?.id || null;
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		
		if (!currentSelectedId) {
			this.setSelectedMarker(sortedMarkers[sortedMarkers.length - 1].id);
		} else {
			const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelectedId);
			if (currentIndex === -1 || currentIndex === 0) {
				if (!isFirstPage) {
					import('./imageService').then(({ imageService }) => {
						imageService.prevImage();
						setTimeout(() => {
							const newMarkers = get(markers);
							if (newMarkers.length > 0) {
								const sortedNewMarkers = [...newMarkers].sort((a, b) => a.imageIndex - b.imageIndex);
								this.setSelectedMarker(sortedNewMarkers[sortedNewMarkers.length - 1].id);
							}
						});
					});
				}
			} else {
				this.setSelectedMarker(sortedMarkers[currentIndex - 1].id);
			}
		}
	},

	// Check if can navigate to next marker
	canNavigateNext(): boolean {
		const markersValue = get(markers);
		const imagesValue = get(images);
		const currentImageIndexValue = get(currentImageIndex);
		const currentSelected = get(selectedMarker);
		const isLastPage = currentImageIndexValue === imagesValue.length;
		
		if (!currentSelected) {
			return false;
		}
		
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelected.id);
		
		return currentIndex < sortedMarkers.length - 1 || !isLastPage;
	},

	// Check if can navigate to previous marker
	canNavigatePrev(): boolean {
		const markersValue = get(markers);
		const currentImageIndexValue = get(currentImageIndex);
		const currentSelected = get(selectedMarker);
		const isFirstPage = currentImageIndexValue === 1;
		
		if (!currentSelected) {
			return false;
		}
		
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelected.id);
		
		return currentIndex > 0 || !isFirstPage;
	}
};