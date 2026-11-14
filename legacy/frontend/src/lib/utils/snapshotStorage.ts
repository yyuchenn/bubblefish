/**
 * IndexedDB storage management for project snapshots
 * Handles storing, retrieving, and managing snapshot data within a 10MB limit
 */

export interface Snapshot {
	id: string;
	projectId: number;
	projectName: string;
	fileName: string;
	data: Uint8Array;
	size: number;
	createdAt: Date;
}

export interface SnapshotMetadata {
	id: string;
	projectId: number;
	projectName: string;
	fileName: string;
	size: number;
	createdAt: Date;
}

class SnapshotStorage {
	private dbName = 'bubblefish_snapshots';
	private storeName = 'snapshots';
	private dbVersion = 1;
	private maxStorageSize = 10 * 1024 * 1024; // 10MB
	private db: IDBDatabase | null = null;

	/**
	 * Initialize the IndexedDB database
	 */
	async initialize(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.dbVersion);

			request.onerror = () => {
				console.error('Failed to open IndexedDB:', request.error);
				reject(request.error);
			};

			request.onsuccess = () => {
				this.db = request.result;
				console.log('IndexedDB initialized successfully');
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				
				// Create object store if it doesn't exist
				if (!db.objectStoreNames.contains(this.storeName)) {
					const objectStore = db.createObjectStore(this.storeName, { keyPath: 'id' });
					
					// Create indexes for efficient querying
					objectStore.createIndex('projectId', 'projectId', { unique: false });
					objectStore.createIndex('createdAt', 'createdAt', { unique: false });
					objectStore.createIndex('projectId_createdAt', ['projectId', 'createdAt'], { unique: false });
				}
			};
		});
	}

	/**
	 * Ensure database is initialized
	 */
	private async ensureDB(): Promise<IDBDatabase> {
		if (!this.db) {
			await this.initialize();
		}
		if (!this.db) {
			throw new Error('Failed to initialize database');
		}
		return this.db;
	}

	/**
	 * Save a snapshot to IndexedDB
	 */
	async saveSnapshot(snapshot: Omit<Snapshot, 'id'>): Promise<string> {
		const db = await this.ensureDB();
		
		// Generate unique ID
		const id = `${snapshot.projectId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const fullSnapshot: Snapshot = { ...snapshot, id };

		// Check storage size and cleanup if necessary
		const currentSize = await this.getStorageSize();
		const newTotalSize = currentSize + snapshot.size;
		
		if (newTotalSize > this.maxStorageSize) {
			await this.cleanupUntilSpaceAvailable(snapshot.size);
		}

		// Save the snapshot
		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readwrite');
			const store = transaction.objectStore(this.storeName);
			const request = store.add(fullSnapshot);

			request.onsuccess = () => {
				console.log(`Snapshot saved: ${fullSnapshot.fileName} (${this.formatSize(fullSnapshot.size)})`);
				resolve(id);
			};

			request.onerror = () => {
				console.error('Failed to save snapshot:', request.error);
				reject(request.error);
			};
		});
	}


	/**
	 * Get a single snapshot with data
	 */
	async getSnapshot(id: string): Promise<Snapshot | null> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readonly');
			const store = transaction.objectStore(this.storeName);
			const request = store.get(id);

			request.onsuccess = () => {
				resolve(request.result || null);
			};

			request.onerror = () => {
				console.error('Failed to get snapshot:', request.error);
				reject(request.error);
			};
		});
	}

	/**
	 * Delete a snapshot
	 */
	async deleteSnapshot(id: string): Promise<void> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readwrite');
			const store = transaction.objectStore(this.storeName);
			const request = store.delete(id);

			request.onsuccess = () => {
				console.log(`Snapshot deleted: ${id}`);
				resolve();
			};

			request.onerror = () => {
				console.error('Failed to delete snapshot:', request.error);
				reject(request.error);
			};
		});
	}

	/**
	 * Get total storage size used
	 */
	async getStorageSize(): Promise<number> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readonly');
			const store = transaction.objectStore(this.storeName);
			const request = store.getAll();

			request.onsuccess = () => {
				const snapshots = request.result as Snapshot[];
				const totalSize = snapshots.reduce((sum, s) => sum + s.size, 0);
				resolve(totalSize);
			};

			request.onerror = () => {
				console.error('Failed to calculate storage size:', request.error);
				reject(request.error);
			};
		});
	}

	/**
	 * Clean up old snapshots until there's enough space
	 */
	private async cleanupUntilSpaceAvailable(requiredSpace: number): Promise<void> {
		await this.ensureDB();
		const currentSize = await this.getStorageSize();
		const targetSize = this.maxStorageSize - requiredSpace;

		if (currentSize <= targetSize) {
			return;
		}

		// Get all snapshots sorted by creation date (oldest first)
		const snapshots = await this.getAllSnapshots();
		snapshots.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

		let freedSpace = 0;
		const toDelete: string[] = [];

		// Mark snapshots for deletion until we have enough space
		for (const snapshot of snapshots) {
			if (currentSize - freedSpace <= targetSize) {
				break;
			}
			toDelete.push(snapshot.id);
			freedSpace += snapshot.size;
		}

		// Delete marked snapshots
		for (const id of toDelete) {
			await this.deleteSnapshot(id);
		}

		console.log(`Cleaned up ${toDelete.length} snapshots to free ${this.formatSize(freedSpace)}`);
	}

	/**
	 * Get all snapshots from all projects (without data)
	 */
	async getAllSnapshotsMetadata(): Promise<SnapshotMetadata[]> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readonly');
			const store = transaction.objectStore(this.storeName);
			const request = store.getAll();

			request.onsuccess = () => {
				const snapshots = request.result as Snapshot[];
				// Return metadata only (without the actual data)
				const metadata = snapshots.map(s => ({
					id: s.id,
					projectId: s.projectId,
					projectName: s.projectName,
					fileName: s.fileName,
					size: s.size,
					createdAt: s.createdAt
				}));
				
				// Sort by creation date (newest first)
				metadata.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
				resolve(metadata);
			};

			request.onerror = () => {
				console.error('Failed to get all snapshots:', request.error);
				reject(request.error);
			};
		});
	}

	/**
	 * Get all snapshots from all projects (private method with data)
	 */
	private async getAllSnapshots(): Promise<Snapshot[]> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readonly');
			const store = transaction.objectStore(this.storeName);
			const request = store.getAll();

			request.onsuccess = () => {
				resolve(request.result || []);
			};

			request.onerror = () => {
				console.error('Failed to get all snapshots:', request.error);
				reject(request.error);
			};
		});
	}


	/**
	 * Clear all snapshots
	 */
	async clearAllSnapshots(): Promise<void> {
		const db = await this.ensureDB();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction([this.storeName], 'readwrite');
			const store = transaction.objectStore(this.storeName);
			const request = store.clear();

			request.onsuccess = () => {
				console.log('All snapshots cleared');
				resolve();
			};

			request.onerror = () => {
				console.error('Failed to clear snapshots:', request.error);
				reject(request.error);
			};
		});
	}

	/**
	 * Get storage statistics
	 */
	async getStorageStats(): Promise<{
		totalSize: number;
		usedSize: number;
		availableSize: number;
		snapshotCount: number;
	}> {
		const snapshots = await this.getAllSnapshots();
		const usedSize = snapshots.reduce((sum, s) => sum + s.size, 0);

		return {
			totalSize: this.maxStorageSize,
			usedSize,
			availableSize: this.maxStorageSize - usedSize,
			snapshotCount: snapshots.length
		};
	}

	/**
	 * Format size in bytes to human readable format
	 */
	private formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
}

// Export singleton instance
export const snapshotStorage = new SnapshotStorage();