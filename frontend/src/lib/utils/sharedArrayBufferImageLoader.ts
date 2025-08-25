/**
 * SharedArrayBuffer-based image loader for displaying images from WASM
 * Uses streaming to efficiently transfer image data from WASM to JS
 */

import { getOrCreateStream, StreamStatus } from './sharedArrayBufferStream';
import type { CoreAPI } from '../core/adapter';

export class SharedArrayBufferImageLoader {
	private coreAPI: CoreAPI;
	private stream = getOrCreateStream();
	private imageCache = new Map<number, Blob>();

	constructor(coreAPI: CoreAPI) {
		this.coreAPI = coreAPI;
	}

	/**
	 * Load image data from WASM using SharedArrayBuffer
	 * Returns a Blob URL that can be used in img tags
	 */
	async loadImage(imageId: number): Promise<string> {
		// Check cache first
		if (this.imageCache.has(imageId)) {
			const blob = this.imageCache.get(imageId)!;
			return URL.createObjectURL(blob);
		}

		try {
			// Get image binary data from WASM
			const imageData = await this.coreAPI.getImageBinaryData(imageId);
			if (!imageData) {
				throw new Error('Failed to get image data');
			}

			// Get image MIME type
			const mimeType = await this.coreAPI.getImageMimeType(imageId) || 'image/png';

			// Create blob and cache it - ensure we have a regular ArrayBuffer
			const buffer = imageData.buffer instanceof ArrayBuffer 
				? imageData 
				: new Uint8Array(imageData);
			const blob = new Blob([buffer], { type: mimeType });
			this.imageCache.set(imageId, blob);

			// Return blob URL
			return URL.createObjectURL(blob);
		} catch (error) {
			console.error(`Failed to load image ${imageId}:`, error);
			throw error;
		}
	}

	/**
	 * Preload multiple images in parallel
	 */
	async preloadImages(imageIds: number[]): Promise<Map<number, string>> {
		const results = new Map<number, string>();
		
		// Load images in parallel
		const promises = imageIds.map(async (imageId) => {
			try {
				const url = await this.loadImage(imageId);
				results.set(imageId, url);
			} catch (error) {
				console.warn(`Failed to preload image ${imageId}:`, error);
			}
		});

		await Promise.all(promises);
		return results;
	}

	/**
	 * Release cached image and revoke blob URL
	 */
	releaseImage(imageId: number, blobUrl?: string): void {
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
		}
		this.imageCache.delete(imageId);
	}

	/**
	 * Clear all cached images
	 */
	clearCache(): void {
		// Note: We're not revoking URLs here as they might still be in use
		// The browser will garbage collect them when no longer referenced
		this.imageCache.clear();
	}

	/**
	 * Get cache size information
	 */
	getCacheInfo(): { count: number; totalSize: number } {
		let totalSize = 0;
		this.imageCache.forEach(blob => {
			totalSize += blob.size;
		});

		return {
			count: this.imageCache.size,
			totalSize
		};
	}

	/**
	 * Stream image data directly from SharedArrayBuffer
	 * This is more efficient for large images as it doesn't require copying all data at once
	 */
	async streamImageFromBuffer(): Promise<ReadableStream<Uint8Array>> {
		// Reset stream status
		this.stream.setStatus(StreamStatus.IDLE);

		const stream = this.stream;

		// Create a ReadableStream that reads from SharedArrayBuffer
		return new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					// Wait for WASM to start writing
					const writeStarted = await stream.waitForStatus(StreamStatus.WRITING, 5000);
					if (!writeStarted) {
						throw new Error('Timeout waiting for image data');
					}

					const header = stream.readHeader();
					const totalSize = header.totalSize;
					let totalRead = 0;

					// Read data in chunks
					while (totalRead < totalSize) {
						const header = stream.readHeader();
						
						if (header.status === StreamStatus.ERROR) {
							throw new Error('Stream error');
						}

						const writerPos = header.writerPosition;
						const readerPos = header.readerPosition;
						const dataBuffer = stream.getDataBuffer();
						const bufferSize = dataBuffer.length;

						// Calculate available data
						const available = writerPos >= readerPos
							? writerPos - readerPos
							: bufferSize - readerPos + writerPos;

						if (available > 0) {
							// Read available data
							const readSize = Math.min(available, totalSize - totalRead);
							let chunk: Uint8Array;

							if (readerPos + readSize <= bufferSize) {
								// Simple case: continuous read
								chunk = dataBuffer.slice(readerPos, readerPos + readSize);
							} else {
								// Wrap around case
								const firstPart = bufferSize - readerPos;
								const secondPart = readSize - firstPart;
								chunk = new Uint8Array(readSize);
								chunk.set(dataBuffer.slice(readerPos, bufferSize), 0);
								chunk.set(dataBuffer.slice(0, secondPart), firstPart);
							}

							controller.enqueue(chunk);
							totalRead += readSize;

							// Update reader position
							const newReaderPos = (readerPos + readSize) % bufferSize;
							stream.updateReaderPosition(newReaderPos);
						} else if (header.status === StreamStatus.COMPLETE) {
							// All data has been written
							break;
						} else {
							// Wait for more data
							await new Promise(resolve => setTimeout(resolve, 10));
						}
					}

					controller.close();
				} catch (error) {
					controller.error(error);
				}
			}
		});
	}
}

// Singleton instance
let imageLoader: SharedArrayBufferImageLoader | null = null;

export function getImageLoader(coreAPI: CoreAPI): SharedArrayBufferImageLoader {
	if (!imageLoader) {
		imageLoader = new SharedArrayBufferImageLoader(coreAPI);
	}
	return imageLoader;
}