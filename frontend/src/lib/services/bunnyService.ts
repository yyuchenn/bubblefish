// Bunny Service - Main service layer for OCR and translation functionality
import { get } from 'svelte/store';
import { bunnyStore } from '../stores/bunnyStore';
import type { BunnyTask, OCRModel, TranslationService } from '../types/bunny';
import { eventService } from './eventService';
import { coreAPI } from '../core/adapter';
import { markers } from './markerService';
import { currentImageId } from './imageService';

class BunnyService {
	private initialized = false;

	async initialize() {
		if (this.initialized) return;

		try {
			// Note: Worker is no longer needed as backend handles all task execution
			// All task status updates now come from backend events

			// Subscribe to business events from backend
			eventService.onBusinessEvent((event) => {
				if (event && event.event_name && event.event_name.startsWith('bunny:')) {
					this.handleBackendEvent(event.event_name, event.data);
				}
			});

			this.initialized = true;
			eventService.info('Bunny service initialized');
		} catch (error) {
			eventService.error('Failed to initialize Bunny service', error);
			throw error;
		}
	}


	private handleBackendEvent(eventName: string, data: any) {
		// Handle backend events for task queue management
		console.log(`[BunnyService] Received event: ${eventName}`, data);

		if (!data) {
			eventService.warn(`Received bunny event ${eventName} with no data`);
			return;
		}

		switch (eventName) {
			case 'bunny:task_queued':
				if (data.task_id && data.marker_id) {
					// Task is queued, waiting to be processed
					bunnyStore.updateTask(data.task_id, {
						status: 'queued'
					});
					eventService.debug(`Task ${data.task_id} queued for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:task_started':
				if (data.task_id && data.marker_id) {
					// Task started processing
					bunnyStore.updateTask(data.task_id, {
						status: 'processing',
						startedAt: Date.now(),
						progress: 0
					});
					eventService.info(`Task ${data.task_id} started processing for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:task_progress':
				if (data.task_id && data.progress !== undefined) {
					// Update task progress
					bunnyStore.updateTask(data.task_id, {
						progress: data.progress
					});
				}
				break;

			case 'bunny:ocr_completed':
				if (data.marker_id && data.text) {
					// Update OCR text
					bunnyStore.setOCRText(data.marker_id, data.text, data.model);

					// Find and update the task status
					if (data.task_id) {
						bunnyStore.updateTask(data.task_id, {
							status: 'completed',
							result: data.text,
							completedAt: Date.now(),
							progress: 100
						});
					}
					eventService.info(`OCR completed for marker ${data.marker_id}`);

					// Auto-translate if enabled
					const settings = get(bunnyStore).settings;
					if (settings.autoTranslateAfterOCR) {
						this.requestTranslation(data.marker_id, data.text);
					}
				}
				break;

			case 'bunny:translation_completed':
				if (data.marker_id && data.translation) {
					// Update translation text
					bunnyStore.setTranslation(data.marker_id, data.translation, data.service);

					// Find and update the task status
					if (data.task_id) {
						bunnyStore.updateTask(data.task_id, {
							status: 'completed',
							result: data.translation,
							completedAt: Date.now(),
							progress: 100
						});
					}
					eventService.info(`Translation completed for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:task_cancelled':
				if (data.task_id) {
					bunnyStore.updateTask(data.task_id, {
						status: 'cancelled',
						completedAt: Date.now()
					});
					eventService.info(`Task ${data.task_id} cancelled`);
				}
				break;

			case 'bunny:task_failed':
				if (data.task_id) {
					bunnyStore.updateTask(data.task_id, {
						status: 'failed',
						error: data.error,
						completedAt: Date.now()
					});
					eventService.error(`Task ${data.task_id} failed`, data.error);
				}
				break;
		}
	}

	// Public API methods

	async requestOCR(markerId: number, model?: OCRModel): Promise<string> {

		const imageId = get(currentImageId);
		if (!imageId) {
			throw new Error('No image selected');
		}

		const ocrModel = model || get(bunnyStore).settings.ocrModel;

		// Send to backend for real processing and get the task ID from backend
		try {
			const backendTaskId = await coreAPI.requestOCR(markerId, ocrModel);

			// Create task with backend's task ID
			const task: BunnyTask = {
				id: backendTaskId,
				markerId,
				imageId,
				type: 'ocr',
				status: 'queued',
				model: ocrModel,
				createdAt: Date.now()
			};

			// Add to store with backend's task ID
			bunnyStore.addTask(task);
			bunnyStore.setMarkerTaskId(markerId, backendTaskId, 'ocr');

			return backendTaskId;
		} catch (error) {
			eventService.error(`Failed to send OCR request to backend for marker ${markerId}`, error);
			throw error;
		}
	}

	async requestTranslation(markerId: number, text?: string, service?: TranslationService): Promise<string> {

		// Get text from marker data if not provided
		const markerData = get(bunnyStore).markerData.get(markerId);
		const textToTranslate = text || markerData?.ocrText || '';

		if (!textToTranslate) {
			throw new Error('No text to translate');
		}

		const settings = get(bunnyStore).settings;
		const translationService = service || settings.translationService;

		// Send to backend for real processing and get the task ID from backend
		try {
			const backendTaskId = await coreAPI.requestTranslation(markerId, translationService, settings.sourceLang, settings.targetLang);

			// Create task with backend's task ID
			const task: BunnyTask = {
				id: backendTaskId,
				markerId,
				imageId: get(currentImageId) || 0,
				type: 'translation',
				status: 'queued',
				service: translationService,
				createdAt: Date.now()
			};

			// Add to store with backend's task ID
			bunnyStore.addTask(task);
			bunnyStore.setMarkerTaskId(markerId, backendTaskId, 'translation');

			return backendTaskId;
		} catch (error) {
			eventService.error(`Failed to send translation request to backend for marker ${markerId}`, error);
			throw error;
		}
	}

	async requestBatchOCR(markerIds: number[], model?: OCRModel): Promise<string[]> {
		const taskIds: string[] = [];
		const ocrModel = model || get(bunnyStore).settings.ocrModel;
		const batchSize = get(bunnyStore).settings.batchSize;

		// Process in batches
		for (let i = 0; i < markerIds.length; i += batchSize) {
			const batch = markerIds.slice(i, i + batchSize);
			const batchTaskIds = await Promise.all(
				batch.map(markerId => this.requestOCR(markerId, ocrModel))
			);
			taskIds.push(...batchTaskIds);

			// Small delay between batches
			if (i + batchSize < markerIds.length) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		return taskIds;
	}

	async requestBatchTranslation(markerIds: number[], service?: TranslationService): Promise<string[]> {
		const taskIds: string[] = [];
		const translationService = service || get(bunnyStore).settings.translationService;
		const batchSize = get(bunnyStore).settings.batchSize;

		// Process in batches
		for (let i = 0; i < markerIds.length; i += batchSize) {
			const batch = markerIds.slice(i, i + batchSize);
			const batchTaskIds = await Promise.all(
				batch.map(markerId => this.requestTranslation(markerId, undefined, translationService))
			);
			taskIds.push(...batchTaskIds);

			// Small delay between batches
			if (i + batchSize < markerIds.length) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		return taskIds;
	}

	async cancelTask(taskId: string) {
		// Only notify backend - it handles all task management
		try {
			await coreAPI.cancelBunnyTask(taskId);
		} catch (error) {
			eventService.error(`Failed to cancel task ${taskId}`, error);
		}
	}

	async clearQueue() {
		try {
			// Call backend to cancel all tasks
			await coreAPI.clearAllBunnyTasks();
			// Clear all tasks in the store
			bunnyStore.clearAllTasks();
		} catch (error) {
			eventService.error('Failed to clear task queue', error);
		}
	}

	getQueueStatus() {
		// Queue status is now managed through store and backend events
		// No need to query worker
	}

	// Helper methods

	// Get rectangle markers for current image
	getRectangleMarkers() {
		const allMarkers = get(markers);
		return allMarkers.filter(marker => marker.geometry.type === 'rectangle');
	}

	// Cleanup
	destroy() {
		this.initialized = false;
		bunnyStore.reset();
	}
}

// Create singleton instance
export const bunnyService = new BunnyService();