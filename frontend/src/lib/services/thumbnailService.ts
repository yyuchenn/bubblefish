import { writable } from 'svelte/store';
import { eventSystem } from '$lib/core/events';
import type { BusinessEvent } from '$lib/core/events';
import { isTauri } from '$lib/core/tauri';

export interface ThumbnailData {
	image_id: number;
	data: string; // base64编码的图片数据
	format: 'Jpeg' | 'Png' | 'Gif' | 'Webp' | 'Bmp';
	width: number;
	height: number;
}

interface ThumbnailStore {
	thumbnails: Map<number, ThumbnailData>;
	loadingThumbnails: Set<number>;
}

const initialState: ThumbnailStore = {
	thumbnails: new Map(),
	loadingThumbnails: new Set()
};

export const thumbnailStore = writable<ThumbnailStore>(initialState);

class ThumbnailService {
	private unsubscribeEvent: (() => void) | null = null;

	constructor() {
		this.initEventListener();
	}

	private initEventListener() {
		// 监听缩略图就绪事件
		this.unsubscribeEvent = eventSystem.addBusinessEventHandler((event: BusinessEvent) => {
			if (event.event_name === 'thumbnail_ready') {
				this.handleThumbnailReady(event.data as ThumbnailData);
			}
		});
	}

	private handleThumbnailReady(data: ThumbnailData) {
		const thumbnailData: ThumbnailData = {
			image_id: data.image_id,
			data: data.data,
			format: data.format,
			width: data.width,
			height: data.height
		};

		thumbnailStore.update(store => {
			// 创建新的store对象以确保响应式更新
			const newStore: ThumbnailStore = {
				thumbnails: new Map(store.thumbnails),
				loadingThumbnails: new Set(store.loadingThumbnails)
			};
			
			// 添加缩略图数据
			newStore.thumbnails.set(thumbnailData.image_id, thumbnailData);
			// 移除loading状态
			newStore.loadingThumbnails.delete(thumbnailData.image_id);
			return newStore;
		});
	}

	/**
	 * 请求缩略图
	 * @param imageId 图片ID
	 */
	async requestThumbnail(imageId: number): Promise<void> {
		// 检查是否已有缩略图或正在加载
		const store = await new Promise<ThumbnailStore>((resolve) => {
			const unsubscribe = thumbnailStore.subscribe(resolve);
			unsubscribe();
		});

		if (store.thumbnails.has(imageId) || store.loadingThumbnails.has(imageId)) {
			return;
		}

		// 标记为加载中
		thumbnailStore.update(store => {
			const newStore: ThumbnailStore = {
				thumbnails: new Map(store.thumbnails),
				loadingThumbnails: new Set(store.loadingThumbnails)
			};
			newStore.loadingThumbnails.add(imageId);
			return newStore;
		});

		try {
			if (isTauri()) {
				// Tauri环境：调用Tauri API
				const { invoke } = await import('@tauri-apps/api/core');
				await invoke('tauri_request_thumbnail', { imageId });
			} else {
				// Web/WASM环境：使用核心API（支持Worker和直接WASM）
				const { coreAPI } = await import('$lib/core/adapter');
				
				// 检查是否是Worker适配器（类型安全）
				if ('requestThumbnail' in coreAPI && typeof coreAPI.requestThumbnail === 'function') {
					const result = await (coreAPI as { requestThumbnail: (id: number) => Promise<string> }).requestThumbnail(imageId);
					if (result !== "ok") {
						throw new Error(result);
					}
				} else {
					// 回退到直接WASM调用
					const wasmModule = await import('$lib/wasm-pkg');
					const result = wasmModule.wasm_request_thumbnail(imageId);
					if (result !== "ok") {
						throw new Error(result);
					}
				}
			}
		} catch (error) {
			console.error(`Failed to request thumbnail for image ${imageId}:`, error);
			
			// 移除loading状态
			thumbnailStore.update(store => {
				const newStore: ThumbnailStore = {
					thumbnails: new Map(store.thumbnails),
					loadingThumbnails: new Set(store.loadingThumbnails)
				};
				newStore.loadingThumbnails.delete(imageId);
				return newStore;
			});
		}
	}

