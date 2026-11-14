import { coreAPI } from '../core/adapter';
import { projectStore, currentProject } from '../stores/projectStore';
import { loadingStore } from '../stores/loadingStore';
import { errorStore } from '../stores/errorStore';
import { imageStore } from '../stores/imageStore';
import { markerStore } from '../stores/markerStore';
import { imageViewerActions } from '../stores/imageViewerStore';
import { progressManager, type ProgressController } from '../utils/progressManager';
import { get } from 'svelte/store';
import type { TranslationProject, ImageFormat, Language } from '../types';
import { eventService } from './eventService';
import type { BusinessEvent } from '../core/events';

// Export read-only store subscription for components
export { projectStore, currentProject };

// Export derived stores for component usage
import { derived } from 'svelte/store';

export const currentProjectId = derived(projectStore, $store => $store.currentProjectId);
export const projects = derived(projectStore, $store => $store.projects);

// Helper functions for components
export function getCurrentProjectId(): number | null {
	return get(projectStore).currentProjectId;
}

export function getProjects(): TranslationProject[] {
	return get(projectStore).projects;
}

export interface ImageUploadItem {
	url?: string; // 预览 URL
	path?: string; // 文件路径（桌面版）
	file?: File; // 原始文件对象（Web版）
	name: string;
	size?: number; // 文件大小
	isProcessing?: boolean; // 是否正在处理
}

export interface ProjectCreationData {
	name: string;
	images: ImageUploadItem[];
	translationFileContent?: string;
}

export interface ProjectCreationResult {
	success: boolean;
	projectId?: number;
	uploadedImageIds?: number[];
	error?: string;
	totalImages?: number;
	successfulUploads?: number;
}

/**
 * Project Service - 项目管理服务
 * 负责协调项目相关的所有操作
 */
class ProjectService {
	private static instance: ProjectService;
	private unsubscribeEventListener: (() => void) | null = null;

	static getInstance(): ProjectService {
		if (!ProjectService.instance) {
			ProjectService.instance = new ProjectService();
			ProjectService.instance.initialize();
		}
		return ProjectService.instance;
	}

	/**
	 * 初始化服务，设置事件监听
	 */
	private initialize(): void {
		// 监听项目相关更新事件
		this.unsubscribeEventListener = eventService.onBusinessEvent((event: BusinessEvent) => {
			if (event.event_name === 'ProjectNameUpdated') {
				const data = event.data as { project_id: number; name: string };
				// 更新store中的项目名称
				projectStore.updateProject(data.project_id, { name: data.name });
			} else if (event.event_name === 'ProjectLanguagesUpdated') {
				const data = event.data as { 
					project_id: number; 
					source_language: Language; 
					target_language: Language 
				};
				// 更新store中的项目语言设置
				projectStore.updateProject(data.project_id, { 
					sourceLanguage: data.source_language,
					targetLanguage: data.target_language
				});
			}
		});
	}

	/**
	 * 清理资源
	 */
	destroy(): void {
		if (this.unsubscribeEventListener) {
			this.unsubscribeEventListener();
			this.unsubscribeEventListener = null;
		}
	}

	/**
	 * 格式化图片格式字符串，确保与后端期望的格式匹配
	 */
	private normalizeImageFormat(mimeType: string): ImageFormat {
		const type = mimeType.toLowerCase();
		if (type.includes('jpeg') || type.includes('jpg')) return 'Jpeg';
		if (type.includes('png')) return 'Png';
		if (type.includes('gif')) return 'Gif';
		if (type.includes('webp')) return 'Webp';
		if (type.includes('bmp')) return 'Bmp';
		return 'Png'; // 默认格式
	}

