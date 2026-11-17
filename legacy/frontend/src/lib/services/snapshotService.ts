/**
 * Snapshot Service - Automatic project snapshot management
 * Monitors project operations and triggers snapshots every 20 operations
 */

import { get } from 'svelte/store';
import { undoRedoStore } from '../stores/undoRedoStore';
import { projectStore } from '../stores/projectStore';
import { coreAPI } from '../core/adapter';
import { snapshotStorage, type SnapshotMetadata } from '../utils/snapshotStorage';
import type { SnapshotTask, SnapshotWorkerResult } from '../workers/snapshotWorker';

export interface SnapshotServiceConfig {
	enabled: boolean;
	operationThreshold: number; // Number of operations before triggering snapshot
	maxStorageSize: number; // Maximum storage size in bytes
}

class SnapshotService {
	private static instance: SnapshotService;
	private operationCounters: Map<number, number> = new Map();
	private lastCommitIds: Map<number, string> = new Map();
	private snapshotWorker: Worker | null = null;
	private unsubscribeStore: (() => void) | null = null;
	private isInitialized = false;
	private config: SnapshotServiceConfig = {
		enabled: true,
		operationThreshold: 20,
		maxStorageSize: 10 * 1024 * 1024 // 10MB
	};

	private constructor() {}

	static getInstance(): SnapshotService {
		if (!SnapshotService.instance) {
			SnapshotService.instance = new SnapshotService();
		}
		return SnapshotService.instance;
	}

	/**
	 * Initialize the snapshot service
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			// Initialize storage
			await snapshotStorage.initialize();

			// Create Web Worker
			this.snapshotWorker = new Worker(
				new URL('../workers/snapshotWorker.ts', import.meta.url),
				{ type: 'module' }
			);

			// Set up worker message handler
			this.snapshotWorker.onmessage = this.handleWorkerMessage.bind(this);
			this.snapshotWorker.onerror = this.handleWorkerError.bind(this);

			// Subscribe to undo/redo store changes
			this.unsubscribeStore = undoRedoStore.subscribe(state => {
				this.handleStoreChange(state);
			});

			this.isInitialized = true;
			console.log('Snapshot service initialized');
		} catch (error) {
			console.error('Failed to initialize snapshot service:', error);
			throw error;
		}
	}

	/**
	 * Handle store changes to track operations
	 */
	private handleStoreChange(state: any): void {
		if (!this.config.enabled) {
			return;
		}

		// Check each project's commit ID
		for (const [projectId, projectState] of state.projectStates.entries()) {
			const currentCommitId = projectState.currentCommitId;
			
			if (currentCommitId) {
				this.handleCommitChange(projectId, currentCommitId);
			}
		}
	}

	/**
	 * Handle commit ID changes for a project
	 */
	private handleCommitChange(projectId: number, newCommitId: string): void {
		const lastCommitId = this.lastCommitIds.get(projectId);
		
		// If commit ID changed, increment operation counter
		if (lastCommitId && lastCommitId !== newCommitId) {
			const count = (this.operationCounters.get(projectId) || 0) + 1;
			this.operationCounters.set(projectId, count);
			
			// Trigger snapshot if threshold reached
			if (count >= this.config.operationThreshold) {
				this.triggerSnapshot(projectId);
				this.operationCounters.set(projectId, 0);
			}
		}
		
		this.lastCommitIds.set(projectId, newCommitId);
	}

	/**
	 * Trigger a snapshot for a project
	 */
	async triggerSnapshot(projectId: number): Promise<void> {
		if (!this.snapshotWorker) {
			console.error('Snapshot worker not initialized');
			return;
		}

		try {
			// Get project info
			const projects = get(projectStore).projects;
			const project = projects.find(p => p.id === projectId);
			
			if (!project) {
				console.error(`Project ${projectId} not found`);
				return;
			}

			// Export project data using core API
			const result = await coreAPI.saveProject(projectId);
			
			if (result.error) {
				console.error('Failed to export project:', result.error);
				return;
			}

			if (!result.data) {
				console.error('No data returned from project export');
				return;
			}

			// Convert to Uint8Array
			const data = new Uint8Array(result.data);

			// Send to worker for background processing
			const task: SnapshotTask = {
				action: 'export',
				projectId,
				projectName: project.name,
				data
			};

			this.snapshotWorker.postMessage(task);
		} catch (error) {
			console.error('Failed to trigger snapshot:', error);
		}
	}

