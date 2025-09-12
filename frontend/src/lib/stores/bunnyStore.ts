import { writable, derived, get } from 'svelte/store';
import type { BunnyTask, BunnyMarkerData, BunnySettings, OCRModel, TranslationService, BunnyQueueStatus } from '../types/bunny';

interface BunnyState {
	// Selection state
	selectedMarkerIds: Set<number>;
	
	// Data storage
	markerData: Map<number, BunnyMarkerData>;
	tasks: Map<string, BunnyTask>;
	
	// Settings
	settings: BunnySettings;
	
	// UI state
	isProcessing: boolean;
	expandedSections: Set<'markers' | 'ocr' | 'translation'>;
}

function createBunnyStore() {
	const initialState: BunnyState = {
		selectedMarkerIds: new Set(),
		markerData: new Map(),
		tasks: new Map(),
		settings: {
			ocrModel: 'default',
			translationService: 'default',
			targetLang: 'zh-CN',
			autoTranslateAfterOCR: false,
			batchSize: 5
		},
		isProcessing: false,
		expandedSections: new Set(['markers', 'ocr', 'translation'])
	};

	const { subscribe, set, update } = writable<BunnyState>(initialState);

	return {
		subscribe,
		
		// Selection methods
		selectMarker(markerId: number) {
			update(state => {
				state.selectedMarkerIds.add(markerId);
				return state;
			});
		},
		
		deselectMarker(markerId: number) {
			update(state => {
				state.selectedMarkerIds.delete(markerId);
				return state;
			});
		},
		
		toggleMarkerSelection(markerId: number) {
			update(state => {
				if (state.selectedMarkerIds.has(markerId)) {
					state.selectedMarkerIds.delete(markerId);
				} else {
					state.selectedMarkerIds.add(markerId);
				}
				return state;
			});
		},
		
		selectAllMarkers(markerIds: number[]) {
			update(state => {
				state.selectedMarkerIds = new Set(markerIds);
				return state;
			});
		},
		
		clearSelection() {
			update(state => {
				state.selectedMarkerIds.clear();
				return state;
			});
		},
		
		// Task management
		addTask(task: BunnyTask) {
			update(state => {
				state.tasks.set(task.id, task);
				return state;
			});
		},
		
		updateTask(taskId: string, updates: Partial<BunnyTask>) {
			update(state => {
				const task = state.tasks.get(taskId);
				if (task) {
					state.tasks.set(taskId, { ...task, ...updates });
				}
				return state;
			});
		},
		
		removeTask(taskId: string) {
			update(state => {
				state.tasks.delete(taskId);
				return state;
			});
		},
		
		// Marker data management
		setOCRText(markerId: number, text: string, model?: OCRModel) {
			update(state => {
				const data = state.markerData.get(markerId) || { markerId };
				data.ocrText = text;
				if (model) data.lastOCRModel = model;
				state.markerData.set(markerId, data);
				return state;
			});
		},
		
		setTranslation(markerId: number, translation: string, service?: TranslationService) {
			update(state => {
				const data = state.markerData.get(markerId) || { markerId };
				data.translation = translation;
				if (service) data.lastTranslationService = service;
				state.markerData.set(markerId, data);
				return state;
			});
		},
		
		setMarkerTaskId(markerId: number, taskId: string, taskType: 'ocr' | 'translation') {
			update(state => {
				const data = state.markerData.get(markerId) || { markerId };
				if (taskType === 'ocr') {
					data.ocrTaskId = taskId;
				} else {
					data.translationTaskId = taskId;
				}
				state.markerData.set(markerId, data);
				return state;
			});
		},
		
		clearMarkerData(markerId: number) {
			update(state => {
				state.markerData.delete(markerId);
				return state;
			});
		},
		
		// Settings
		updateSettings(updates: Partial<BunnySettings>) {
			update(state => {
				state.settings = { ...state.settings, ...updates };
				return state;
			});
		},
		
		// UI state
		setProcessing(isProcessing: boolean) {
			update(state => {
				state.isProcessing = isProcessing;
				return state;
			});
		},
		
		toggleSection(section: 'markers' | 'ocr' | 'translation') {
			update(state => {
				if (state.expandedSections.has(section)) {
					state.expandedSections.delete(section);
				} else {
					state.expandedSections.add(section);
				}
				return state;
			});
		},
		
		// Reset
		reset() {
			set(initialState);
		},
		
		// Clear all tasks
		clearAllTasks() {
			update(state => {
				state.tasks.clear();
				// Clear task IDs from marker data
				state.markerData.forEach(data => {
					delete data.ocrTaskId;
					delete data.translationTaskId;
				});
				return state;
			});
		}
	};
}

// Create store instance
export const bunnyStore = createBunnyStore();

// Derived stores for easier access
export const selectedMarkerIds = derived(bunnyStore, $store => $store.selectedMarkerIds);
export const markerData = derived(bunnyStore, $store => $store.markerData);
export const tasks = derived(bunnyStore, $store => $store.tasks);
export const bunnySettings = derived(bunnyStore, $store => $store.settings);
export const isProcessing = derived(bunnyStore, $store => $store.isProcessing);

// Derived queue status
export const queueStatus = derived(bunnyStore, $store => {
	const taskArray = Array.from($store.tasks.values());
	const status: BunnyQueueStatus = {
		totalTasks: taskArray.length,
		queuedTasks: taskArray.filter(t => t.status === 'queued').length,
		processingTasks: taskArray.filter(t => t.status === 'processing').length,
		completedTasks: taskArray.filter(t => t.status === 'completed').length,
		failedTasks: taskArray.filter(t => t.status === 'failed').length
	};
	return status;
});

// Derived active tasks
export const activeTasks = derived(bunnyStore, $store => {
	return Array.from($store.tasks.values())
		.filter(t => t.status === 'queued' || t.status === 'processing')
		.sort((a, b) => a.createdAt - b.createdAt);
});

// Helper to get current state
export function getBunnyState(): BunnyState {
	return get(bunnyStore);
}