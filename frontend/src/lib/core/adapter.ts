// Core adapter for both Tauri and WASM environments
import { isTauri } from './tauri';
import { browser } from '$app/environment';
import type { ImageMetadata, ImageFormat, Marker, TranslationProject, OpeningProjectInfo, UndoRedoResult, Language } from '../types';
import { eventSystem, type LogEvent } from './events';
import type { WasmWorkerMessage, WasmWorkerResponse, WasmWorkerEvent } from '../workers/wasmWorker';
import { fetchWasmResource, transferWasmToWorker } from '../utils/wasmLoader';

// WASM module interface definition
export interface WasmModule {
	// Opening project (temporary project) methods
	wasm_create_empty_opening_project(project_name: string): number | null;
	wasm_create_opening_project_from_binary(data: Uint8Array, file_extension: string, project_name: string): number | null;
	wasm_create_opening_project_from_shared_buffer(file_extension: string, project_name: string): Promise<number | null>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_opening_project_info(project_id: number): any;
	wasm_flush_opening_project_images(project_id: number): boolean;
	wasm_finalize_opening_project(project_id: number): boolean;
	wasm_delete_opening_project(project_id: number): boolean;
	
	// Project methods
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_project_info(project_id: number): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_all_projects_info(): any;
	wasm_update_project_name(project_id: number, name: string): boolean;
	wasm_delete_project(project_id: number): boolean;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_project_images(project_id: number): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_project_images_metadata(project_id: number): any;
	wasm_add_image_from_binary_to_project(project_id: number, format_str: string, data: Uint8Array, name?: string | null): number | undefined;
	wasm_init_shared_buffer(buffer: SharedArrayBuffer): void;
	wasm_add_image_from_shared_buffer(project_id: number, name?: string | null): Promise<number>;
	wasm_cleanup_orphaned_images(): number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_image_info(image_id: number): any;
	wasm_update_image_info(image_id: number, name?: string | null): boolean;
	wasm_update_image_data_from_binary(image_id: number, format_str: string, data: Uint8Array): boolean;
	wasm_remove_image_from_project(project_id: number, image_id: number): boolean;
	wasm_reorder_project_images(project_id: number, image_ids: Uint32Array): boolean;
	wasm_get_image_binary_data(image_id: number): Uint8Array;
	wasm_get_image_mime_type(image_id: number): string | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_image_markers(image_id: number): any;
	// 点型marker
	wasm_add_point_marker_to_image(image_id: number, x: number, y: number, translation?: string | null): number | undefined;
	// 矩形型marker
	wasm_add_rectangle_marker_to_image(image_id: number, x: number, y: number, width: number, height: number, translation?: string | null): number | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_marker_info(marker_id: number): any;
	// 点型marker位置更新
	wasm_update_point_marker_position(marker_id: number, x: number, y: number): boolean;
	// 矩形型marker几何更新
	wasm_update_rectangle_marker_geometry(marker_id: number, x: number, y: number, width: number, height: number): boolean;
	wasm_update_marker_translation(marker_id: number, translation: string): boolean;
	wasm_update_marker_style(marker_id: number, overlay_text: boolean, horizontal: boolean): boolean;
	wasm_move_marker_order(marker_id: number, new_index: number): boolean;
	// 点型marker完整更新
	wasm_update_point_marker_full(marker_id: number, x: number, y: number, translation?: string | null): boolean;
	// 矩形型marker完整更新
	wasm_update_rectangle_marker_full(marker_id: number, x: number, y: number, width: number, height: number, translation?: string | null): boolean;
	wasm_remove_marker_from_image(image_id: number, marker_id: number): boolean;
	wasm_clear_image_markers(image_id: number): boolean;
	wasm_convert_rectangle_to_point_marker(marker_id: number): boolean;
	wasm_convert_point_to_rectangle_marker(marker_id: number): boolean;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_stats(): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_project_stats(project_id: number): any;
	wasm_clear_all_data(): void;
	wasm_clear_project_data(project_id: number): boolean;
	
	// 撤销重做相关方法
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_undo(project_id: number): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_redo(project_id: number): any;
	wasm_clear_undo_redo_history(project_id: number): void;
	wasm_clear_all_undo_redo_history(): void;
	
	// 缩略图相关方法
	wasm_request_thumbnail(image_id: number): string;
	wasm_request_thumbnails_batch(image_ids: Uint32Array): string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_get_thumbnail(image_id: number): any;
	wasm_has_thumbnail(image_id: number): boolean;
	
	// 事件系统方法
	wasm_init_event_system(): void;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_set_event_callback(callback: (eventName: string, eventData: any) => void): void;
	
	// SharedArrayBuffer support
	wasm_write_image_to_shared_buffer(image_id: number): Promise<void>;
	
	// wasm-bindgen-rayon 线程池初始化
	initThreadPool?(numThreads: number): Promise<void>;
	
	// LabelPlus文件相关方法
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_validate_labelplus_file(content: string): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_import_labelplus_data(project_id: number, content: string): any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	wasm_export_labelplus_data(project_id: number): any;
	wasm_update_project_file_path(project_id: number, file_path: string | null): boolean;
}

// 辅助函数：将 ImageFormat 转换为字符串（用于后端API）
function imageFormatToString(format: ImageFormat): string {
	switch (format) {
		case 'Jpeg': return 'jpeg';
		case 'Png': return 'png';
		case 'Gif': return 'gif';
		case 'Webp': return 'webp';
		case 'Bmp': return 'bmp';
		default: return 'png';
	}
}

// 项目接口
export interface ProjectAPI {
	// Opening project (temporary project) methods
	createEmptyOpeningProject(projectName: string): Promise<number | null>;
	createOpeningProjectFromBinary(data: Uint8Array, fileExtension: string, projectName: string): Promise<number | null>;
	createOpeningProjectFromPath(path: string, projectName: string): Promise<number | null>;
	getOpeningProjectInfo(projectId: number): Promise<OpeningProjectInfo | null>;
	flushOpeningProjectImages(projectId: number): Promise<boolean>;
	finalizeOpeningProject(projectId: number): Promise<boolean>;
	deleteOpeningProject(projectId: number): Promise<boolean>;
	