	/**
	 * Manually create a snapshot for the current project
	 */
	async createManualSnapshot(): Promise<boolean> {
		const currentProjectId = get(projectStore).currentProjectId;
		
		if (!currentProjectId) {
			console.error('No project currently selected');
			return false;
		}

		await this.triggerSnapshot(currentProjectId);
		return true;
	}


	/**
	 * Get all snapshots from all projects
	 */
	async getAllSnapshots(): Promise<SnapshotMetadata[]> {
		try {
			return await snapshotStorage.getAllSnapshotsMetadata();
		} catch (error) {
			console.error('Failed to get all snapshots:', error);
			return [];
		}
	}


	/**
	 * Delete a snapshot
	 */
	async deleteSnapshot(snapshotId: string): Promise<boolean> {
		try {
			await snapshotStorage.deleteSnapshot(snapshotId);
			return true;
		} catch (error) {
			console.error('Failed to delete snapshot:', error);
			return false;
		}
	}


	/**
	 * Get storage statistics
	 */
	async getStorageStats(): Promise<any> {
		try {
			return await snapshotStorage.getStorageStats();
		} catch (error) {
			console.error('Failed to get storage stats:', error);
			return null;
		}
	}

	/**
	 * Update service configuration
	 */
	updateConfig(config: Partial<SnapshotServiceConfig>): void {
		this.config = { ...this.config, ...config };
		console.log('Snapshot service config updated:', this.config);
	}

	/**
	 * Get current configuration
	 */
	getConfig(): SnapshotServiceConfig {
		return { ...this.config };
	}

	/**
	 * Enable/disable snapshot service
	 */
	setEnabled(enabled: boolean): void {
		this.config.enabled = enabled;
		console.log(`Snapshot service ${enabled ? 'enabled' : 'disabled'}`);
	}

	/**
	 * Handle worker messages
	 */
	private handleWorkerMessage(event: MessageEvent<SnapshotWorkerResult>): void {
		const result = event.data;

		if (result.success) {
			switch (result.action) {
				case 'export':
					console.log(`Snapshot saved successfully: ${result.fileName}`);
					break;
				case 'cleanup':
					console.log('Snapshot cleanup completed');
					break;
				case 'getStats':
					console.log('Storage stats retrieved:', result.stats);
					break;
			}
		} else {
			console.error(`Worker operation failed (${result.action}):`, result.error);
		}
	}

	/**
	 * Handle worker errors
	 */
	private handleWorkerError(error: ErrorEvent): void {
		console.error('Snapshot worker error:', error);
	}

	/**
	 * Clean up resources
	 */
	destroy(): void {
		// Unsubscribe from store
		if (this.unsubscribeStore) {
			this.unsubscribeStore();
			this.unsubscribeStore = null;
		}

		// Terminate worker
		if (this.snapshotWorker) {
			this.snapshotWorker.terminate();
			this.snapshotWorker = null;
		}

		// Clear state
		this.operationCounters.clear();
		this.lastCommitIds.clear();
		this.isInitialized = false;

		console.log('Snapshot service destroyed');
	}

	/**
	 * Reset operation counter for a project
	 */
	resetOperationCounter(projectId: number): void {
		this.operationCounters.set(projectId, 0);
		console.log(`Reset operation counter for project ${projectId}`);
	}

	/**
	 * Get operation count for a project
	 */
	getOperationCount(projectId: number): number {
		return this.operationCounters.get(projectId) || 0;
	}
}

// Export singleton instance
export const snapshotService = SnapshotService.getInstance();