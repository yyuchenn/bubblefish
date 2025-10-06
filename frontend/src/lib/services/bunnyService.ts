// Bunny Service - Relay layer between backend and UI
import { get } from 'svelte/store';
import { bunnyStore } from '../stores/bunnyStore';
import type { BunnyTask } from '../types/bunny';
import { eventService } from './eventService';
import { coreAPI } from '../core/adapter';
import { currentImageId } from './imageService';
import { pluginService } from './pluginService';
import { projectStore } from '../stores/projectStore';

class BunnyService {
	private initialized = false;
	private enabledPluginIds: Set<string> = new Set();
	private pluginStoreUnsubscribe: (() => void) | null = null;

	async initialize() {
		if (this.initialized) return;

		try {
			if (!this.pluginStoreUnsubscribe) {
				const pluginStore = pluginService.getPlugins();
				this.pluginStoreUnsubscribe = pluginStore.subscribe(pluginList => {
					this.enabledPluginIds = new Set(
						pluginList.filter(plugin => plugin.enabled).map(plugin => plugin.metadata.id)
					);
				});
			}

			// Subscribe to business events from backend and plugins
			eventService.onBusinessEvent((event) => {
				if (event && event.event_name) {
					if (event.event_name.startsWith('bunny:')) {
						this.handleBackendEvent(event.event_name, event.data);
					} else if (event.event_name.startsWith('plugin:')) {
						// Handle plugin result events and relay to backend
						this.handlePluginEvent(event.event_name, event.data);
					} else if (event.event_name === 'markers:loaded') {
						// Load bunny cache when markers are loaded
						this.handleMarkersLoaded(event.data);
					}
				}
			});

			this.initialized = true;
			eventService.info('Bunny service initialized');
		} catch (error) {
			eventService.error('Failed to initialize Bunny service', error);
			throw error;
		}
	}

	private isPluginEnabled(pluginId?: string): boolean {
		if (!pluginId) return true;
		return this.enabledPluginIds.has(pluginId);
	}

	private handleMarkersLoaded(data: any) {
		if (data && data.markerIds && Array.isArray(data.markerIds)) {
			// Load bunny cache data asynchronously (don't await to avoid blocking)
			this.loadBunnyCacheForMarkers(data.markerIds).catch(error => {
				eventService.error('Failed to load bunny cache after markers loaded', error);
			});
		}
	}

	private async handlePluginEvent(eventName: string, data: any) {
		// Handle plugin result events and relay to backend
		switch (eventName) {
			case 'plugin:ocr_result':
				if (data.task_id && data.text !== undefined && data.model) {
					try {
						// Extract marker_id from task
						const task = get(bunnyStore).tasks.get(data.task_id);
						if (task) {
							await coreAPI.handleOCRCompleted(data.task_id, task.markerId, data.text, data.model);
							eventService.debug(`Relayed OCR result to backend for task ${data.task_id}`);
						} else {
							eventService.warn(`Task ${data.task_id} not found when handling OCR result`);
						}
					} catch (error) {
						eventService.error(`Failed to relay OCR result to backend`, error);
					}
				}
				break;

			case 'plugin:translation_result':
				if (data.task_id && data.translated_text !== undefined && data.service) {
					try {
						// Extract marker_id from task
						const task = get(bunnyStore).tasks.get(data.task_id);
						if (task) {
							await coreAPI.handleTranslationCompleted(data.task_id, task.markerId, data.translated_text, data.service);
							eventService.debug(`Relayed translation result to backend for task ${data.task_id}`);
						} else {
							eventService.warn(`Task ${data.task_id} not found when handling translation result`);
						}
					} catch (error) {
						eventService.error(`Failed to relay translation result to backend`, error);
					}
				}
				break;
		}
	}