	// Regular project methods
	getProjectInfo(projectId: number): Promise<TranslationProject | null>;
	getAllProjectsInfo(): Promise<TranslationProject[]>;
	updateProjectName(projectId: number, name: string): Promise<boolean>;
	updateProjectLanguages(projectId: number, sourceLanguage: Language, targetLanguage: Language): Promise<boolean>;
	deleteProject(projectId: number): Promise<boolean>;
	getProjectImages(projectId: number): Promise<ImageMetadata[]>;
	getProjectImagesMetadata(projectId: number): Promise<ImageMetadata[]>;
}

// 图片接口
export interface ImageAPI {
	addImageFromBinary(
		projectId: number,
		format: ImageFormat,
		data: Uint8Array,
		name?: string
	): Promise<number | null>;
	addImageFromPath(projectId: number, path: string): Promise<number | null>;
	getImageInfo(imageId: number): Promise<ImageMetadata | null>;
	getImageBinaryData(imageId: number): Promise<Uint8Array | null>;
	getImageMimeType(imageId: number): Promise<string | null>;
	getImageFilePath(imageId: number): Promise<string | null>;
	updateImageInfo(imageId: number, name?: string): Promise<boolean>;
	updateImageDataFromBinary(imageId: number, format: ImageFormat, data: Uint8Array): Promise<boolean>;
	removeImageFromProject(projectId: number, imageId: number): Promise<boolean>;
	reorderProjectImages(projectId: number, imageIds: number[]): Promise<boolean>;
	getImageMarkers(imageId: number): Promise<Marker[]>;
}

// 标记接口
export interface MarkerAPI {
	// 点型marker
	addPointMarkerToImage(
		imageId: number,
		x: number,
		y: number,
		translation?: string
	): Promise<number | null>;
	updatePointMarkerPosition(markerId: number, x: number, y: number): Promise<boolean>;
	updatePointMarkerFull(markerId: number, x: number, y: number, translation?: string): Promise<boolean>;
	
	// 矩形型marker
	addRectangleMarkerToImage(
		imageId: number,
		x: number,
		y: number,
		width: number,
		height: number,
		translation?: string
	): Promise<number | null>;
	updateRectangleMarkerGeometry(markerId: number, x: number, y: number, width: number, height: number): Promise<boolean>;
	updateRectangleMarkerFull(markerId: number, x: number, y: number, width: number, height: number, translation?: string): Promise<boolean>;
	
	// 通用接口
	getMarkerInfo(markerId: number): Promise<Marker | null>;
	updateMarkerTranslation(markerId: number, translation: string): Promise<boolean>;
	updateMarkerStyle(
		markerId: number,
		overlayText: boolean,
		horizontal: boolean
	): Promise<boolean>;
	moveMarkerOrder(markerId: number, newIndex: number): Promise<boolean>;
	removeMarkerFromImage(imageId: number, markerId: number): Promise<boolean>;
	clearImageMarkers(imageId: number): Promise<boolean>;
	convertRectangleToPointMarker(markerId: number): Promise<boolean>;
	convertPointToRectangleMarker(markerId: number): Promise<boolean>;
}

// 统计和清理接口
export interface UtilityAPI {
	getStats(): Promise<unknown>;
	getProjectStats(projectId: number): Promise<unknown>;
	clearAllData(): Promise<void>;
	clearProjectData(projectId: number): Promise<boolean>;
	cleanupOrphanedImages(): Promise<number>;
}

// 缩略图接口（仅Worker适配器支持）
export interface ThumbnailAPI {
	requestThumbnail(imageId: number): Promise<string>;
	getThumbnail(imageId: number): Promise<unknown>;
	hasThumbnail(imageId: number): Promise<boolean>;
}

// 撤销重做接口
export interface UndoRedoAPI {
	undo(projectId: number): Promise<UndoRedoResult>;
	redo(projectId: number): Promise<UndoRedoResult>;
	clearUndoRedoHistory(projectId: number): Promise<void>;
	clearAllUndoRedoHistory(): Promise<void>;
}

// LabelPlus文件接口
export interface LabelplusFileAPI {
	validateLabelplusFile(content: string): Promise<{ error?: string; data?: unknown }>;
	importLabelplusData(projectId: number, content: string): Promise<{ error?: string }>;
	exportLabelplusData(projectId: number): Promise<{ content?: string; error?: string }>;
	saveProject(projectId: number): Promise<{ data?: number[]; error?: string }>;
	updateProjectFilePath(projectId: number, filePath: string | null): Promise<boolean>;
}

// Bunny (海兔) API 接口
export interface BunnyAPI {
	requestOCR(markerId: number, ocrModel: string): Promise<string>;
	requestTranslation(markerId: number, service: string, sourceLang?: string, targetLang?: string): Promise<string>;
	cancelBunnyTask(taskId: string): Promise<boolean>;
	clearAllBunnyTasks(): Promise<boolean>;
	getBunnyTaskStatus(taskId: string): Promise<unknown | null>;
	getBunnyQueuedTasks(projectId?: number): Promise<unknown[]>;
	getOCRResult(markerId: number): Promise<string | null>;
	getTranslationResult(markerId: number): Promise<string | null>;
	getAvailableOCRServices(): Promise<OCRServiceInfo[]>;
	getAvailableTranslationServices(): Promise<TranslationServiceInfo[]>;
	registerOCRService(serviceInfo: OCRServiceInfo): Promise<void>;
	registerTranslationService(serviceInfo: TranslationServiceInfo): Promise<void>;
	unregisterBunnyService(serviceId: string): Promise<void>;
}

// Service info types for plugin-provided services
export interface OCRServiceInfo {
	id: string;
	name: string;
	plugin_id: string;
	supported_languages: string[];
	supported_image_formats: string[];
}

export interface TranslationServiceInfo {
	id: string;
	name: string;
	plugin_id: string;
	source_languages: string[];
	target_languages: string[];
	supports_auto_detect: boolean;
}

