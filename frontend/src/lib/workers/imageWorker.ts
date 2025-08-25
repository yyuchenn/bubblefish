// Web Worker for heavy image processing tasks
// This worker handles large image compression and encoding to avoid blocking the main thread

export interface WorkerImageData {
	file: ArrayBuffer;
	name: string;
	type: string;
	action: 'compress' | 'process' | 'thumbnail' | 'resize';
	options?: ImageProcessingOptions;
}

export interface ImageProcessingOptions {
	quality?: number; // 0.1 - 1.0 for JPEG compression
	maxWidth?: number;
	maxHeight?: number;
	format?: 'jpeg' | 'png' | 'webp';
	thumbnailSize?: number; // For thumbnail generation
}

export interface WorkerResult {
	success: boolean;
	data?: {
		buffer: ArrayBuffer;
		type: string;
		name: string;
		originalSize: number;
		compressedSize: number;
		compressionRatio: number;
	};
	error?: string;
}

// 图片压缩函数
async function compressImage(
	imageData: Uint8Array,
	type: string,
	options: ImageProcessingOptions = {}
): Promise<{ buffer: ArrayBuffer; newType: string; originalSize: number; compressedSize: number }> {
	const {
		quality = 0.8,
		maxWidth = 2048,
		maxHeight = 2048,
		format = 'jpeg'
	} = options;

	const originalSize = imageData.length;

	// 创建 Blob 和 ImageBitmap
	const blob = new Blob([imageData], { type });
	const imageBitmap = await createImageBitmap(blob);

	// 计算新尺寸
	let { width, height } = imageBitmap;
	const scale = Math.min(maxWidth / width, maxHeight / height, 1);
	width = Math.floor(width * scale);
	height = Math.floor(height * scale);

	// 创建离屏画布
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	
	if (!ctx) {
		throw new Error('无法创建画布上下文');
	}

	// 绘制图片
	ctx.drawImage(imageBitmap, 0, 0, width, height);

	// 转换为指定格式
	const mimeType = `image/${format}`;
	const compressedBlob = await canvas.convertToBlob({
		type: mimeType,
		quality: format === 'jpeg' ? quality : undefined
	});

	const compressedBuffer = await compressedBlob.arrayBuffer();
	
	return {
		buffer: compressedBuffer,
		newType: mimeType,
		originalSize,
		compressedSize: compressedBuffer.byteLength
	};
}

// 生成缩略图
async function generateThumbnail(
	imageData: Uint8Array,
	type: string,
	size: number = 200
): Promise<{ buffer: ArrayBuffer; newType: string }> {
	const blob = new Blob([imageData], { type });
	const imageBitmap = await createImageBitmap(blob);

	// 创建正方形缩略图
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext('2d');
	
	if (!ctx) {
		throw new Error('无法创建画布上下文');
	}

	// 计算裁剪位置（居中裁剪）
	const { width, height } = imageBitmap;
	const scale = Math.max(size / width, size / height);
	const scaledWidth = width * scale;
	const scaledHeight = height * scale;
	const x = (size - scaledWidth) / 2;
	const y = (size - scaledHeight) / 2;

	// 填充背景色
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, size, size);

	// 绘制图片
	ctx.drawImage(imageBitmap, x, y, scaledWidth, scaledHeight);

	// 转换为JPEG格式
	const thumbnailBlob = await canvas.convertToBlob({
		type: 'image/jpeg',
		quality: 0.8
	});

	const thumbnailBuffer = await thumbnailBlob.arrayBuffer();
	
	return {
		buffer: thumbnailBuffer,
		newType: 'image/jpeg'
	};
}

// 调整图片尺寸
async function resizeImage(
	imageData: Uint8Array,
	type: string,
	maxWidth: number,
	maxHeight: number,
	format: string = 'jpeg',
	quality: number = 0.9
): Promise<{ buffer: ArrayBuffer; newType: string }> {
	const blob = new Blob([imageData], { type });
	const imageBitmap = await createImageBitmap(blob);

	// 计算新尺寸（保持宽高比）
	let { width, height } = imageBitmap;
	const scale = Math.min(maxWidth / width, maxHeight / height, 1);
	width = Math.floor(width * scale);
	height = Math.floor(height * scale);

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	
	if (!ctx) {
		throw new Error('无法创建画布上下文');
	}

	// 绘制图片
	ctx.drawImage(imageBitmap, 0, 0, width, height);

	// 转换格式
	const mimeType = `image/${format}`;
	const resizedBlob = await canvas.convertToBlob({
		type: mimeType,
		quality: format === 'jpeg' ? quality : undefined
	});

	const resizedBuffer = await resizedBlob.arrayBuffer();
	
	return {
		buffer: resizedBuffer,
		newType: mimeType
	};
}

// 主处理函数
async function processImageInWorker(workerData: WorkerImageData): Promise<WorkerResult> {
	try {
		const { file, name, type, action, options = {} } = workerData;
		const imageData = new Uint8Array(file);
		const originalSize = file.byteLength;

		let result: { buffer: ArrayBuffer; newType: string; originalSize?: number; compressedSize?: number };

		switch (action) {
			case 'compress': {
				const compressed = await compressImage(imageData, type, options);
				result = {
					buffer: compressed.buffer,
					newType: compressed.newType,
					originalSize: compressed.originalSize,
					compressedSize: compressed.compressedSize
				};
				break;
			}

			case 'thumbnail': {
				const thumbnail = await generateThumbnail(imageData, type, options.thumbnailSize);
				result = {
					buffer: thumbnail.buffer,
					newType: thumbnail.newType,
					originalSize,
					compressedSize: thumbnail.buffer.byteLength
				};
				break;
			}

			case 'resize': {
				const resized = await resizeImage(
					imageData, 
					type, 
					options.maxWidth || 1920,
					options.maxHeight || 1080,
					options.format || 'jpeg',
					options.quality || 0.9
				);
				result = {
					buffer: resized.buffer,
					newType: resized.newType,
					originalSize,
					compressedSize: resized.buffer.byteLength
				};
				break;
			}

			case 'process':
			default: {
				// 默认处理：轻度压缩
				const processed = await compressImage(imageData, type, {
					quality: 0.9,
					maxWidth: 2048,
					maxHeight: 2048,
					...options
				});
				result = {
					buffer: processed.buffer,
					newType: processed.newType,
					originalSize: processed.originalSize,
					compressedSize: processed.compressedSize
				};
				break;
			}
		}

		const compressionRatio = result.originalSize && result.compressedSize 
			? result.originalSize / result.compressedSize 
			: 1;

		return {
			success: true,
			data: {
				buffer: result.buffer,
				type: result.newType,
				name: name,
				originalSize: result.originalSize || originalSize,
				compressedSize: result.compressedSize || result.buffer.byteLength,
				compressionRatio
			}
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : '图片处理失败'
		};
	}
}

// Worker message handler
self.onmessage = async (e: MessageEvent<WorkerImageData>) => {
	const result = await processImageInWorker(e.data);
	self.postMessage(result);
};