	private async handleBackendEvent(eventName: string, data: any) {
		if (!data) {
			eventService.warn(`Received bunny event ${eventName} with no data`);
			return;
		}

		switch (eventName) {
			case 'bunny:task_created':
				// Backend created a task - convert backend format to frontend format
				if (data.task_id && data.marker_id) {
					const task: BunnyTask = {
						id: data.task_id,
						markerId: data.marker_id,
						imageId: data.image_id,
						type: data.task_type, // Already lowercase from backend
						status: data.status,  // Already lowercase from backend
						createdAt: data.created_at,
						startedAt: data.started_at,
						completedAt: data.completed_at,
						error: data.error
					};
					bunnyStore.addTask(task);
					bunnyStore.setMarkerTaskId(data.marker_id, data.task_id, data.task_type);
					eventService.debug(`Task ${data.task_id} created for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:request_plugin_ocr':
				// Backend requests frontend to relay OCR request to plugin
				await this.relayOCRRequestToPlugin(data);
				break;

			case 'bunny:request_plugin_translation':
				// Backend requests frontend to relay translation request to plugin
				await this.relayTranslationRequestToPlugin(data);
				break;

			case 'bunny:ocr_completed':
				if (data.marker_id !== undefined && data.original_text !== undefined) {
					// Update original text (even if empty)
					bunnyStore.setOriginalText(data.marker_id, data.original_text, data.model);

					// Update task status
					if (data.task_id) {
						bunnyStore.updateTask(data.task_id, {
							status: 'completed',
							result: data.original_text,
							completedAt: Date.now()
						});
					}
					eventService.info(`OCR completed for marker ${data.marker_id}`);
				}
				break;

			case 'bunny:translation_completed':
				if (data.marker_id !== undefined && data.machine_translation !== undefined) {
					// Update machine translation (even if empty)
					bunnyStore.setMachineTranslation(data.marker_id, data.machine_translation, data.service);

					// Update task status
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

			case 'bunny:task_failed':
				if (data.task_id && data.error) {
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

	// Relay OCR request from backend to plugin
	private async relayOCRRequestToPlugin(data: any) {
		const { task_id, cropped_image_data, image_format, service_id, source_language } = data;

		try {
			// Get the plugin_id for the service
			const ocrServices = await coreAPI.getAvailableOCRServices();
			const serviceInfo = ocrServices.find(s => s.id === service_id);

			if (!serviceInfo || !this.isPluginEnabled(serviceInfo.plugin_id)) {
				throw new Error(`OCR service '${service_id}' not found`);
			}

			// Send message to plugin with cropped image data from backend
			const message = {
				type: 'ocr_request',
				task_id: task_id,
				image_data: cropped_image_data,  // Already cropped by backend
				image_format: image_format,      // Always "png" from backend
				options: {
					source_language: source_language
				}
			};

			await pluginService.sendPluginMessage('bunny', serviceInfo.plugin_id, message);

			eventService.debug(`Relayed OCR request to plugin ${serviceInfo.plugin_id}`);
		} catch (error) {
			eventService.error(`Failed to relay OCR request to plugin`, error);
			// Notify backend of failure
			await coreAPI.handleTaskFailed(task_id, error instanceof Error ? error.message : String(error));
		}
	}

	// Relay translation request from backend to plugin
	private async relayTranslationRequestToPlugin(data: any) {
		const { task_id, service_id, text, source_language, target_language } = data;

		try {
			// Get the plugin_id for the service
			const translationServices = await coreAPI.getAvailableTranslationServices();
			const serviceInfo = translationServices.find(s => s.id === service_id);

			if (!serviceInfo || !this.isPluginEnabled(serviceInfo.plugin_id)) {
				throw new Error(`Translation service '${service_id}' not found`);
			}

			// Send message to plugin
			const message = {
				type: 'translation_request',
				task_id: task_id,
				text: text,
				options: {
					source_language: source_language,
					target_language: target_language
				}
			};

			await pluginService.sendPluginMessage('bunny', serviceInfo.plugin_id, message);

			eventService.debug(`Relayed translation request to plugin ${serviceInfo.plugin_id}`);
		} catch (error) {
			eventService.error(`Failed to relay translation request to plugin`, error);
			// Notify backend of failure
			await coreAPI.handleTaskFailed(task_id, error instanceof Error ? error.message : String(error));
		}
	}

	// Public API - simplified to just call backend

	async requestOCR(markerId: number, model?: string): Promise<string> {
		const imageId = get(currentImageId);
		if (!imageId) {
			throw new Error('No image selected');
		}

		const projectId = get(projectStore).currentProjectId;
		if (!projectId) {
			throw new Error('No project selected');
		}

		const ocrModel = model || get(bunnyStore).settings.ocrModel;

		// Simply call backend - backend will handle everything including task creation
		const taskId = await coreAPI.requestOCR(markerId, imageId, projectId, ocrModel);

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

		const projectId = get(projectStore).currentProjectId;
		if (!projectId) {
			throw new Error('No project selected');
		}

		const settings = get(bunnyStore).settings;
		const translationService = service || settings.translationService;

		// Simply call backend - backend will handle everything including task creation
		const taskId = await coreAPI.requestTranslation(markerId, imageId, projectId, translationService, textToTranslate);

		return taskId;
	}

	async requestBatchOCR(markerIds: number[], model?: string): Promise<string[]> {
		const taskIds: string[] = [];
		const ocrModel = model || get(bunnyStore).settings.ocrModel;
		const batchSize = get(bunnyStore).settings.batchSize;

		for (let i = 0; i < markerIds.length; i += batchSize) {
			const batch = markerIds.slice(i, i + batchSize);

			for (const markerId of batch) {
				try {
					const taskId = await this.requestOCR(markerId, ocrModel);
					taskIds.push(taskId);
				} catch (error) {
					eventService.error(`Failed to request OCR for marker ${markerId}`, error);
				}
			}

			// Small delay between batches to avoid overwhelming the system
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

		for (let i = 0; i < markerIds.length; i += batchSize) {
			const batch = markerIds.slice(i, i + batchSize);

			for (const markerId of batch) {
				try {
					const taskId = await this.requestTranslation(markerId, undefined, translationService);
					taskIds.push(taskId);
				} catch (error) {
					eventService.error(`Failed to request translation for marker ${markerId}`, error);
				}
			}

			// Small delay between batches to avoid overwhelming the system
			if (i + batchSize < markerIds.length) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		return taskIds;
	}

	async cancelTask(taskId: string) {
		// Notify backend to cancel task
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

	// Helper methods

	// Load bunny cache data for markers
	async loadBunnyCacheForMarkers(markerIds: number[]) {
		try {
			for (const markerId of markerIds) {
				const cacheData = await coreAPI.getBunnyCache(markerId);
				if (cacheData) {
					if (cacheData.original_text) {
						bunnyStore.setOriginalText(
							markerId,
							cacheData.original_text,
							cacheData.last_ocr_model || 'unknown'
						);
					}
					if (cacheData.machine_translation) {
						bunnyStore.setMachineTranslation(
							markerId,
							cacheData.machine_translation,
							cacheData.last_translation_service || 'unknown'
						);
					}
				}
			}
		} catch (error) {
			eventService.error('Failed to load bunny cache data', error);
		}
	}

	// Cleanup
	destroy() {
		this.initialized = false;
		if (this.pluginStoreUnsubscribe) {
			this.pluginStoreUnsubscribe();
			this.pluginStoreUnsubscribe = null;
		}
		this.enabledPluginIds.clear();
		bunnyStore.reset();
	}
}

// Create singleton instance
export const bunnyService = new BunnyService();