// 综合API接口
export interface CoreAPI extends ProjectAPI, ImageAPI, MarkerAPI, UtilityAPI, UndoRedoAPI, LabelplusFileAPI, BunnyAPI {}

// 定义后端调用的参数类型
interface BackendCallParams {
	[key: string]: unknown;
}

// Base implementation with shared logic
abstract class BaseCoreAPI implements CoreAPI {
	// 抽象方法：子类需要实现具体的后端调用逻辑
	protected abstract callBackend<T>(method: string, params?: BackendCallParams): Promise<T>;

	// 处理图片元数据的通用方法
	protected processImageMetadata(rawImages: unknown[]): ImageMetadata[] {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return rawImages.map((rawImage: any) => {
			let format: ImageFormat | undefined;
			let width: number | undefined;
			let height: number | undefined;

			// 从数据中提取格式信息
			if (rawImage.data?.Binary) {
				const rustFormat = rawImage.data.Binary.format;
				format =
					rustFormat === 'Jpeg'
						? 'Jpeg'
						: rustFormat === 'Png'
							? 'Png'
							: rustFormat === 'Webp'
								? 'Webp'
								: rustFormat === 'Gif'
									? 'Gif'
									: rustFormat === 'Bmp'
										? 'Bmp'
										: undefined;
			} else if (rawImage.data?.FilePath) {
				// 从文件扩展名推导格式
				const ext = rawImage.data.FilePath.split('.').pop()?.toLowerCase();
				format =
					ext === 'jpg' || ext === 'jpeg'
						? 'Jpeg'
						: ext === 'png'
							? 'Png'
							: ext === 'webp'
								? 'Webp'
								: ext === 'gif'
									? 'Gif'
									: ext === 'bmp'
										? 'Bmp'
										: undefined;
			}

			// 提取尺寸信息
			if (rawImage.dimensions) {
				[width, height] = rawImage.dimensions;
			}

			return {
				id: rawImage.id,
				name: rawImage.name,
				width,
				height,
				format,
				size: rawImage.size,
				markers: [] // 标记会单独加载
			};
		});
	}

	// Opening project (临时项目) 相关
	async createEmptyOpeningProject(projectName: string): Promise<number | null> {
		const result = await this.callBackend<number | null>('create_empty_opening_project', { 
			projectName: projectName.trim()
		});
		return result;
	}
	
	// Unified API implementations
	async createOpeningProjectFromBinary(data: Uint8Array, fileExtension: string, projectName: string): Promise<number | null> {
		return this.callBackend<number | null>('create_opening_project_from_binary', {
			data: Array.from(data),
			fileExtension,
			projectName: projectName.trim()
		});
	}
	
	async createOpeningProjectFromPath(path: string, projectName: string): Promise<number | null> {
		return this.callBackend<number | null>('create_opening_project_from_path', {
			path,
			projectName: projectName.trim()
		});
	}

	async getOpeningProjectInfo(projectId: number): Promise<OpeningProjectInfo | null> {
		return this.callBackend<OpeningProjectInfo | null>('get_opening_project_info', { projectId });
	}

	async flushOpeningProjectImages(projectId: number): Promise<boolean> {
		return this.callBackend<boolean>('flush_opening_project_images', { projectId });
	}

	async finalizeOpeningProject(projectId: number): Promise<boolean> {
		return this.callBackend<boolean>('finalize_opening_project', { projectId });
	}

	async deleteOpeningProject(projectId: number): Promise<boolean> {
		return this.callBackend<boolean>('delete_opening_project', { projectId });
	}

	// 正式项目相关

	async getProjectInfo(projectId: number): Promise<TranslationProject | null> {
		return this.callBackend<TranslationProject | null>('get_project_info', { projectId });
	}

	async getAllProjectsInfo(): Promise<TranslationProject[]> {
		return this.callBackend<TranslationProject[]>('get_all_projects_info');
	}

	async updateProjectName(projectId: number, name: string): Promise<boolean> {
		return this.callBackend<boolean>('update_project_name', { projectId, name });
	}

	async updateProjectLanguages(projectId: number, sourceLanguage: Language, targetLanguage: Language): Promise<boolean> {
		return this.callBackend<boolean>('update_project_languages', { projectId, sourceLanguage, targetLanguage });
	}

	async deleteProject(projectId: number): Promise<boolean> {
		return this.callBackend<boolean>('delete_project', { projectId });
	}

	async getProjectImages(projectId: number): Promise<ImageMetadata[]> {
		const rawImages = await this.callBackend<unknown[]>('get_project_images', { projectId });
		return this.processImageMetadata(rawImages);
	}

	async getProjectImagesMetadata(projectId: number): Promise<ImageMetadata[]> {
		return this.callBackend<ImageMetadata[]>('get_project_images_metadata', { projectId });
	}

	// 图片相关

	async addImageFromBinary(
		projectId: number,
		format: ImageFormat,
		data: Uint8Array,
		name?: string
	): Promise<number | null> {
		return this.callBackend<number | null>('add_image_from_binary_to_project', {
			projectId,
			formatStr: imageFormatToString(format),
			data: Array.from(data),
			name
		});
	}

	async addImageFromPath(projectId: number, path: string): Promise<number | null> {
		// 默认实现，子类可以覆盖
		return this.callBackend<number | null>('add_image_from_path_to_project', {
			projectId,
			path
		});
	}

	async getImageInfo(imageId: number): Promise<ImageMetadata | null> {
		return this.callBackend<ImageMetadata | null>('get_image_info', { imageId });
	}

	async getImageBinaryData(imageId: number): Promise<Uint8Array | null> {
		try {
			const data = await this.callBackend<number[] | null>('get_image_binary_data', { imageId });
			return data ? new Uint8Array(data) : null;
		} catch (error) {
			console.error('Failed to get image binary data:', error);
			return null;
		}
	}

	async getImageMimeType(imageId: number): Promise<string | null> {
		try {
			return await this.callBackend<string | null>('get_image_mime_type', { imageId });
		} catch (error) {
			console.error('Failed to get image MIME type:', error);
			return null;
		}
	}