	/**
	 * 检查缩略图是否存在
	 * @param imageId 图片ID
	 */
	hasThumbnail(imageId: number): boolean {
		let currentStore: ThumbnailStore = initialState;
		const unsubscribe = thumbnailStore.subscribe(store => {
			currentStore = store;
		});
		unsubscribe();
		return currentStore.thumbnails.has(imageId);
	}

	/**
	 * 批量请求缩略图（使用Rayon并行处理）
	 * @param imageIds 图片ID数组
	 */
	async requestThumbnails(imageIds: number[]): Promise<void> {
		if (imageIds.length === 0) return;

		// 过滤出需要加载的图片ID
		const store = await new Promise<ThumbnailStore>((resolve) => {
			const unsubscribe = thumbnailStore.subscribe(resolve);
			unsubscribe();
		});

		const idsToLoad = imageIds.filter(id => 
			!store.thumbnails.has(id) && !store.loadingThumbnails.has(id)
		);

		if (idsToLoad.length === 0) return;

		// 标记所有待加载的图片为加载中
		thumbnailStore.update(store => {
			const newStore: ThumbnailStore = {
				thumbnails: new Map(store.thumbnails),
				loadingThumbnails: new Set(store.loadingThumbnails)
			};
			idsToLoad.forEach(id => newStore.loadingThumbnails.add(id));
			return newStore;
		});

		try {
			if (isTauri()) {
				// Tauri环境：并发调用Tauri API
				const { invoke } = await import('@tauri-apps/api/core');
				const promises = idsToLoad.map(id => invoke('tauri_request_thumbnail', { imageId: id }));
				await Promise.allSettled(promises);
			} else {
				// Web/WASM环境：使用Rayon批量处理
				const { coreAPI } = await import('$lib/core/adapter');
				
				// 检查是否支持批量请求
				if ('requestThumbnailsBatch' in coreAPI && typeof coreAPI.requestThumbnailsBatch === 'function') {
					const result = await (coreAPI as { requestThumbnailsBatch: (ids: number[]) => Promise<string> }).requestThumbnailsBatch(idsToLoad);
					if (result !== "ok") {
						throw new Error(result);
					}
				} else if ('requestThumbnail' in coreAPI && typeof coreAPI.requestThumbnail === 'function') {
					// 回退到单个请求
					const promises = idsToLoad.map(id => (coreAPI as { requestThumbnail: (id: number) => Promise<string> }).requestThumbnail(id));
					await Promise.allSettled(promises);
				} else {
					// 回退到直接WASM调用（支持批量）
					const wasmModule = await import('$lib/wasm-pkg');
					if (wasmModule.wasm_request_thumbnails_batch) {
						const uint32Array = new Uint32Array(idsToLoad);
						const result = wasmModule.wasm_request_thumbnails_batch(uint32Array);
						if (result !== "ok") {
							throw new Error(result);
						}
					} else {
						// 最终回退到单个请求
						const promises = idsToLoad.map(id => {
							const result = wasmModule.wasm_request_thumbnail(id);
							return result === "ok" ? Promise.resolve() : Promise.reject(new Error(result));
						});
						await Promise.allSettled(promises);
					}
				}
			}
		} catch (error) {
			console.error(`Failed to request thumbnails for images:`, error);
			
			// 移除所有失败的loading状态
			thumbnailStore.update(store => {
				const newStore: ThumbnailStore = {
					thumbnails: new Map(store.thumbnails),
					loadingThumbnails: new Set(store.loadingThumbnails)
				};
				idsToLoad.forEach(id => newStore.loadingThumbnails.delete(id));
				return newStore;
			});
		}
	}

	/**
	 * 清理缩略图缓存
	 * @param imageId 可选的图片ID，如果不提供则清理所有
	 */
	clearThumbnails(imageId?: number) {
		thumbnailStore.update(store => {
			if (imageId !== undefined) {
				store.thumbnails.delete(imageId);
				store.loadingThumbnails.delete(imageId);
			} else {
				store.thumbnails.clear();
				store.loadingThumbnails.clear();
			}
			return store;
		});
	}

	destroy() {
		if (this.unsubscribeEvent) {
			this.unsubscribeEvent();
			this.unsubscribeEvent = null;
		}
	}
}

// 创建单例服务
export const thumbnailService = new ThumbnailService();