	/**
	 * 创建项目并上传图片
	 */
	async createProjectWithImages(data: ProjectCreationData): Promise<ProjectCreationResult> {
		const { name, images, translationFileContent } = data;
		const validImages = images.filter((img) => !img.isProcessing);

		// 启动进度跟踪
		const progressController = progressManager.start({
			id: `create-project-${Date.now()}`,
			title: `创建项目"${name}"`,
			subtitle: `准备上传 ${validImages.length} 张图片`,
			canCancel: false,
			});

		let projectId: number | null = null;
		
		try {
			// 1. 创建临时项目 (10%进度)
			progressController.update({ progress: 5, subtitle: '正在创建临时项目...' });
			projectId = await coreAPI.createEmptyOpeningProject(name);

			if (!projectId && projectId !== 0) {
				throw new Error('临时项目创建失败');
			}

			progressController.update({ progress: 10, subtitle: '项目创建成功，开始上传图片...' });

			// 2. 上传图片 (10% - 70%进度)
			const uploadedImageIds = await this.uploadImagesToProjectWithProgress(
				projectId,
				validImages,
				progressController,
				10, // 起始进度
				60 // 进度范围
			);

			progressController.update({ progress: 70, subtitle: '图片上传完成，正在整理资源...' });

			// 3. 导入翻译数据 (70% - 85%进度)
			if (translationFileContent) {
				progressController.update({ progress: 75, subtitle: '正在导入翻译数据...' });
				try {
					const importResult = await coreAPI.importLabelplusData(projectId, translationFileContent);
					if (importResult.error) {
						console.error('翻译数据导入失败:', importResult.error);
						// 不中断流程，继续执行
					} else {
						progressController.update({ progress: 85, subtitle: '翻译数据导入成功' });
					}
				} catch (error) {
					console.error('翻译数据导入异常:', error);
					// 不中断流程，继续执行
				}
			} else {
				progressController.update({ progress: 85 });
			}

			// 4. 将临时项目转为正式项目 (85% - 90%)
			progressController.update({ progress: 87, subtitle: '正在完成项目创建...' });
			const finalized = await coreAPI.finalizeOpeningProject(projectId);
			if (!finalized) {
				throw new Error('项目转正失败');
			}

			// 5. 清理资源
			this.cleanupImageResources(images);

			// 6. 增量添加新项目到列表并切换 (90% - 95%)
			progressController.update({ progress: 90, subtitle: '正在切换到新项目...' });

			// 获取新创建的项目信息
			const newProject = await coreAPI.getProjectInfo(projectId);
			if (newProject) {
				// 增量添加到项目列表
				projectStore.addProject(newProject);
			}

			// 切换到新项目
			await this.setCurrentProject(projectId);

			progressController.update({ progress: 95, subtitle: '正在完成...' });

			// 完成进度
			progressController.update({ progress: 100, subtitle: '项目创建完成！' });
			progressController.complete();

			return {
				success: true,
				projectId,
				uploadedImageIds,
				totalImages: validImages.length,
				successfulUploads: uploadedImageIds.length
			};
		} catch (error) {
			progressController.cancel();
			
			// 如果项目创建失败，删除临时项目
			if (projectId !== undefined && projectId !== null) {
				try {
					await coreAPI.deleteOpeningProject(projectId);
				} catch (deleteError) {
					console.error('删除临时项目失败:', deleteError);
				}
			}

			return {
				success: false,
				error: error instanceof Error ? error.message : '项目创建失败'
			};
		}
	}

	/**
	 * 上传图片到指定项目（带进度回调）
	 */
	private async uploadImagesToProjectWithProgress(
		projectId: number,
		images: ImageUploadItem[],
		progressController: ProgressController,
		startProgress: number,
		progressRange: number
	): Promise<number[]> {
		const validImages = images.filter((img) => !img.isProcessing);

		if (validImages.length === 0) {
			return [];
		}

		const uploadedImageIds: number[] = [];

		for (let i = 0; i < validImages.length; i++) {
			const image = validImages[i];

			// 计算当前进度
			const currentProgress = startProgress + (i / validImages.length) * progressRange;
			progressController.update({
				progress: currentProgress,
				subtitle: `正在上传图片 ${i + 1}/${validImages.length}: ${image.name}`
			});

			try {
				const imageId = await this.uploadSingleImage(projectId, image);

				if (imageId) {
					uploadedImageIds.push(imageId);
				} else {
					console.warn(`⚠️ 图片上传失败: ${image.name} - 无有效数据`);
				}
			} catch (error) {
				console.error(`❌ 图片上传失败: ${image.name}`, error);
			}
		}

		// 完成图片上传部分的进度
		progressController.update({
			progress: startProgress + progressRange,
			subtitle: `图片上传完成 (${uploadedImageIds.length}/${validImages.length})`
		});

		return uploadedImageIds;
	}