	async getImageFilePath(imageId: number): Promise<string | null> {
		// 默认实现，子类可以覆盖
		try {
			return await this.callBackend<string | null>('get_image_file_path', { imageId });
		} catch (error) {
			console.error('Failed to get image file path:', error);
			return null;
		}
	}

	async updateImageInfo(imageId: number, name?: string): Promise<boolean> {
		return this.callBackend<boolean>('update_image_info', { imageId, name });
	}

	async updateImageDataFromBinary(
		imageId: number,
		format: ImageFormat,
		data: Uint8Array
	): Promise<boolean> {
		return this.callBackend<boolean>('update_image_data_from_binary', {
			imageId,
			formatStr: imageFormatToString(format),
			data: Array.from(data)
		});
	}

	async removeImageFromProject(projectId: number, imageId: number): Promise<boolean> {
		return this.callBackend<boolean>('remove_image_from_project', { projectId, imageId });
	}

	async reorderProjectImages(projectId: number, imageIds: number[]): Promise<boolean> {
		return this.callBackend<boolean>('reorder_project_images', { projectId, imageIds });
	}

	async getImageMarkers(imageId: number): Promise<Marker[]> {
		return this.callBackend<Marker[]>('get_image_markers', { imageId });
	}

	// 点型marker
	async addPointMarkerToImage(
		imageId: number,
		x: number,
		y: number,
		translation?: string
	): Promise<number | null> {
		return this.callBackend<number | null>('add_point_marker_to_image', { imageId, x, y, translation });
	}

	async getMarkerInfo(markerId: number): Promise<Marker | null> {
		return this.callBackend<Marker | null>('get_marker_info', { markerId });
	}

	async updatePointMarkerPosition(markerId: number, x: number, y: number): Promise<boolean> {
		return this.callBackend<boolean>('update_point_marker_position', { markerId, x, y });
	}

	async updateMarkerTranslation(markerId: number, translation: string): Promise<boolean> {
		return this.callBackend<boolean>('update_marker_translation', { markerId, translation });
	}

	async updateMarkerStyle(
		markerId: number,
		overlayText: boolean,
		horizontal: boolean
	): Promise<boolean> {
		return this.callBackend<boolean>('update_marker_style', {
			markerId,
			overlayText,
			horizontal
		});
	}

	async moveMarkerOrder(markerId: number, newIndex: number): Promise<boolean> {
		return this.callBackend<boolean>('move_marker_order', { markerId, newIndex });
	}

	async updatePointMarkerFull(
		markerId: number,
		x: number,
		y: number,
		translation?: string
	): Promise<boolean> {
		return this.callBackend<boolean>('update_point_marker_full', { markerId, x, y, translation });
	}

	// 矩形型marker
	async addRectangleMarkerToImage(
		imageId: number,
		x: number,
		y: number,
		width: number,
		height: number,
		translation?: string
	): Promise<number | null> {
		return this.callBackend<number | null>('add_rectangle_marker_to_image', { imageId, x, y, width, height, translation });
	}

	async updateRectangleMarkerGeometry(
		markerId: number,
		x: number,
		y: number,
		width: number,
		height: number
	): Promise<boolean> {
		return this.callBackend<boolean>('update_rectangle_marker_geometry', { markerId, x, y, width, height });
	}

	async updateRectangleMarkerFull(
		markerId: number,
		x: number,
		y: number,
		width: number,
		height: number,
		translation?: string
	): Promise<boolean> {
		return this.callBackend<boolean>('update_rectangle_marker_full', { markerId, x, y, width, height, translation });
	}

	async removeMarkerFromImage(imageId: number, markerId: number): Promise<boolean> {
		return this.callBackend<boolean>('remove_marker_from_image', { imageId, markerId });
	}

	async clearImageMarkers(imageId: number): Promise<boolean> {
		return this.callBackend<boolean>('clear_image_markers', { imageId });
	}

	async convertRectangleToPointMarker(markerId: number): Promise<boolean> {
		return this.callBackend<boolean>('convert_rectangle_to_point_marker', { markerId });
	}

	async convertPointToRectangleMarker(markerId: number): Promise<boolean> {
		return this.callBackend<boolean>('convert_point_to_rectangle_marker', { markerId });
	}

	// 统计和清理相关
	async getStats(): Promise<unknown> {
		return this.callBackend<unknown>('get_stats');
	}

	async getProjectStats(projectId: number): Promise<unknown> {
		return this.callBackend<unknown>('get_project_stats', { projectId });
	}

	async clearAllData(): Promise<void> {
		await this.callBackend<void>('clear_all_data');
	}

	async clearProjectData(projectId: number): Promise<boolean> {
		return this.callBackend<boolean>('clear_project_data', { projectId });
	}

	async cleanupOrphanedImages(): Promise<number> {
		// 默认实现，子类可以覆盖
		console.warn('cleanupOrphanedImages not implemented for this environment');
		return 0;
	}
	
	// 撤销重做相关
	async undo(projectId: number): Promise<UndoRedoResult> {
		return this.callBackend<UndoRedoResult>('undo', { projectId });
	}
	
	async redo(projectId: number): Promise<UndoRedoResult> {
		return this.callBackend<UndoRedoResult>('redo', { projectId });
	}
	
	async clearUndoRedoHistory(projectId: number): Promise<void> {
		await this.callBackend<void>('clear_undo_redo_history', { projectId });
	}
	
	async clearAllUndoRedoHistory(): Promise<void> {
		await this.callBackend<void>('clear_all_undo_redo_history');
	}
	
	// LabelPlus文件相关
	async validateLabelplusFile(content: string): Promise<{ error?: string; data?: unknown }> {
		const result = await this.callBackend<unknown>('validate_labelplus_file', { content });
		const res = result as { error?: string } | unknown;
		if (typeof res === 'object' && res && 'error' in res && res.error) {
			return { error: res.error as string };
		}
		return { data: result };
	}
	
