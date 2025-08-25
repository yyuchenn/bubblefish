// 输入验证工具

// 项目名称验证
export interface ProjectNameValidation {
	isValid: boolean;
	error?: string;
}

export function validateProjectName(name: string): ProjectNameValidation {
	// 去除首尾空格
	const trimmedName = name.trim();
	
	// 检查是否为空
	if (!trimmedName) {
		return {
			isValid: false,
			error: '项目名称不能为空'
		};
	}
	
	// 检查长度
	if (trimmedName.length > 100) {
		return {
			isValid: false,
			error: '项目名称不能超过100个字符'
		};
	}
	
	// 检查非法字符（文件系统不支持的字符）
	// Check for invalid filesystem characters and control characters
	const hasInvalidChars = /[<>:"/\\|?*]/.test(trimmedName) || 
		Array.from(trimmedName).some(char => char.charCodeAt(0) <= 31);
	
	if (hasInvalidChars) {
		return {
			isValid: false,
			error: '项目名称包含非法字符'
		};
	}
	
	// 检查保留名称
	const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
	if (reservedNames.includes(trimmedName.toUpperCase())) {
		return {
			isValid: false,
			error: '项目名称不能使用系统保留名称'
		};
	}
	
	return { isValid: true };
}

// 图片文件验证
export interface ImageFileValidation {
	isValid: boolean;
	error?: string;
}

export function validateImageFile(file: File): ImageFileValidation {
	// 检查文件类型
	const supportedTypes = [
		'image/jpeg',
		'image/jpg', 
		'image/png',
		'image/gif',
		'image/webp',
		'image/bmp'
	];
	
	if (!supportedTypes.includes(file.type.toLowerCase())) {
		return {
			isValid: false,
			error: '不支持的图片格式，请使用 JPEG、PNG、GIF、WebP 或 BMP 格式'
		};
	}
	
	// 检查文件大小 (50MB限制)
	const maxSize = 50 * 1024 * 1024; // 50MB
	if (file.size > maxSize) {
		return {
			isValid: false,
			error: '图片文件大小不能超过50MB'
		};
	}
	
	// 检查文件名
	if (file.name.length > 255) {
		return {
			isValid: false,
			error: '文件名长度不能超过255个字符'
		};
	}
	
	return { isValid: true };
}

// 批量图片验证
export interface BatchImageValidation {
	validFiles: File[];
	invalidFiles: Array<{ file: File; error: string }>;
	totalSize: number;
}

export function validateImageBatch(files: File[], maxTotalSize: number = 200 * 1024 * 1024): BatchImageValidation {
	const validFiles: File[] = [];
	const invalidFiles: Array<{ file: File; error: string }> = [];
	let totalSize = 0;
	
	for (const file of files) {
		const validation = validateImageFile(file);
		if (validation.isValid) {
			validFiles.push(file);
			totalSize += file.size;
		} else {
			invalidFiles.push({ file, error: validation.error! });
		}
	}
	
	// 检查总大小
	if (totalSize > maxTotalSize) {
		// 将所有文件标记为无效
		for (const file of validFiles) {
			invalidFiles.push({ file, error: '批量上传总大小超过限制' });
		}
		return {
			validFiles: [],
			invalidFiles,
			totalSize: 0
		};
	}
	
	return {
		validFiles,
		invalidFiles,
		totalSize
	};
}

// URL验证
export interface UrlValidation {
	isValid: boolean;
	error?: string;
}


// 翻译文本验证
export interface TranslationValidation {
	isValid: boolean;
	error?: string;
	warning?: string;
}

export function validateTranslation(translation: string): TranslationValidation {
	// 翻译可以为空
	if (!translation) {
		return { isValid: true };
	}
	
	const trimmedTranslation = translation.trim();
	
	// 检查长度
	if (trimmedTranslation.length > 1000) {
		return {
			isValid: false,
			error: '翻译文本不能超过1000个字符'
		};
	}
	
	// 检查是否只包含空白字符
	if (trimmedTranslation.length === 0 && translation.length > 0) {
		return {
			isValid: true,
			warning: '翻译只包含空白字符'
		};
	}
	
	return { isValid: true };
}

// 坐标验证
export interface CoordinateValidation {
	isValid: boolean;
	error?: string;
}

export function validateCoordinates(x: number, y: number, imageWidth?: number, imageHeight?: number): CoordinateValidation {
	// 检查是否为有效数字
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return {
			isValid: false,
			error: '坐标必须是有效数字'
		};
	}
	
	// 检查是否为负数
	if (x < 0 || y < 0) {
		return {
			isValid: false,
			error: '坐标不能为负数'
		};
	}
	
	// 如果提供了图片尺寸，检查是否超出范围
	if (imageWidth !== undefined && x > imageWidth) {
		return {
			isValid: false,
			error: `X坐标超出图片宽度范围 (0-${imageWidth})`
		};
	}
	
	if (imageHeight !== undefined && y > imageHeight) {
		return {
			isValid: false,
			error: `Y坐标超出图片高度范围 (0-${imageHeight})`
		};
	}
	
	return { isValid: true };
}

// 缩放值验证
export function validateScale(scale: number, minScale: number = 0.1, maxScale: number = 10): CoordinateValidation {
	if (!Number.isFinite(scale)) {
		return {
			isValid: false,
			error: '缩放值必须是有效数字'
		};
	}
	
	if (scale < minScale) {
		return {
			isValid: false,
			error: `缩放值不能小于 ${minScale}`
		};
	}
	
	if (scale > maxScale) {
		return {
			isValid: false,
			error: `缩放值不能大于 ${maxScale}`
		};
	}
	
	return { isValid: true };
}

// 通用验证工具
export const ValidationUtils = {
	// 清理文件名
	sanitizeFileName(name: string): string {
		return name
			.trim()
			// Replace invalid filesystem characters and control characters
			.replace(/[<>:"/\\|?*]/g, '_') // Replace invalid filesystem chars
			.split('').map(char => char.charCodeAt(0) <= 31 ? '_' : char).join('') // Replace control chars
			.replace(/^\.+/, '') // 移除开头的点
			.substring(0, 255); // 限制长度
	},
	
	// 检查是否为空或只包含空白字符
	isEmpty(value: string): boolean {
		return !value || value.trim().length === 0;
	},
	
	// 格式化文件大小
	formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	},
	
	// 生成唯一ID
	generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substr(2);
	}
};