	/**
	 * 上传单张图片
	 */
	private async uploadSingleImage(
		projectId: number,
		image: ImageUploadItem
	): Promise<number | null> {
		// 优先使用文件路径（桌面版）- 性能更好
		if (image.path) {
			console.log(`📁 Uploading image via file path: ${image.path}`);
			return await coreAPI.addImageFromPath(projectId, image.path);
		}
		// 处理Web版的原始文件
		else if (image.file) {
			console.log(`📦 Uploading image via binary data: ${image.name}`);
			const arrayBuffer = await image.file.arrayBuffer();
			const binaryData = new Uint8Array(arrayBuffer);
			const format = this.normalizeImageFormat(image.file.type);
			return await coreAPI.addImageFromBinary(projectId, format, binaryData, image.name);
		}

		return null;
	}

	/**
	 * 清理图片资源
	 */
	private cleanupImageResources(images: ImageUploadItem[]): void {
		images.forEach((image) => {
			// 清理预览 URL
			if (image.url) {
				URL.revokeObjectURL(image.url);
			}
		});
	}

	/**
	 * 加载所有项目
	 */
	async loadProjects(): Promise<TranslationProject[]> {
		loadingStore.startLoading('loadProjects');
		try {
			const projects = await coreAPI.getAllProjectsInfo();
			projectStore.setProjects(projects);
			return projects;
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to load projects'));
			return [];
		} finally {
			loadingStore.stopLoading('loadProjects');
		}
	}

	/**
	 * 设置项目列表（用于删除项目后更新列表）
	 */
	setProjects(projects: TranslationProject[]): void {
		projectStore.setProjects(projects);
	}

	/**
	 * 创建新项目
	 */
	async createProject(name: string): Promise<number | null> {
		loadingStore.startLoading('createProject');
		try {
			// Create an empty opening project first
			const openingProjectId = await coreAPI.createEmptyOpeningProject(name);
			if (openingProjectId) {
				// Finalize it to create a real project
				const success = await coreAPI.finalizeOpeningProject(openingProjectId);
				if (success) {
					await this.loadProjects();
					await this.setCurrentProject(openingProjectId);
				}
			}
			return openingProjectId;
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to create project'));
			return null;
		} finally {
			loadingStore.stopLoading('createProject');
		}
	}

	/**
	 * 设置当前项目
	 */
	async setCurrentProject(projectId: number | null): Promise<void> {
		loadingStore.startLoading('setCurrentProject');
		try {
			if (projectId === null) {
				// 清理所有状态
				imageStore.reset();
				markerStore.reset();
				imageViewerActions.resetTransform();
				projectStore.setCurrentProject(null);
				return;
			}

			const project = await coreAPI.getProjectInfo(projectId);
			if (project) {
				const images = await coreAPI.getProjectImagesMetadata(projectId);
				
				// 保存当前图片ID，避免重新选择项目时丢失当前图片
				const currentImageId = imageStore.getCurrentImageId();
				
				// 更新各个store的状态
				imageStore.setImages(images);
				markerStore.clearMarkers();
				imageViewerActions.resetTransform();

				projectStore.setCurrentProject(projectId, project.name);

				// 加载当前图片的标记（如果有图片的话）
				if (images.length > 0) {
					// 尝试恢复之前的图片，如果不存在则选择第一张
					const targetImageId = currentImageId && images.some(img => img.id === currentImageId) 
						? currentImageId 
						: images[0].id;
					
					if (targetImageId !== currentImageId) {
						imageStore.setCurrentImage(targetImageId);
					}
					
					// 加载标记
					const markers = await coreAPI.getImageMarkers(targetImageId);
					markerStore.setMarkers(markers);
				}
			}
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to load project'));
		} finally {
			loadingStore.stopLoading('setCurrentProject');
		}
	}