	async importLabelplusData(projectId: number, content: string): Promise<{ error?: string }> {
		const result = await this.callBackend<unknown>('import_labelplus_data', { projectId, content });
		// WASM returns 'ok' on success, Tauri returns null/undefined
		if (result === 'ok' || result === null || result === undefined) {
			return {};
		}
		const res = result as { error?: string };
		return { error: res?.error || 'Import failed' };
	}

	async exportLabelplusData(projectId: number): Promise<{ content?: string; error?: string }> {
		const result = await this.callBackend<unknown>('export_labelplus_data', { projectId });
		if (typeof result === 'string' && !result.startsWith('{')) {
			// If result is a plain string, it's the content
			return { content: result };
		}
		const res = result as { error?: string } | string;
		if (typeof res === 'object' && res.error) {
			return { error: res.error };
		}
		return { content: res as string };
	}

	async saveProject(projectId: number): Promise<{ data?: number[]; error?: string }> {
		const result = await this.callBackend<unknown>('save_project', { projectId });
		const res = result as { error?: string } | Uint8Array | number[];
		if (typeof res === 'object' && 'error' in res && res.error) {
			return { error: res.error };
		}
		// Check if result is Uint8Array (from WASM) or array (from Tauri)
		if (result instanceof Uint8Array) {
			return { data: Array.from(result) };
		}
		if (Array.isArray(result)) {
			return { data: result };
		}
		return { error: 'Invalid response format' };
	}

	async updateProjectFilePath(projectId: number, filePath: string | null): Promise<boolean> {
		return this.callBackend<boolean>('update_project_file_path', { projectId, filePath });
	}

	// Bunny (海兔) API implementation
	async requestOCR(markerId: number, ocrModel: string): Promise<string> {
		return this.callBackend<string>('request_ocr', { markerId, ocrModel });
	}

	async requestTranslation(markerId: number, service: string, sourceLang?: string, targetLang?: string): Promise<string> {
		return this.callBackend<string>('request_translation', { 
			markerId, 
			serviceName: service, 
			sourceLang, 
			targetLang: targetLang || 'zh-CN' 
		});
	}

	async cancelBunnyTask(taskId: string): Promise<boolean> {
		return this.callBackend<boolean>('cancel_bunny_task', { taskId });
	}

	async clearAllBunnyTasks(): Promise<boolean> {
		return this.callBackend<boolean>('clear_all_bunny_tasks', {});
	}

	async getBunnyTaskStatus(taskId: string): Promise<unknown | null> {
		return this.callBackend<unknown | null>('get_bunny_task_status', { taskId });
	}

	async getBunnyQueuedTasks(projectId?: number): Promise<unknown[]> {
		return this.callBackend<unknown[]>('get_bunny_queued_tasks', { projectId });
	}

	async getOCRResult(markerId: number): Promise<string | null> {
		return this.callBackend<string | null>('get_ocr_result', { markerId });
	}

	async getTranslationResult(markerId: number): Promise<string | null> {
		return this.callBackend<string | null>('get_translation_result', { markerId });
	}

	async getAvailableOCRServices(): Promise<OCRServiceInfo[]> {
		return this.callBackend<OCRServiceInfo[]>('get_available_ocr_services', {});
	}

	async getAvailableTranslationServices(): Promise<TranslationServiceInfo[]> {
		return this.callBackend<TranslationServiceInfo[]>('get_available_translation_services', {});
	}

	async registerOCRService(serviceInfo: OCRServiceInfo): Promise<void> {
		await this.callBackend<void>('register_ocr_service', { serviceInfo });
	}

	async registerTranslationService(serviceInfo: TranslationServiceInfo): Promise<void> {
		await this.callBackend<void>('register_translation_service', { serviceInfo });
	}

	async unregisterBunnyService(serviceId: string): Promise<void> {
		await this.callBackend<void>('unregister_bunny_service', { serviceId });
	}
}

// Tauri implementation
class TauriCoreAPI extends BaseCoreAPI {
	protected async callBackend<T>(method: string, params?: BackendCallParams): Promise<T> {
		const { invoke } = await import('@tauri-apps/api/core');
		return await invoke<T>(`tauri_${method}`, params || {});
	}

	async reorderProjectImages(projectId: number, imageIds: number[]): Promise<boolean> {
		// Tauri需要直接传递数组，不需要转换为Uint32Array
		return this.callBackend<boolean>('reorder_project_images', { projectId, imageIds });
	}

	async cleanupOrphanedImages(): Promise<number> {
		// Tauri版本中，图片数据由后端管理，不需要清理IndexedDB
		console.warn('cleanupOrphanedImages not implemented for Tauri environment');
		return 0;
	}
}

// WASM implementation
class WasmCoreAPI extends BaseCoreAPI {
	private wasmModule: WasmModule | null = null;

	private async initWasm(): Promise<WasmModule> {
		if (this.wasmModule) {
			return this.wasmModule;
		}

		if (!browser) {
			throw new Error('WASM can only be initialized in browser environment');
		}

		try {
			// 从lib目录导入WASM模块
			const module = await import('../wasm-pkg/bubblefish_core.js');

			// 使用URL import导入WASM二进制文件
			const wasmUrl = new URL('../wasm-pkg/bubblefish_core_bg.wasm', import.meta.url);

			// 使用新格式调用初始化函数，并设置内存配置
			// WebAssembly.Memory允许动态增长，初始64MB，最大4GB
			const memory = new WebAssembly.Memory({
				initial: 1024, // 64MB (1024 * 64KB pages)
				maximum: 65536, // 4GB (65536 * 64KB pages)
				shared: true // 支持多线程共享内存
			});
			
			await module.default({ 
				module_or_path: wasmUrl,
				memory: memory
			});

			// 检查是否支持 SharedArrayBuffer（WASM 线程所需）
			if (typeof SharedArrayBuffer === 'undefined') {
				console.warn('SharedArrayBuffer is not available. WASM threading requires Cross-Origin Isolation.');
				console.warn('Make sure the server sends these headers:');
				console.warn('- Cross-Origin-Opener-Policy: same-origin');
				console.warn('- Cross-Origin-Embedder-Policy: require-corp');
			}

			// 初始化wasm-bindgen-rayon线程池
			try {
				if (module.initThreadPool) {
					const numThreads = navigator.hardwareConcurrency || 4;
					console.log(`Initializing WASM thread pool with ${numThreads} threads`);
					await module.initThreadPool(numThreads);
					console.log('WASM thread pool initialized successfully');
				} else {
					console.warn('initThreadPool not available - multithreading disabled');
				}
			} catch (error) {
				console.warn('Failed to initialize WASM thread pool:', error);
				console.warn('This is likely due to missing Cross-Origin Isolation headers');
				console.warn('Continuing without multithreading support');
			}

			this.wasmModule = module as unknown as WasmModule;

			// 初始化WASM的事件系统
			if (module.wasm_init_event_system) {
				module.wasm_init_event_system();
			}

			return this.wasmModule;
		} catch (error) {
			console.error('Failed to initialize WASM module:', error);
			throw error;
		}
	}

