/**
 * SharedArrayBuffer streaming communication between JS and WASM
 * Implements a lock-free ring buffer for efficient image data transfer
 */

export interface StreamHeader {
	// Control flags (first 32 bytes)
	writerPosition: number;  // Current write position (4 bytes)
	readerPosition: number;  // Current read position (4 bytes)
	totalSize: number;       // Total size of data to transfer (4 bytes)
	chunkSize: number;       // Size of each chunk (4 bytes)
	status: number;          // 0=idle, 1=writing, 2=reading, 3=complete, 4=error (4 bytes)
	imageId: number;         // Image ID being transferred (4 bytes)
	format: number;          // Image format enum (4 bytes)
	reserved: number;        // Reserved for future use (4 bytes)
}

export const HEADER_SIZE = 32; // bytes
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB chunks
export const DEFAULT_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB buffer

export enum StreamStatus {
	IDLE = 0,
	WRITING = 1,
	READING = 2,
	COMPLETE = 3,
	ERROR = 4
}

export enum ImageFormatEnum {
	JPEG = 0,
	PNG = 1,
	GIF = 2,
	WEBP = 3,
	BMP = 4,
	LABELPLUS = 10,
	BF = 11
}

export class SharedArrayBufferStream {
	private buffer: SharedArrayBuffer;
	private dataArray: Uint8Array;
	private headerArray: Int32Array;

	constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
		// Create SharedArrayBuffer with extra space for header
		this.buffer = new SharedArrayBuffer(bufferSize + HEADER_SIZE);
		
		// Header uses Int32Array for atomic operations
		this.headerArray = new Int32Array(this.buffer, 0, HEADER_SIZE / 4);
		
		// Data starts after header
		this.dataArray = new Uint8Array(this.buffer, HEADER_SIZE);
	}

	getSharedArrayBuffer(): SharedArrayBuffer {
		return this.buffer;
	}

	// Writer methods (JS side)
	async writeImageData(imageId: number, format: ImageFormatEnum, data: Uint8Array): Promise<void> {
		// Reset positions
		Atomics.store(this.headerArray, 0, 0); // writerPosition
		Atomics.store(this.headerArray, 1, 0); // readerPosition
		Atomics.store(this.headerArray, 2, data.length); // totalSize
		Atomics.store(this.headerArray, 3, DEFAULT_CHUNK_SIZE); // chunkSize
		Atomics.store(this.headerArray, 4, StreamStatus.WRITING); // status
		Atomics.store(this.headerArray, 5, imageId); // imageId
		Atomics.store(this.headerArray, 6, format); // format

		const totalSize = data.length;
		const bufferDataSize = this.dataArray.length;
		let written = 0;

		while (written < totalSize) {
			// Wait if reader hasn't caught up
			const readerPos = Atomics.load(this.headerArray, 1);
			const writerPos = Atomics.load(this.headerArray, 0);
			
			// Calculate available space in ring buffer
			const availableSpace = writerPos >= readerPos 
				? bufferDataSize - writerPos + readerPos
				: readerPos - writerPos;

			if (availableSpace <= 1) {
				// Buffer full, wait for reader
				await this.sleep(1);
				continue;
			}

			// Calculate how much we can write
			const remainingData = totalSize - written;
			const writeSize = Math.min(remainingData, availableSpace - 1, DEFAULT_CHUNK_SIZE);

			// Write data to ring buffer
			const writeEnd = writerPos + writeSize;
			if (writeEnd <= bufferDataSize) {
				// Simple case: continuous write
				this.dataArray.set(data.subarray(written, written + writeSize), writerPos);
			} else {
				// Wrap around case
				const firstPart = bufferDataSize - writerPos;
				this.dataArray.set(data.subarray(written, written + firstPart), writerPos);
				this.dataArray.set(data.subarray(written + firstPart, written + writeSize), 0);
			}

			written += writeSize;

			// Update writer position atomically
			const newWriterPos = writeEnd % bufferDataSize;
			Atomics.store(this.headerArray, 0, newWriterPos);
			
			// Notify WASM that new data is available
			Atomics.notify(this.headerArray, 0);
		}

		// Mark as complete
		Atomics.store(this.headerArray, 4, StreamStatus.COMPLETE);
		Atomics.notify(this.headerArray, 4);
	}

	// Reader methods (WASM side interface - will be called from WASM)
	readHeader(): StreamHeader {
		return {
			writerPosition: Atomics.load(this.headerArray, 0),
			readerPosition: Atomics.load(this.headerArray, 1),
			totalSize: Atomics.load(this.headerArray, 2),
			chunkSize: Atomics.load(this.headerArray, 3),
			status: Atomics.load(this.headerArray, 4),
			imageId: Atomics.load(this.headerArray, 5),
			format: Atomics.load(this.headerArray, 6),
			reserved: Atomics.load(this.headerArray, 7)
		};
	}

	// Get buffer for WASM to read
	getDataBuffer(): Uint8Array {
		return this.dataArray;
	}

	// Update reader position (called from WASM)
	updateReaderPosition(newPosition: number): void {
		Atomics.store(this.headerArray, 1, newPosition);
		Atomics.notify(this.headerArray, 1);
	}

	// Set status (called from either side)
	setStatus(status: StreamStatus): void {
		Atomics.store(this.headerArray, 4, status);
		Atomics.notify(this.headerArray, 4);
	}

	// Wait for status change
	async waitForStatus(expectedStatus: StreamStatus, timeout: number = 30000): Promise<boolean> {
		const startTime = Date.now();
		
		while (Date.now() - startTime < timeout) {
			const currentStatus = Atomics.load(this.headerArray, 4);
			if (currentStatus === expectedStatus) {
				return true;
			}
			if (currentStatus === StreamStatus.ERROR) {
				return false;
			}
			
			// Wait for notification with timeout
			const result = Atomics.wait(this.headerArray, 4, currentStatus, 100);
			if (result === 'timed-out') {
				continue;
			}
		}
		
		return false;
	}

	// Helper to check if SharedArrayBuffer is available
	static isSupported(): boolean {
		return typeof SharedArrayBuffer !== 'undefined' && 
			   typeof Atomics !== 'undefined';
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// Global stream instance (will be shared with WASM)
let globalStream: SharedArrayBufferStream | null = null;

export function getOrCreateStream(minBufferSize?: number): SharedArrayBufferStream {
	if (!SharedArrayBufferStream.isSupported()) {
		throw new Error('SharedArrayBuffer is not supported. Please ensure proper CORS headers are set.');
	}
	
	// If we need a larger buffer than the current one, recreate it
	if (minBufferSize && globalStream) {
		const currentSize = globalStream.getSharedArrayBuffer().byteLength - HEADER_SIZE;
		if (minBufferSize > currentSize) {
			globalStream = null; // Force recreation with larger size
		}
	}
	
	if (!globalStream) {
		// Use the larger of default size or requested minimum size
		const bufferSize = Math.max(DEFAULT_BUFFER_SIZE, minBufferSize || 0);
		globalStream = new SharedArrayBufferStream(bufferSize);
	}
	return globalStream;
}