	/**
	 * 更新项目名称
	 */
	async updateProjectName(projectId: number, name: string): Promise<boolean> {
		try {
			const success = await coreAPI.updateProjectName(projectId, name);
			if (success) {
				projectStore.updateProject(projectId, { name });
			}
			return success;
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to update project name'));
			return false;
		}
	}

	/**
	 * 更新项目语言设置
	 */
	async updateProjectLanguages(projectId: number, sourceLanguage: Language, targetLanguage: Language): Promise<boolean> {
		try {
			const success = await coreAPI.updateProjectLanguages(projectId, sourceLanguage, targetLanguage);
			if (success) {
				projectStore.updateProject(projectId, { sourceLanguage, targetLanguage });
			}
			return success;
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to update project languages'));
			return false;
		}
	}

	/**
	 * 删除项目
	 */
	async deleteProject(projectId: number): Promise<boolean> {
		try {
			const success = await coreAPI.deleteProject(projectId);
			if (success) {
				const currentProjectId = projectStore.getCurrentProjectId();
				projectStore.removeProject(projectId);

				// 如果删除的是当前项目，清理所有状态
				if (currentProjectId === projectId) {
					imageStore.reset();
					markerStore.reset();
					imageViewerActions.resetTransform();
				}
			}
			return success;
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to delete project'));
			return false;
		}
	}

	/**
	 * 获取当前项目
	 */
	getCurrentProject(): TranslationProject | null {
		return get(currentProject);
	}

	/**
	 * 获取当前项目ID
	 */
	getCurrentProjectId(): number | null {
		return projectStore.getCurrentProjectId();
	}

	/**
	 * 获取所有项目
	 */
	getProjects(): TranslationProject[] {
		return projectStore.getProjects();
	}

	/**
	 * 根据ID获取项目
	 */
	getProjectById(projectId: number): TranslationProject | null {
		return projectStore.getProjectById(projectId);
	}

	/**
	 * 检查是否有项目
	 */
	hasProjects(): boolean {
		return projectStore.getProjects().length > 0;
	}

	/**
	 * 保存项目
	 */
	async saveProject(projectId: number): Promise<{ data?: Uint8Array; error?: string }> {
		try {
			const result = await coreAPI.saveProject(projectId);
			if (result.data && !(result.data instanceof Uint8Array)) {
				// 如果返回的是数组，转换为Uint8Array
				return { ...result, data: new Uint8Array(result.data) };
			}
			return result as { data?: Uint8Array; error?: string };
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to save project'));
			return { error: error instanceof Error ? error.message : 'Failed to save project' };
		}
	}

	/**
	 * 导出 Labelplus 数据
	 */
	async exportLabelplusData(projectId: number): Promise<{ content?: string; error?: string }> {
		try {
			return await coreAPI.exportLabelplusData(projectId);
		} catch (error) {
			errorStore.setError(error instanceof Error ? error : new Error('Failed to export data'));
			return { error: error instanceof Error ? error.message : 'Failed to export data' };
		}
	}