	protected async callBackend<T>(method: string, params?: BackendCallParams): Promise<T> {
		try {
			const wasm = await this.initWasm();
			const wasmMethod = `wasm_${method}`;
			
			// 根据参数数量调用相应的WASM方法
			type WasmFunc = (...args: unknown[]) => unknown;
			const fn = wasm as unknown as Record<string, WasmFunc>;
			if (!params || Object.keys(params).length === 0) {
				return fn[wasmMethod]() as T;
			} else if (Object.keys(params).length === 1) {
				const value = Object.values(params)[0];
				return fn[wasmMethod](value) as T;
			} else {
				// 对于多参数，按照特定顺序传递
				return this.callWasmMethodWithParams(wasm, wasmMethod, params) as T;
			}
		} catch (error) {
			console.error(`WASM ${method} failed:`, error);
			// 根据返回类型返回默认值
			if (method.includes('get_all') || method.includes('get_image_markers')) {
				return [] as T;
			}
			if (method.includes('create') || method.includes('add')) {
				return null as T;
			}
			if (method.includes('update') || method.includes('delete') || method.includes('remove') || method.includes('clear')) {
				return false as T;
			}
			return null as T;
		}
	}

	private callWasmMethodWithParams(wasm: WasmModule, method: string, params: BackendCallParams): unknown {
		type WasmFunc = (...args: unknown[]) => unknown;
		const fn = wasm as unknown as Record<string, WasmFunc>;
		// 处理特殊的多参数方法
		switch (method) {
			case 'wasm_add_image_from_binary_to_project': {
				const data = params.data as number[];
				return fn[method](params.projectId, params.formatStr, new Uint8Array(data), params.name) ?? null;
			}
			case 'wasm_update_image_data_from_binary': {
				const data = params.data as number[];
				return fn[method](params.imageId, params.formatStr, new Uint8Array(data));
			}
			case 'wasm_add_point_marker_to_image':
				return fn[method](params.imageId, params.x, params.y, params.translation) ?? null;
			case 'wasm_add_rectangle_marker_to_image':
				return fn[method](params.imageId, params.x, params.y, params.width, params.height, params.translation) ?? null;
			case 'wasm_update_point_marker_position':
				return fn[method](params.markerId, params.x, params.y);
			case 'wasm_update_rectangle_marker_geometry':
				return fn[method](params.markerId, params.x, params.y, params.width, params.height);
			case 'wasm_update_marker_style':
				return fn[method](params.markerId, params.overlayText, params.horizontal);
			case 'wasm_move_marker_order':
				return fn[method](params.markerId, params.newIndex);
			case 'wasm_update_point_marker_full':
				return fn[method](params.markerId, params.x, params.y, params.translation);
			case 'wasm_update_rectangle_marker_full':
				return fn[method](params.markerId, params.x, params.y, params.width, params.height, params.translation);
			case 'wasm_reorder_project_images': {
				const imageIds = params.imageIds as number[];
				return fn[method](params.projectId, new Uint32Array(imageIds));
			}
			case 'wasm_validate_labelplus_file':
				return fn[method](params.content);
			case 'wasm_import_labelplus_data':
				return fn[method](params.projectId, params.content);
			case 'wasm_export_labelplus_data':
				return fn[method](params.projectId);
			default: {
				// 对于其他双参数方法，使用通用处理
				const values = Object.values(params);
				return fn[method](...values);
			}
		}
	}

	// 覆盖二进制方法，直接调用WASM
	async createOpeningProjectFromBinary(data: Uint8Array, fileExtension: string, projectName: string): Promise<number | null> {
		try {
			const wasm = await this.initWasm();
			return wasm.wasm_create_opening_project_from_binary(data, fileExtension, projectName.trim()) ?? null;
		} catch (error) {
			console.error('Failed to create opening project from binary:', error);
			return null;
		}
	}
	
	// WASM不支持路径访问
	async createOpeningProjectFromPath(): Promise<number | null> {
		console.warn('WasmCoreAPI: Path-based access not supported in WASM environment');
		return null;
	}
	
	async addImageFromPath(): Promise<number | null> {
		// WASM版本不支持文件路径访问
		console.warn('addImageFromPath not supported in WASM environment');
		return null;
	}

	async getImageFilePath(): Promise<string | null> {
		// WASM版本不支持文件路径访问
		return null;
	}

	async cleanupOrphanedImages(): Promise<number> {
		try {
			const wasm = await this.initWasm();
			return wasm.wasm_cleanup_orphaned_images();
		} catch (error) {
			console.error('WASM cleanup orphaned images failed:', error);
			return 0;
		}
	}
}

// WASM Worker implementation - 在主线程中代理Worker调用
class WasmWorkerAdapter extends BaseCoreAPI implements ThumbnailAPI {
	private worker: Worker | null = null;
	private requestId = 0;
	private pendingRequests = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	private initPromise: Promise<void> | null = null;

