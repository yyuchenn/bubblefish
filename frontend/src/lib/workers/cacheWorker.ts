// Web Worker for large cache operations
// This worker handles heavy caching operations to avoid blocking the main thread

export interface CacheWorkerData {
	action: 'clear' | 'cleanup' | 'preload' | 'export';
	data?: unknown;
	options?: CacheWorkerOptions;
}

export interface CacheWorkerOptions {
	maxSize?: number;
	maxEntries?: number;
	batchSize?: number;
}

export interface CacheWorkerResult {
	success: boolean;
	data?: unknown;
	stats?: {
		processed: number;
		errors: number;
		totalSize: number;
		duration: number;
	};
	error?: string;
}

// 缓存条目接口
interface CacheEntry {
	id: string;
	data: ArrayBuffer;
	metadata: {
		size: number;
		lastAccessed: number;
		accessCount: number;
		type: string;
	};
}

// 内存中的临时缓存
const tempCache = new Map<string, CacheEntry>();


// 清理缓存
async function clearCache(): Promise<CacheWorkerResult> {
	const startTime = Date.now();
	
	try {
		const size = tempCache.size;
		tempCache.clear();
		
		const duration = Date.now() - startTime;
		
		return {
			success: true,
			stats: {
				processed: size,
				errors: 0,
				totalSize: 0,
				duration
			}
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : '清理缓存失败'
		};
	}
}

// 清理过期或低优先级的缓存项
async function cleanupCache(options: CacheWorkerOptions): Promise<CacheWorkerResult> {
	const startTime = Date.now();
	const { maxSize = 100 * 1024 * 1024, maxEntries = 1000 } = options;
	
	try {
		let totalSize = 0;
		let processed = 0;
		const errors = 0;
		
		// 计算当前总大小
		for (const entry of tempCache.values()) {
			totalSize += entry.metadata.size;
		}
		
		// 如果超过限制，进行清理
		if (tempCache.size > maxEntries || totalSize > maxSize) {
			// 按最后访问时间和访问频率排序
			const entries = Array.from(tempCache.entries()).sort(([, a], [, b]) => {
				const scoreA = a.metadata.lastAccessed * a.metadata.accessCount;
				const scoreB = b.metadata.lastAccessed * b.metadata.accessCount;
				return scoreA - scoreB; // 分数低的优先删除
			});
			
			// 删除低优先级的项目
			while ((tempCache.size > maxEntries * 0.8 || totalSize > maxSize * 0.8) && entries.length > 0) {
				const [id, entry] = entries.shift()!;
				tempCache.delete(id);
				totalSize -= entry.metadata.size;
				processed++;
			}
		}
		
		const duration = Date.now() - startTime;
		
		return {
			success: true,
			stats: {
				processed,
				errors,
				totalSize,
				duration
			}
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : '清理缓存失败'
		};
	}
}

// 预加载数据
async function preloadData(imageIds: number[], options: CacheWorkerOptions): Promise<CacheWorkerResult> {
	const startTime = Date.now();
	const { batchSize = 10 } = options;
	
	try {
		let processed = 0;
		let errors = 0;
		let totalSize = 0;
		
		// 分批处理
		for (let i = 0; i < imageIds.length; i += batchSize) {
			const batch = imageIds.slice(i, i + batchSize);
			
			// 这里应该调用实际的数据加载逻辑
			// 目前只是模拟
			for (const imageId of batch) {
				try {
					// 模拟数据加载
					const mockData = new ArrayBuffer(1024); // 1KB mock data
					const entry: CacheEntry = {
						id: imageId.toString(),
						data: mockData,
						metadata: {
							size: mockData.byteLength,
							lastAccessed: Date.now(),
							accessCount: 1,
							type: 'image'
						}
					};
					
					tempCache.set(imageId.toString(), entry);
					totalSize += mockData.byteLength;
					processed++;
				} catch (error) {
					console.error(`预加载图片 ${imageId} 失败:`, error);
					errors++;
				}
			}
			
			// 避免阻塞线程
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		
		const duration = Date.now() - startTime;
		
		return {
			success: true,
			stats: {
				processed,
				errors,
				totalSize,
				duration
			}
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : '预加载失败'
		};
	}
}


// 导出缓存数据
async function exportCache(format: 'json' | 'binary' = 'json'): Promise<CacheWorkerResult> {
	const startTime = Date.now();
	
	try {
		let processed = 0;
		let totalSize = 0;
		let exportData: unknown;
		
		if (format === 'json') {
			const jsonData: Record<string, unknown> = {};
			
			for (const [id, entry] of tempCache.entries()) {
				// 将 ArrayBuffer 转换为 Base64
				const base64Data = btoa(String.fromCharCode(...new Uint8Array(entry.data)));
				jsonData[id] = {
					data: base64Data,
					metadata: entry.metadata
				};
				processed++;
				totalSize += entry.data.byteLength;
			}
			
			exportData = JSON.stringify(jsonData);
		} else {
			// 二进制格式导出
			const buffers: ArrayBuffer[] = [];
			const metadata: Array<{ id: string; size: number; lastAccessed: number; accessCount: number; type: string }> = [];
			
			for (const [id, entry] of tempCache.entries()) {
				buffers.push(entry.data);
				metadata.push({ id, ...entry.metadata });
				processed++;
				totalSize += entry.data.byteLength;
			}
			
			exportData = { buffers, metadata };
		}
		
		const duration = Date.now() - startTime;
		
		return {
			success: true,
			data: exportData,
			stats: {
				processed,
				errors: 0,
				totalSize,
				duration
			}
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : '导出失败'
		};
	}
}

// 主处理函数
async function processCacheOperation(workerData: CacheWorkerData): Promise<CacheWorkerResult> {
	const { action, data, options = {} } = workerData;
	
	switch (action) {
		case 'clear':
			return await clearCache();
			
		case 'cleanup':
			return await cleanupCache(options);
			
		case 'preload':
			return await preloadData(data as number[], options);
			
			
		case 'export':
			return await exportCache(data as 'json' | 'binary');
			
		default:
			return {
				success: false,
				error: `未知的操作类型: ${action}`
			};
	}
}

// Worker message handler
self.onmessage = async (e: MessageEvent<CacheWorkerData>) => {
	try {
		const result = await processCacheOperation(e.data);
		self.postMessage(result);
	} catch (error) {
		self.postMessage({
			success: false,
			error: error instanceof Error ? error.message : '缓存操作失败'
		});
	}
};