	/**
	 * 保存项目到指定路径（Tauri桌面端）
	 */
	async saveProjectToPath(projectId: number, filePath: string): Promise<{ success: boolean; error?: string }> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('save_project_to_path', { projectId, filePath });
			return { success: true };
		} catch (error) {
			console.error('Failed to save project to path:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * 获取项目的文件路径（Tauri桌面端）
	 */
	async getProjectFilePath(projectId: number): Promise<string | null> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const filePath = await invoke<string | null>('get_project_file_path', { projectId });
			return filePath;
		} catch (error) {
			console.error('Failed to get project file path:', error);
			return null;
		}
	}

	/**
	 * 更新项目的文件路径
	 */
	async updateProjectFilePath(projectId: number, filePath: string | null): Promise<boolean> {
		try {
			return await coreAPI.updateProjectFilePath(projectId, filePath);
		} catch (error) {
			console.error('Failed to update project file path:', error);
			return false;
		}
	}

	/**
	 * 创建临时项目（从路径）
	 */
	async createOpeningProjectFromPath(filePath: string, projectName: string): Promise<number | null> {
		return coreAPI.createOpeningProjectFromPath(filePath, projectName);
	}

	/**
	 * 创建临时项目（从二进制数据）
	 */
	async createOpeningProjectFromBinary(data: Uint8Array, extension: string, projectName: string): Promise<number | null> {
		return coreAPI.createOpeningProjectFromBinary(data, extension, projectName);
	}

	/**
	 * 获取临时项目信息
	 */
	async getOpeningProjectInfo(projectId: number): Promise<unknown> {
		return coreAPI.getOpeningProjectInfo(projectId);
	}

	/**
	 * 删除临时项目
	 */
	async deleteOpeningProject(projectId: number): Promise<void> {
		await coreAPI.deleteOpeningProject(projectId);
	}

	/**
	 * 处理关闭项目（包含未保存检查）
	 */
	async handleCloseProject(projectId: number): Promise<void> {
		const { modalStore } = await import('./modalService');
		const { undoRedoActions } = await import('./undoRedoService');
		
		const projectState = undoRedoActions.getProjectState(projectId);
		
		if (projectState.hasUnsaved) {
			const project = get(projects).find(p => p.id === projectId);
			modalStore.showModal('confirm', {
				title: '关闭项目',
				message: `项目 "${project?.name || '未命名'}" 有未保存的修改。确定要关闭吗？`,
				confirmText: '关闭',
				cancelText: '取消',
				onConfirm: async () => {
					await this.performCloseProject(projectId);
				}
			});
		} else {
			await this.performCloseProject(projectId);
		}
	}

	/**
	 * 执行关闭项目
	 */
	async performCloseProject(projectId: number): Promise<void> {
		const { undoRedoActions } = await import('./undoRedoService');
		
		try {
			if (get(currentProjectId) === projectId) {
				await this.setCurrentProject(null);
			}
			
			const success = await this.deleteProject(projectId);
			if (success) {
				const currentProjects = get(projects);
				this.setProjects(currentProjects.filter((p: TranslationProject) => p.id !== projectId));
				undoRedoActions.clearProjectState(projectId);
				
				const remainingProjects = get(projects).filter(p => p.id !== projectId);
				if (remainingProjects.length > 0 && get(currentProjectId) === null) {
					await this.setCurrentProject(remainingProjects[0].id);
				}
			}
		} catch (error) {
			console.error('Failed to close project:', error);
		}
	}

	/**
	 * 处理保存项目操作
	 */
	async handleSaveProject(projectId: number): Promise<void> {
		const { platformService } = await import('./platformService');
		const { undoRedoActions } = await import('./undoRedoService');
		
		try {
			if (platformService.isTauri()) {
				const filePath = await this.getProjectFilePath(projectId);
				
				if (filePath) {
					const result = await this.saveProjectToPath(projectId, filePath);
					if (result.success) {
						console.log(`✅ Saved project to ${filePath}`);
						undoRedoActions.markProjectAsSaved(projectId);
					} else {
						console.error('Save failed:', result.error);
					}
				} else {
					await this.handleSaveAs(projectId);
				}
			} else {
				// Web environment - always download
				const result = await this.saveProject(projectId);
				
				if (result.error) {
					console.error('Save failed:', result.error);
					return;
				}
				
				if (!result.data) {
					console.error('Save failed: No data returned');
					return;
				}
				
				const project = get(projects).find(p => p.id === projectId);
				const defaultFileName = `${project?.name || 'project'}.bf`;
				
				const blob = new Blob([new Uint8Array(result.data)], { type: 'application/octet-stream' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = defaultFileName;
				
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				console.log(`✅ Saved project to ${defaultFileName}`);
				undoRedoActions.markProjectAsSaved(projectId);
			}
		} catch (error) {
			console.error('Save failed:', error);
		}
	}

	/**
	 * 处理另存为操作
	 */
	async handleSaveAs(projectId: number): Promise<void> {
		const { platformService } = await import('./platformService');
		const { undoRedoActions } = await import('./undoRedoService');
		
		try {
			const result = await this.saveProject(projectId);
			
			if (result.error) {
				console.error('Save failed:', result.error);
				return;
			}
			
			if (!result.data) {
				console.error('Save failed: No data returned');
				return;
			}
			
			const project = get(projects).find(p => p.id === projectId);
			const defaultFileName = `${project?.name || 'project'}.bf`;
			
			if (platformService.isTauri()) {
				const { save } = await import('@tauri-apps/plugin-dialog');
				
				const filePath = await save({
					defaultPath: defaultFileName,
					filters: [{
						name: 'BubbleFish Project',
						extensions: ['bf']
					}]
				});
				
				if (filePath) {
					const saveResult = await this.saveProjectToPath(projectId, filePath);
					if (saveResult.success) {
						console.log(`✅ Saved project to ${filePath}`);
						undoRedoActions.markProjectAsSaved(projectId);
					} else {
						console.error('Save failed:', saveResult.error);
					}
				}
			} else {
				// Web environment
				const blob = new Blob([new Uint8Array(result.data)], { type: 'application/octet-stream' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = defaultFileName;
				
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				console.log(`✅ Saved project to ${defaultFileName}`);
				undoRedoActions.markProjectAsSaved(projectId);
			}
		} catch (error) {
			console.error('Save as failed:', error);
		}
	}

	/**
	 * 处理导出Labelplus格式
	 */
	async handleExportLabelplus(projectId: number): Promise<void> {
		const { platformService } = await import('./platformService');
		
		try {
			const result = await this.exportLabelplusData(projectId);
			
			if (result.error) {
				console.error('Export failed:', result.error);
				return;
			}
			
			if (!result.content) {
				console.error('Export failed: No content returned');
				return;
			}
			
			const project = get(projects).find(p => p.id === projectId);
			const defaultFileName = `${project?.name || 'project'}_labelplus.txt`;
			
			if (platformService.isTauri()) {
				const { save } = await import('@tauri-apps/plugin-dialog');
				const { writeTextFile } = await import('@tauri-apps/plugin-fs');
				
				const filePath = await save({
					defaultPath: defaultFileName,
					filters: [{
						name: 'LabelPlus Translation File',
						extensions: ['txt']
					}]
				});
				
				if (filePath) {
					await writeTextFile(filePath, result.content);
					console.log(`✅ Exported project to ${filePath}`);
				}
			} else {
				// Web environment
				const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = defaultFileName;
				
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				console.log(`✅ Exported project to ${defaultFileName}`);
			}
		} catch (error) {
			console.error('Export failed:', error);
		}
	}

	/**
	 * 添加图片（从路径）
	 */
	async addImageFromPath(projectId: number, filePath: string): Promise<number | null> {
		return coreAPI.addImageFromPath(projectId, filePath);
	}

	/**
	 * 添加图片（从二进制数据）
	 */
	async addImageFromBinary(projectId: number, format: ImageFormat, data: Uint8Array, imageName: string): Promise<number | null> {
		return coreAPI.addImageFromBinary(projectId, format, data, imageName);
	}

	/**
	 * 刷新临时项目图片
	 */
	async flushOpeningProjectImages(projectId: number): Promise<void> {
		await coreAPI.flushOpeningProjectImages(projectId);
	}

	/**
	 * 完成临时项目
	 */
	async finalizeOpeningProject(projectId: number): Promise<boolean> {
		return coreAPI.finalizeOpeningProject(projectId);
	}

	/**
	 * 创建空的临时项目
	 */
	async createEmptyOpeningProject(projectName: string): Promise<number | null> {
		return coreAPI.createEmptyOpeningProject(projectName);
	}

	/**
	 * 验证 Labelplus 文件
	 */
	async validateLabelplusFile(content: string): Promise<{ error?: string }> {
		return coreAPI.validateLabelplusFile(content);
	}
}

export const projectService = ProjectService.getInstance();