	private async ensureWorkerReady(): Promise<Worker> {
		if (!this.worker) {
			// 创建Worker
			this.worker = new Worker(
				new URL('../workers/wasmWorker.ts', import.meta.url),
				{ type: 'module' }
			);

			// 在主线程获取WASM资源并传输到Worker
			const wasmUrl = new URL('../wasm-pkg/bubblefish_core_bg.wasm', import.meta.url);
			const wasmBytes = await fetchWasmResource(wasmUrl);
			transferWasmToWorker(this.worker, wasmBytes, 'INIT_WITH_WASM');

			// 设置消息处理
			this.worker.onmessage = (event: MessageEvent) => {
				const data = event.data;

				// 处理事件消息
				if (data.type === 'event') {
					this.handleWorkerEvent(data as WasmWorkerEvent);
					return;
				}

				// 处理方法调用响应
				const response = data as WasmWorkerResponse;
				const pending = this.pendingRequests.get(response.id);
				if (pending) {
					this.pendingRequests.delete(response.id);
					if (response.success) {
						pending.resolve(response.result);
					} else {
						pending.reject(new Error(response.error || 'Unknown worker error'));
					}
				}
			};

			// 设置错误处理
			this.worker.onerror = (error) => {
				console.error('WASM Worker error:', error);
				// 拒绝所有pending的请求
				for (const [id, pending] of this.pendingRequests.entries()) {
					pending.reject(new Error('Worker error'));
					this.pendingRequests.delete(id);
				}
			};

			// 初始化WASM模块
			this.initPromise = this.callWorkerMethod('__init__').then(() => {
				console.log('WASM Worker initialized successfully');
			});
		}

		// 等待初始化完成
		if (this.initPromise) {
			await this.initPromise;
		}

		return this.worker;
	}

	private handleWorkerEvent(event: WasmWorkerEvent) {
		try {
			if (event.eventType === 'log') {
				// 转发日志事件
				eventSystem.handleLogEvent(event.data as LogEvent);
			} else if (event.eventType === 'business' && event.eventName) {
				// 转发业务事件
				eventSystem.emitBusinessEvent(event.eventName, event.data);
			}
		} catch (error) {
			console.error('Failed to handle worker event:', error);
		}
	}

