// Language enum matching backend
export type Language = 'japanese' | 'english' | 'simplifiedChinese' | 'traditionalChinese';

// Re-export Bunny types
export type { 
	BunnyTask, 
	BunnyMarkerData, 
	BunnySettings, 
	BunnyQueueStatus,
	BunnyWorkerMessage,
	BunnyWorkerResponse,
	BunnyTaskEvent,
	OCRModel,
	TranslationService
} from './types/bunny';

export interface MarkerStyle {
	/** 是否是覆盖式文字 */
	overlayText: boolean;
	/** 是否是横排的文字 */
	horizontal: boolean;
}

// Marker几何类型
export type MarkerGeometry = 
	| { type: 'point'; x: number; y: number }
	| { type: 'rectangle'; x: number; y: number; width: number; height: number };

export interface Marker {
	id: number;
	imageId: number;
	geometry: MarkerGeometry;
	translation?: string;
	style: MarkerStyle;
	imageIndex: number;
}

// 图片格式枚举，与后端保持一致
export type ImageFormat = 'Jpeg' | 'Png' | 'Gif' | 'Webp' | 'Bmp';

// 图片元数据结构，匹配后端的 ImageMetadata
export interface ImageMetadata {
	id: number; // 对应后端的 u32
	name?: string;
	width?: number; // 对应后端的 Option<u32>
	height?: number; // 对应后端的 Option<u32>
	format?: ImageFormat; // 对应后端的 Option<ImageFormat>
	size?: number; // 对应后端的 Option<u64>，前端使用 number 表示
}

// 图片数据类型，匹配后端的 ImageData 枚举结构
export type ImageData = 
	| { type: 'FilePath'; path: string }
	| { type: 'Binary'; format: ImageFormat; data: Uint8Array }
	| { type: 'Url'; url: string }
	| { type: 'SharedBuffer'; format: ImageFormat; buffer_id: number };

// 完整的图片结构，匹配后端的 Image
export interface Image {
	metadata: ImageMetadata;
	data: ImageData;
	markers: Marker[];
}

export interface TranslationProject {
	id: number;
	name: string;
	sourceLanguage?: Language;
	targetLanguage?: Language;
}

export interface OpeningProjectInfo {
	projectId: number;
	projectName: string;
	requiredImages: string[];
	pendingImages: string[];
	uploadedImages: string[];
	isComplete: boolean;
}

export interface ImageFile {
	file?: File; // Optional for Tauri desktop version
	name: string;
	size: number;
	type: string;
	path?: string; // Optional path for Tauri desktop version
	url?: string; // Optional URL for preview in Tauri desktop version
}

export interface UndoRedoResult {
	success: boolean;
	image_id?: number | null;
	marker_id?: number | null;
}
