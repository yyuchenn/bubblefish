// Bunny Service - Main service layer for OCR and translation functionality
import { get } from 'svelte/store';
import { bunnyStore } from '../stores/bunnyStore';
import type { BunnyTask, BunnyWorkerMessage, BunnyWorkerResponse, OCRModel, TranslationService } from '../types/bunny';
import { eventService } from './eventService';
import { coreAPI } from '../core/adapter';
import { markers } from './markerService';
import { currentImageId } from './imageService';

class BunnyService {
	private worker: Worker | null = null;
	private taskIdCounter = 0;
	private initialized = false;

	async initialize() {
		if (this.initialized) return;

		try {
			// Initialize worker
			this.worker = new Worker(
				new URL('../workers/bunnyWorker.ts', import.meta.url),
				{ type: 'module' }
			);

			// Set up worker message handler
			this.worker.addEventListener('message', (event: MessageEvent<BunnyWorkerResponse>) => {
				this.handleWorkerResponse(event.data);
			});

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

	private handleWorkerResponse(response: BunnyWorkerResponse) {
		switch (response.type) {
			case 'task_started':
				bunnyStore.updateTask(response.taskId, { status: 'processing' });
				eventService.debug(`Task ${response.taskId} started for marker ${response.markerId}`);
				break;

			case 'task_progress':
				bunnyStore.updateTask(response.taskId, { progress: response.progress });
				break;

			case 'task_completed':
				this.handleTaskCompleted(response.taskId, response.markerId, response.result);
				break;

			case 'task_failed':
				bunnyStore.updateTask(response.taskId, { 
					status: 'failed', 
					error: response.error,
					completedAt: Date.now()
				});
				eventService.error(`Task ${response.taskId} failed for marker ${response.markerId}`, response.error);
				break;

			case 'task_cancelled':
				bunnyStore.updateTask(response.taskId, { 
					status: 'cancelled',
					completedAt: Date.now()
				});
				eventService.info(`Task ${response.taskId} cancelled for marker ${response.markerId}`);
				break;

			case 'queue_status':
				// Queue status is handled via derived store
				break;
		}
	}

	private async handleTaskCompleted(taskId: string, markerId: number, result: string) {
		const state = get(bunnyStore);
		const task = state.tasks.get(taskId);
		
		if (!task) return;

		// Update task status
		bunnyStore.updateTask(taskId, { 
			status: 'completed', 
			result,
			completedAt: Date.now()
		});

		// Update marker data based on task type
		if (task.type === 'ocr') {
			bunnyStore.setOCRText(markerId, result, task.model);
			
			// Auto-translate if enabled
			const settings = get(bunnyStore).settings;
			if (settings.autoTranslateAfterOCR) {
				await this.requestTranslation(markerId, result);
			}
		} else if (task.type === 'translation') {
			bunnyStore.setTranslation(markerId, result, task.service);
		}

		// Update marker translation in backend
		try {
			const finalText = task.type === 'translation' ? result : 
				(state.markerData.get(markerId)?.translation || result);
			await coreAPI.updateMarkerTranslation(markerId, finalText);
		} catch (error) {
			eventService.error(`Failed to update marker ${markerId} in backend`, error);
		}

		eventService.info(`Task ${taskId} completed for marker ${markerId}`);
	}

	private handleBackendEvent(eventName: string, data: any) {
		// Handle backend events for real OCR/translation results
		if (!data) {
			eventService.warn(`Received bunny event ${eventName} with no data`);
			return;
		}
		
		switch (eventName) {
			case 'bunny:ocr_completed':
				if (data.marker_id && data.text) {
					// Update OCR text
					bunnyStore.setOCRText(data.marker_id, data.text, data.model);
					
					// Find and update the task status
					const ocrState = get(bunnyStore);
					const ocrMarkerData = ocrState.markerData.get(data.marker_id);
					if (ocrMarkerData?.ocrTaskId) {
						bunnyStore.updateTask(ocrMarkerData.ocrTaskId, {
							status: 'completed',
							result: data.text,
							completedAt: Date.now()
						});
					}
				}
				break;

			case 'bunny:translation_completed':
				if (data.marker_id && data.translation) {
					// Update translation text
					bunnyStore.setTranslation(data.marker_id, data.translation, data.service);
					
					// Find and update the task status
					const translationState = get(bunnyStore);
					const translationMarkerData = translationState.markerData.get(data.marker_id);
					if (translationMarkerData?.translationTaskId) {
						bunnyStore.updateTask(translationMarkerData.translationTaskId, {
							status: 'completed',
							result: data.translation,
							completedAt: Date.now()
						});
					}
				}
				break;

			case 'bunny:task_failed':
				if (data.task_id) {
					bunnyStore.updateTask(data.task_id, { 
						status: 'failed', 
						error: data.error 
					});
				}
				break;
				
			case 'bunny:task_started':
			case 'bunny:task_cancelled':
				// These events are handled via the task system
				break;
		}
	}

	// Public API methods

	async requestOCR(markerId: number, model?: OCRModel): Promise<string> {
		if (!this.worker) {
			throw new Error('Bunny service not initialized');
		}

		const imageId = get(currentImageId);
		if (!imageId) {
			throw new Error('No image selected');
		}

		const taskId = this.generateTaskId();
		const ocrModel = model || get(bunnyStore).settings.ocrModel;

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

		// Send to worker
		const message: BunnyWorkerMessage = {
			type: 'ocr_request',
			taskId,
			markerId,
			imageId,
			model: ocrModel
		};
		this.worker.postMessage(message);

		// Also send to backend for real processing
		try {
			await coreAPI.requestOCR(markerId, ocrModel);
		} catch (error) {
			eventService.error(`Failed to send OCR request to backend for marker ${markerId}`, error);
		}

		return taskId;
	}

	async requestTranslation(markerId: number, text?: string, service?: TranslationService): Promise<string> {
		if (!this.worker) {
			throw new Error('Bunny service not initialized');
		}

		// Get text from marker data if not provided
		const markerData = get(bunnyStore).markerData.get(markerId);
		const textToTranslate = text || markerData?.ocrText || '';
		
		if (!textToTranslate) {
			throw new Error('No text to translate');
		}

		const taskId = this.generateTaskId();
		const settings = get(bunnyStore).settings;
		const translationService = service || settings.translationService;

		// Create task
		const task: BunnyTask = {
			id: taskId,
			markerId,
			imageId: get(currentImageId) || 0,
			type: 'translation',
			status: 'queued',
			service: translationService,
			createdAt: Date.now()
		};

		// Add to store
		bunnyStore.addTask(task);
		bunnyStore.setMarkerTaskId(markerId, taskId, 'translation');

		// Send to worker
		const message: BunnyWorkerMessage = {
			type: 'translation_request',
			taskId,
			markerId,
			text: textToTranslate,
			service: translationService,
			sourceLang: settings.sourceLang,
			targetLang: settings.targetLang
		};
		this.worker.postMessage(message);

		// Also send to backend for real processing
		try {
			await coreAPI.requestTranslation(markerId, translationService, settings.sourceLang, settings.targetLang);
		} catch (error) {
			eventService.error(`Failed to send translation request to backend for marker ${markerId}`, error);
		}

		return taskId;
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
		if (!this.worker) return;

		const message: BunnyWorkerMessage = {
			type: 'cancel_task',
			taskId
		};
		this.worker.postMessage(message);

		// Also notify backend
		try {
			await coreAPI.cancelBunnyTask(taskId);
		} catch (error) {
			eventService.error(`Failed to cancel task ${taskId} in backend`, error);
		}
	}

	async clearQueue() {
		if (!this.worker) return;

		const message: BunnyWorkerMessage = {
			type: 'clear_queue'
		};
		this.worker.postMessage(message);

		bunnyStore.clearAllTasks();
	}

	getQueueStatus() {
		if (!this.worker) return;

		const message: BunnyWorkerMessage = {
			type: 'get_queue_status'
		};
		this.worker.postMessage(message);
	}

	// Helper methods

	private generateTaskId(): string {
		return `bunny_task_${Date.now()}_${++this.taskIdCounter}`;
	}

	// Get rectangle markers for current image
	getRectangleMarkers() {
		const allMarkers = get(markers);
		return allMarkers.filter(marker => marker.geometry.type === 'rectangle');
	}

	// Cleanup
	destroy() {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.initialized = false;
		bunnyStore.reset();
	}
}

// Create singleton instance
export const bunnyService = new BunnyService();