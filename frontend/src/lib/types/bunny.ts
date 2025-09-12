// Bunny (海兔) types for OCR and translation functionality

export type OCRModel = 'tesseract' | 'paddleocr' | 'easyocr' | 'default';
export type TranslationService = 'google' | 'deepl' | 'chatgpt' | 'baidu' | 'default';

export interface BunnyTask {
	id: string;
	markerId: number;
	imageId: number;
	type: 'ocr' | 'translation';
	status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
	model?: OCRModel;
	service?: TranslationService;
	result?: string;
	error?: string;
	progress?: number;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
}

export interface BunnyMarkerData {
	markerId: number;
	ocrText?: string;
	translation?: string;
	ocrTaskId?: string;
	translationTaskId?: string;
	lastOCRModel?: OCRModel;
	lastTranslationService?: TranslationService;
}

export interface BunnySettings {
	ocrModel: OCRModel;
	translationService: TranslationService;
	sourceLang?: string;
	targetLang: string;
	autoTranslateAfterOCR: boolean;
	batchSize: number;
}

export interface BunnyQueueStatus {
	totalTasks: number;
	queuedTasks: number;
	processingTasks: number;
	completedTasks: number;
	failedTasks: number;
}

// Worker message types
export type BunnyWorkerMessage = 
	| { type: 'ocr_request'; taskId: string; markerId: number; imageId: number; model: OCRModel }
	| { type: 'translation_request'; taskId: string; markerId: number; text: string; service: TranslationService; sourceLang?: string; targetLang: string }
	| { type: 'cancel_task'; taskId: string }
	| { type: 'get_queue_status' }
	| { type: 'clear_queue' };

export type BunnyWorkerResponse =
	| { type: 'task_started'; taskId: string; markerId: number }
	| { type: 'task_progress'; taskId: string; progress: number }
	| { type: 'task_completed'; taskId: string; markerId: number; result: string }
	| { type: 'task_failed'; taskId: string; markerId: number; error: string }
	| { type: 'task_cancelled'; taskId: string; markerId: number }
	| { type: 'queue_status'; status: BunnyQueueStatus };

// Event types
export interface BunnyTaskEvent {
	type: 'task_started' | 'task_progress' | 'task_completed' | 'task_failed' | 'task_cancelled';
	taskId: string;
	markerId: number;
	taskType: 'ocr' | 'translation';
	data?: any;
}