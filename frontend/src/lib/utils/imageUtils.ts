export interface ProcessedImage {
	file: File;
	blob: Blob;
	url: string;
}

export class ImageProcessor {
	private static instance: ImageProcessor;
	private worker: Worker | null = null;
	private workerAvailable = false;

	static getInstance(): ImageProcessor {
		if (!ImageProcessor.instance) {
			ImageProcessor.instance = new ImageProcessor();
		}
		return ImageProcessor.instance;
	}

	constructor() {
		this.initializeWorker();
	}

	private initializeWorker() {
		try {
			if (typeof Worker !== 'undefined') {
				const workerScript = `
          ${this.getWorkerScript()}
        `;

				const blob = new Blob([workerScript], { type: 'application/javascript' });
				this.worker = new Worker(URL.createObjectURL(blob));
				this.workerAvailable = true;

				console.log('Image Worker 已初始化，支持直接上传图片');
			}
		} catch (error) {
			console.warn('Worker 初始化失败，将直接上传:', error);
			this.workerAvailable = false;
		}
	}

	private getWorkerScript(): string {
		return `
      async function uploadImageInWorker(imageData) {
        try {
          const { file, name, type } = imageData;
          
          return {
            success: true,
            data: {
              buffer: file,
              type: type,
              name: name
            }
          };
          
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : '图片处理失败'
          };
        }
      }

      self.onmessage = async (e) => {
        const result = await uploadImageInWorker(e.data);
        self.postMessage(result);
      };
    `;
	}

	/**
	 * 检查文件是否为图片
	 */
	isImageFile(file: File): boolean {
		return file.type.startsWith('image/');
	}

	/**
	 * 处理图片 - 直接上传，不压缩
	 */
	async processImage(file: File): Promise<ProcessedImage> {
		if (!this.isImageFile(file)) {
			throw new Error('文件不是有效的图片格式');
		}

		// 优先使用 Worker 处理
		if (this.workerAvailable && this.worker) {
			try {
				const result = await this.uploadImageWithWorker(file);
				return result;
			} catch (error) {
				console.warn('Worker 上传失败，使用直接上传:', error);
			}
		}

		// 直接返回文件，不进行任何处理
		const url = URL.createObjectURL(file);
		return {
			file,
			blob: file,
			url
		};
	}

	/**
	 * 使用 Web Worker 上传图片
	 */
	private async uploadImageWithWorker(file: File): Promise<ProcessedImage> {
		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error('Worker 不可用'));
				return;
			}

			const arrayBuffer = file.arrayBuffer();

			arrayBuffer
				.then((buffer) => {
					const workerData = {
						file: buffer,
						name: file.name,
						type: file.type
					};

					const handleWorkerMessage = (e: MessageEvent) => {
						this.worker!.removeEventListener('message', handleWorkerMessage);

						const result = e.data;
						if (result.success && result.data) {
							const { buffer, type, name } = result.data;

							// 创建 Blob 和 File 对象
							const blob = new Blob([buffer], { type });
							const url = URL.createObjectURL(blob);
							const uploadFile = new File([blob], name, { type });

							resolve({
								file: uploadFile,
								blob,
								url
							});
						} else {
							reject(new Error(result.error || 'Worker 处理失败'));
						}
					};

					this.worker!.addEventListener('message', handleWorkerMessage);
					this.worker!.postMessage(workerData);
				})
				.catch((error) => {
					reject(error);
				});
		});
	}


	/**
	 * 批量处理图片
	 */
	async processImages(
		files: File[],
		onProgress?: (processed: number, total: number) => void
	): Promise<ProcessedImage[]> {
		const results: ProcessedImage[] = [];

		for (let i = 0; i < files.length; i++) {
			try {
				const result = await this.processImage(files[i]);
				results.push(result);
				onProgress?.(i + 1, files.length);
			} catch (error) {
				console.error(`处理图片 ${files[i].name} 失败:`, error);
				// 继续处理其他图片，不中断整个流程
			}
		}

		return results;
	}


	/**
	 * 清理Object URL资源
	 */
	static revokeObjectURL(url: string): void {
		if (url.startsWith('blob:')) {
			URL.revokeObjectURL(url);
		}
	}

	/**
	 * 格式化文件大小显示
	 */
	static formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}

	/**
	 * 清理Worker资源
	 */
	destroy(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
			this.workerAvailable = false;
		}
	}
}

export const imageProcessor = ImageProcessor.getInstance();
