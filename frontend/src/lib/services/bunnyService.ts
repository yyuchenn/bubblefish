// Bunny Service - Main service layer for OCR and translation functionality
import { get } from 'svelte/store';
import { bunnyStore } from '../stores/bunnyStore';
import type { BunnyTask } from '../types/bunny';
import { eventService } from './eventService';
import { coreAPI } from '../core/adapter';
import { markers } from './markerService';
import { currentImageId } from './imageService';
import { pluginService } from './pluginService';

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
						startedAt: Date.now()
					});
					eventService.info(`Task ${data.task_id} started processing for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:ocr_completed':
				if (data.marker_id !== undefined && data.original_text !== undefined) {
					// Update original text (even if empty)
					bunnyStore.setOriginalText(data.marker_id, data.original_text, data.model);

					// Find and update the task status
					if (data.task_id) {
						bunnyStore.updateTask(data.task_id, {
							status: 'completed',
							result: data.original_text,
							completedAt: Date.now()
						});
					}
					eventService.info(`OCR completed for marker ${data.marker_id}`);

					// Auto-translate if enabled (only if text is not empty)
					const settings = get(bunnyStore).settings;
					if (settings.autoTranslateAfterOCR && data.original_text) {
						this.requestTranslation(data.marker_id, data.original_text);
					}
				}
				break;

			case 'bunny:translation_completed':
				if (data.marker_id !== undefined && data.machine_translation !== undefined) {
					// Update machine translation (even if empty)
					bunnyStore.setMachineTranslation(data.marker_id, data.machine_translation, data.service);

					// Find and update the task status
					if (data.task_id) {
						bunnyStore.updateTask(data.task_id, {
							status: 'completed',
							result: data.machine_translation,
							completedAt: Date.now()
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

	async requestOCR(markerId: number, model?: string): Promise<string> {

		const imageId = get(currentImageId);
		if (!imageId) {
			throw new Error('No image selected');
		}

		const ocrModel = model || get(bunnyStore).settings.ocrModel;

		// Generate task ID
		const taskId = `bunny_task_${Date.now()}_${markerId}`;

		// Create task
		const task: BunnyTask = {
			id: taskId,
			markerId,
			imageId,
			type: 'ocr',
			status: 'queued',
			model: ocrModel,
			createdAt: Date.now()
		};

		// Add to store
		bunnyStore.addTask(task);
		bunnyStore.setMarkerTaskId(markerId, taskId, 'ocr');

		// All OCR services are now plugin-based
		const ocrServices = await coreAPI.getAvailableOCRServices();
		const ocrServiceInfo = ocrServices.find(s => s.id === ocrModel);

		if (!ocrServiceInfo) {
			throw new Error(`OCR service '${ocrModel}' not found. Please load an OCR plugin.`);
		}

		// Get image data for the plugin
		const imageData = await coreAPI.getImageBinaryData(imageId);

		// Send OCR request directly to the plugin
		const message = {
			type: 'ocr_request',
			task_id: taskId,
			marker_id: markerId,
			image_data: Array.from(imageData || new Uint8Array()),
			service_id: ocrModel
		};

		// Send message to plugin using the pluginService instance
		await pluginService.sendPluginMessage('bunny', ocrServiceInfo.plugin_id, message);

		// Mark task as processing
		bunnyStore.updateTask(taskId, {
			status: 'processing',
			startedAt: Date.now()
		});

		eventService.info(`OCR request sent to plugin ${ocrServiceInfo.plugin_id}`);

		return taskId;
	}

	async requestTranslation(markerId: number, text?: string, service?: string): Promise<string> {

		// Get text from marker data if not provided
		const markerData = get(bunnyStore).markerData.get(markerId);
		const textToTranslate = text || markerData?.originalText || '';

		if (!textToTranslate) {
			throw new Error('No text to translate');
		}

		const imageId = get(currentImageId);
		if (!imageId) {
			throw new Error('No image selected');
		}

		const settings = get(bunnyStore).settings;
		const translationService = service || settings.translationService;

		// Generate task ID
		const taskId = `bunny_task_${Date.now()}_${markerId}_trans`;

		// Create task
		const task: BunnyTask = {
			id: taskId,
			markerId,
			imageId,
			type: 'translation',
			status: 'queued',
			service: translationService,
			createdAt: Date.now()
		};

		// Add to store
		bunnyStore.addTask(task);
		bunnyStore.setMarkerTaskId(markerId, taskId, 'translation');

		// All translation services are now plugin-based
		const translationServices = await coreAPI.getAvailableTranslationServices();
		const translationServiceInfo = translationServices.find(s => s.id === translationService);

		if (!translationServiceInfo) {
			throw new Error(`Translation service '${translationService}' not found. Please load a translation plugin.`);
		}

		// Send translation request directly to the plugin
		const message = {
			type: 'translation_request',
			task_id: taskId,
			marker_id: markerId,
			text: textToTranslate,
			source_lang: settings.sourceLang,
			target_lang: settings.targetLang,
			service_id: translationService
		};

		// Send message to plugin using the pluginService instance
		await pluginService.sendPluginMessage('bunny', translationServiceInfo.plugin_id, message);

		// Mark task as processing
		bunnyStore.updateTask(taskId, {
			status: 'processing',
			startedAt: Date.now()
		});

		eventService.info(`Translation request sent to plugin ${translationServiceInfo.plugin_id}`);

		return taskId;
	}

	async requestBatchOCR(markerIds: number[], model?: string): Promise<string[]> {
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

	async requestBatchTranslation(markerIds: number[], service?: string): Promise<string[]> {
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