	private async callWorkerMethod<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		const worker = await this.ensureWorkerReady();
		const id = ++this.requestId;

		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Worker method '${method}' timeout`));
			}, 30000); // 30秒超时

			this.pendingRequests.set(id, {
				resolve: (result: unknown) => {
					clearTimeout(timeoutId);
					resolve(result as T);
				},
				reject: (error: Error) => {
					clearTimeout(timeoutId);
					reject(error);
				}
			});

			const message: WasmWorkerMessage = { id, method, args };
			worker.postMessage(message);
		});
	}

	protected async callBackend<T>(method: string, params?: BackendCallParams): Promise<T> {
		try {
			const wasmMethod = `wasm_${method}`;
			
			// 根据参数数量调用相应的Worker方法
			if (!params || Object.keys(params).length === 0) {
				return await this.callWorkerMethod<T>(wasmMethod);
			} else if (Object.keys(params).length === 1) {
				const value = Object.values(params)[0];
				return await this.callWorkerMethod<T>(wasmMethod, value);
			} else {
				// 对于多参数，按照特定顺序传递
				return await this.callWorkerMethodWithParams<T>(wasmMethod, params);
			}
		} catch (error) {
			console.error(`WASM Worker ${method} failed:`, error);
			// 根据返回类型返回默认值
			if (method.includes('get_all') || method.includes('get_image_markers')) {
				return [] as T;
			}
			if (method.includes('create') || method.includes('add')) {
				return null as T;
			}
			if (method.includes('update') || method.includes('delete') || method.includes('remove') || method.includes('clear')) {
				return false as T;
			}
			return null as T;
		}
	}

	private async callWorkerMethodWithParams<T>(method: string, params: BackendCallParams): Promise<T> {
		// 处理特殊的多参数方法
		switch (method) {
			case 'wasm_add_image_from_binary_to_project':
				return await this.callWorkerMethod<T>(method, params.projectId, params.formatStr, params.data, params.name);
			case 'wasm_update_image_data_from_binary':
				return await this.callWorkerMethod<T>(method, params.imageId, params.formatStr, params.data);
			case 'wasm_add_point_marker_to_image':
				return await this.callWorkerMethod<T>(method, params.imageId, params.x, params.y, params.translation);
			case 'wasm_add_rectangle_marker_to_image':
				return await this.callWorkerMethod<T>(method, params.imageId, params.x, params.y, params.width, params.height, params.translation);
			case 'wasm_update_point_marker_position':
				return await this.callWorkerMethod<T>(method, params.markerId, params.x, params.y);
			case 'wasm_update_rectangle_marker_geometry':
				return await this.callWorkerMethod<T>(method, params.markerId, params.x, params.y, params.width, params.height);
			case 'wasm_update_marker_style':
				return await this.callWorkerMethod<T>(method, params.markerId, params.overlayText, params.horizontal);
			case 'wasm_move_marker_order':
				return await this.callWorkerMethod<T>(method, params.markerId, params.newIndex);
			case 'wasm_update_point_marker_full':
				return await this.callWorkerMethod<T>(method, params.markerId, params.x, params.y, params.translation);
			case 'wasm_update_rectangle_marker_full':
				return await this.callWorkerMethod<T>(method, params.markerId, params.x, params.y, params.width, params.height, params.translation);
			case 'wasm_reorder_project_images':
				return await this.callWorkerMethod<T>(method, params.projectId, params.imageIds);
			default: {
				// 对于其他双参数方法，使用通用处理
				const values = Object.values(params);
				return await this.callWorkerMethod<T>(method, ...values);
			}
		}
	}

	// 覆盖二进制方法，使用SharedArrayBuffer优化大文件传输
	async createOpeningProjectFromBinary(data: Uint8Array, fileExtension: string, projectName: string): Promise<number | null> {
		try {
			// 小文件直接传输，大文件使用SharedArrayBuffer
			if (data.length < 1024 * 1024) { // < 1MB
				return await this.callWorkerMethod<number | null>(
					'wasm_create_opening_project_from_binary',
					data,
					fileExtension,
					projectName.trim()
				);
			}
			
			// 大文件使用SharedArrayBuffer
			const { getOrCreateStream, ImageFormatEnum } = await import('./streaming/imageStream');
			
			const minBufferSize = data.length + (1024 * 1024);
			const stream = getOrCreateStream(minBufferSize);
			const tempId = Date.now() + Math.floor(Math.random() * 1000);
			
			await this.callWorkerMethod('wasm_init_shared_buffer', stream.getSharedArrayBuffer());
			
			// Determine format enum for SharedArrayBuffer
			const formatEnum = fileExtension.toLowerCase() === 'bf' ? ImageFormatEnum.BF : ImageFormatEnum.LABELPLUS;
			const writePromise = stream.writeImageData(tempId, formatEnum, data);
			
			const [, result] = await Promise.all([
				writePromise,
				this.callWorkerMethod<number | null>(
					'wasm_create_opening_project_from_shared_buffer',
					fileExtension,
					projectName.trim()
				)
			]);
			
			return result ?? null;
		} catch (error) {
			console.error('Failed to create opening project from binary:', error);
			return null;
		}
	}
	
	// Worker也不支持路径访问
	async createOpeningProjectFromPath(): Promise<number | null> {
		console.warn('WasmWorkerAdapter: Path-based access not supported');
		return null;
	}
	
	async addImageFromBinary(
		projectId: number,
		format: ImageFormat,
		data: Uint8Array,
		name?: string
	): Promise<number | null> {
		try {
			// Use SharedArrayBuffer streaming for large images
			const { getOrCreateStream } = await import('./streaming/imageStream');
			
			// For large images, ensure we have a big enough buffer
			const minBufferSize = data.length + (1024 * 1024); // image size + 1MB overhead
			const stream = getOrCreateStream(minBufferSize);
			
			// Convert format to enum
			const formatEnum = this.imageFormatToEnum(format);
			
			// Generate temporary image ID
			const tempImageId = Date.now() + Math.floor(Math.random() * 1000);
			
			// Initialize shared buffer on WASM side
			await this.callWorkerMethod('wasm_init_shared_buffer', stream.getSharedArrayBuffer());
			
			// Start streaming data
			const writePromise = stream.writeImageData(tempImageId, formatEnum, data);
			
			// Call WASM to read from shared buffer
			const [, result] = await Promise.all([
				writePromise,
				this.callWorkerMethod<number | null>(
					'wasm_add_image_from_shared_buffer',
					projectId,
					name
				)
			]);

			return result ?? null;
		} catch (error) {
			console.error('WASM Worker add image from binary failed:', error);
			return null;
		}
	}

	async addImageFromPath(): Promise<number | null> {
		console.warn('addImageFromPath not supported in WASM Worker environment');
		return null;
	}

	async getImageFilePath(): Promise<string | null> {
		return null;
	}

	async cleanupOrphanedImages(): Promise<number> {
		try {
			return await this.callWorkerMethod<number>('wasm_cleanup_orphaned_images');
		} catch (error) {
			console.error('WASM Worker cleanup orphaned images failed:', error);
			return 0;
		}
	}

	// 缩略图相关方法
	async requestThumbnail(imageId: number): Promise<string> {
		try {
			const result = await this.callWorkerMethod<string>('wasm_request_thumbnail', imageId);
			return result || 'ok';
		} catch (error) {
			console.error('WASM Worker request thumbnail failed:', error);
			throw error;
		}
	}

	async getThumbnail(imageId: number): Promise<unknown> {
		try {
			return await this.callWorkerMethod<unknown>('wasm_get_thumbnail', imageId);
		} catch (error) {
			console.error('WASM Worker get thumbnail failed:', error);
			return null;
		}
	}

	async hasThumbnail(imageId: number): Promise<boolean> {
		try {
			return await this.callWorkerMethod<boolean>('wasm_has_thumbnail', imageId);
		} catch (error) {
			console.error('WASM Worker has thumbnail failed:', error);
			return false;
		}
	}

	// 辅助方法
	private imageFormatToEnum(format: ImageFormat): number {
		switch (format) {
			case 'Jpeg': return 0;
			case 'Png': return 1;
			case 'Gif': return 2;
			case 'Webp': return 3;
			case 'Bmp': return 4;
			default: return 1; // PNG
		}
	}

	// 销毁方法
	destroy() {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		
		// 拒绝所有pending的请求
		for (const [id, pending] of this.pendingRequests.entries()) {
			pending.reject(new Error('Worker adapter destroyed'));
			this.pendingRequests.delete(id);
		}
	}
}

// Export functions for WASM initialization (for backward compatibility)
let globalWasmModule: WasmModule | null = null;

export async function initWasm(): Promise<WasmModule | null> {
	// 只在浏览器环境中初始化 WASM
	if (!browser) {
		console.log('Server side rendering - skipping WASM initialization');
		return null;
	}

	if (globalWasmModule) {
		return globalWasmModule;
	}

	// Create a temporary instance to initialize WASM
	const tempInstance = new WasmCoreAPI();
	try {
		// Force initialization by calling any method
		await tempInstance.getStats();
		// Extract the initialized module
		// Use any here because wasmModule is a private property that we need to access
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		globalWasmModule = (tempInstance as any).wasmModule as WasmModule;
		return globalWasmModule;
	} catch (error) {
		console.error('Failed to initialize WASM:', error);
		return null;
	}
}

export function getWasmModule(): WasmModule | null {
	return globalWasmModule;
}

// 决定使用哪种实现
function createCoreAPI(): CoreAPI {
	if (isTauri()) {
		return new TauriCoreAPI();
	} else if (browser && typeof Worker !== 'undefined') {
		// 在浏览器环境且支持Worker时使用Worker适配器
		return new WasmWorkerAdapter();
	} else {
		// 在服务端渲染或不支持Worker时使用直接WASM适配器
		return new WasmCoreAPI();
	}
}

// Export the appropriate implementation
export const coreAPI: CoreAPI = createCoreAPI();