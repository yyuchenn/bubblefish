/**
 * Web Worker for handling snapshot export operations in the background
 * This worker exports project data and saves it to IndexedDB without blocking the main thread
 */

import { snapshotStorage } from '../utils/snapshotStorage';

export interface SnapshotTask {
	action: 'export' | 'cleanup' | 'getStats';
	projectId?: number;
	projectName?: string;
	data?: Uint8Array; // For when data is passed from main thread
}

export interface SnapshotWorkerResult {
	success: boolean;
	action: string;
	snapshotId?: string;
	fileName?: string;
	error?: string;
	stats?: {
		totalSize: number;
		usedSize: number;
		availableSize: number;
		snapshotCount: number;
	};
}

/**
 * Format current date/time as YYYYMMDDHHMMSS
 */
function formatDateTime(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');
	
	return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Export a project snapshot
 */
async function exportSnapshot(projectId: number, projectName: string, data: Uint8Array): Promise<SnapshotWorkerResult> {
	try {
		// Generate filename
		const timestamp = formatDateTime();
		const fileName = `${projectName}_${timestamp}.bf`;
		
		// Create snapshot object
		const snapshot = {
			projectId,
			projectName,
			fileName,
			data,
			size: data.length,
			createdAt: new Date()
		};
		
		// Save to IndexedDB
		const snapshotId = await snapshotStorage.saveSnapshot(snapshot);
		
		console.log(`Snapshot exported: ${fileName} (${(data.length / 1024).toFixed(1)} KB)`);
		
		return {
			success: true,
			action: 'export',
			snapshotId,
			fileName
		};
	} catch (error) {
		console.error('Failed to export snapshot:', error);
		return {
			success: false,
			action: 'export',
			error: error instanceof Error ? error.message : 'Failed to export snapshot'
		};
	}
}

/**
 * Clean up old snapshots
 */
async function cleanupSnapshots(): Promise<SnapshotWorkerResult> {
	try {
		// Get storage stats before cleanup
		const statsBefore = await snapshotStorage.getStorageStats();
		
		// The cleanup is handled automatically by snapshotStorage when saving new snapshots
		// Here we can trigger a manual cleanup if needed
		
		// Get storage stats after cleanup
		const statsAfter = await snapshotStorage.getStorageStats();
		
		console.log(`Cleanup completed. Freed ${((statsBefore.usedSize - statsAfter.usedSize) / 1024).toFixed(1)} KB`);
		
		return {
			success: true,
			action: 'cleanup',
			stats: statsAfter
		};
	} catch (error) {
		console.error('Failed to cleanup snapshots:', error);
		return {
			success: false,
			action: 'cleanup',
			error: error instanceof Error ? error.message : 'Failed to cleanup snapshots'
		};
	}
}

/**
 * Get storage statistics
 */
async function getStorageStats(): Promise<SnapshotWorkerResult> {
	try {
		const stats = await snapshotStorage.getStorageStats();
		
		return {
			success: true,
			action: 'getStats',
			stats
		};
	} catch (error) {
		console.error('Failed to get storage stats:', error);
		return {
			success: false,
			action: 'getStats',
			error: error instanceof Error ? error.message : 'Failed to get storage stats'
		};
	}
}

/**
 * Main message handler
 */
self.onmessage = async (e: MessageEvent<SnapshotTask>) => {
	const { action, projectId, projectName, data } = e.data;
	
	try {
		let result: SnapshotWorkerResult;
		
		switch (action) {
			case 'export':
				if (!projectId || !projectName || !data) {
					result = {
						success: false,
						action: 'export',
						error: 'Missing required parameters for export'
					};
				} else {
					result = await exportSnapshot(projectId, projectName, data);
				}
				break;
				
			case 'cleanup':
				result = await cleanupSnapshots();
				break;
				
			case 'getStats':
				result = await getStorageStats();
				break;
				
			default:
				result = {
					success: false,
					action: action || 'unknown',
					error: `Unknown action: ${action}`
				};
		}
		
		self.postMessage(result);
	} catch (error) {
		self.postMessage({
			success: false,
			action: action || 'unknown',
			error: error instanceof Error ? error.message : 'Worker operation failed'
		});
	}
};

// Initialize storage when worker starts
snapshotStorage.initialize().then(() => {
	console.log('Snapshot worker initialized');
}).catch(error => {
	console.error('Failed to initialize snapshot worker:', error);
});