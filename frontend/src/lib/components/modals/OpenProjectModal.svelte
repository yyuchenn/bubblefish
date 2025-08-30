<script lang="ts">
	import { projectService } from '$lib/services/projectService';
	import { platformService } from '$lib/services/platformService';
	import Modal from './Modal.svelte';
	import FileUpload from '../FileUpload.svelte';
	import type { OpeningProjectInfo, ImageFile, ImageFormat } from '$lib/types';

	interface Props {
		visible?: boolean;
		onSuccess?: (detail: { projectId: number; projectName: string; imageCount: number }) => void;
		onCancel?: () => void;
	}

	let { 
		visible = false,
		onSuccess,
		onCancel
	}: Props = $props();

	function getImageFormat(mimeType: string): ImageFormat {
		switch (mimeType) {
			case 'image/jpeg':
			case 'image/jpg':
				return 'Jpeg';
			case 'image/png':
				return 'Png';
			case 'image/gif':
				return 'Gif';
			case 'image/webp':
				return 'Webp';
			case 'image/bmp':
				return 'Bmp';
			default:
				// 默认假设为PNG
				return 'Png';
		}
	}

	// 状态管理
	type Step = 'upload-project' | 'auto-scanning' | 'upload-images' | 'finalizing';
	let currentStep = $state<Step>('upload-project');
	
	// 项目文件相关
	let projectFile = $state<File | null>(null);
	let projectFilePath = $state<string | null>(null); // Tauri环境下的文件路径
	let projectName = $state('');
	let enableAutoScan = $state(true); // 是否启用自动扫描
	
	// 项目相关
	let tempProjectId = $state<number | null>(null);
	let projectInfo = $state<OpeningProjectInfo | null>(null);
	
	// 图片加载相关
	let selectedImages = $state<ImageFile[]>([]);
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let autoDetectedImages = $state<string[]>([]);
	let isAutoScanning = $state(false);
	let isAutoUploading = $state(false);
	let autoUploadProgress = $state(0);
	
	// 错误处理
	let error = $state('');

	$effect(() => {
		return () => {
			// 组件卸载时清理临时项目
			if (tempProjectId && currentStep !== 'finalizing') {
				projectService.deleteOpeningProject(tempProjectId);
			}
		};
	});

	function handleProjectFileSelected(detail: {file?: File, path?: string, fileName?: string}) {
		if (detail.file) {
			// Web环境
			projectFile = detail.file;
			projectName = detail.file.name.replace(/\.(txt|lp|bf)$/i, '');
		} else if (detail.path && detail.fileName) {
			// Tauri环境
			projectFilePath = detail.path;
			projectName = detail.fileName.replace(/\.(txt|lp|bf)$/i, '');
		}
		
		error = '';
	}
	
	function handleProjectFileError(message: string) {
		error = message;
	}

	async function handleParseProjectFile() {
		// 检查是否有文件或路径
		if (platformService.isTauri()) {
			if (!projectFilePath || !projectName) {
				error = '请先选择项目文件';
				return;
			}
		} else {
			if (!projectFile || !projectName) {
				error = '请先选择项目文件';
				return;
			}
		}

		error = '';
		
		try {
			// 创建临时项目并解析文件
			if (platformService.isTauri() && projectFilePath) {
				// Tauri环境: 直接使用文件路径
				tempProjectId = await projectService.createOpeningProjectFromPath(
					projectFilePath,
					projectName
				);
			} else if (projectFile) {
				// Web环境: 读取文件为二进制数据
				const arrayBuffer = await projectFile.arrayBuffer();
				const data = new Uint8Array(arrayBuffer);
				// 获取文件扩展名
				const fileName = projectFile.name;
				const extension = fileName.split('.').pop()?.toLowerCase() || 'txt';
				tempProjectId = await projectService.createOpeningProjectFromBinary(
					data,
					extension,
					projectName
				);
			} else {
				throw new Error('无效的文件');
			}

			if (!tempProjectId) {
				throw new Error('创建临时项目失败');
			}

			// 获取项目信息
			projectInfo = await projectService.getOpeningProjectInfo(tempProjectId) as OpeningProjectInfo | null;
			
			if (!projectInfo) {
				throw new Error('获取项目信息失败');
			}

			// 如果是 Tauri 环境且启用了自动扫描且有待加载图片，先尝试自动扫描
			if (platformService.isTauri() && projectFilePath && enableAutoScan && projectInfo.pendingImages.length > 0) {
				// 进入自动扫描步骤
				currentStep = 'auto-scanning';
				await handleAutoScanAndUpload();
			} else {
				// 直接进入手动上传步骤
				currentStep = 'upload-images';
				selectedImages = []; // 重置选择的图片
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '解析项目文件失败';
			
			// 清理失败的临时项目
			if (tempProjectId) {
				await projectService.deleteOpeningProject(tempProjectId);
				tempProjectId = null;
			}
		}
	}

	async function handleAutoScanAndUpload() {
		if (!platformService.isTauri() || !projectFilePath || !projectInfo || !tempProjectId) {
			currentStep = 'upload-images';
			return;
		}

		isAutoScanning = true;
		error = '';

		try {
			// 获取项目文件所在目录
			const directoryPath = projectFilePath.substring(0, projectFilePath.lastIndexOf('/'));
			
			// 扫描目录中的图片文件
			const { tauriAPI } = await import('$lib/core/tauri');
			autoDetectedImages = await tauriAPI.scanDirectoryForImages(
				directoryPath,
				projectInfo.pendingImages
			);

			isAutoScanning = false;

			if (autoDetectedImages.length > 0) {
				// 开始自动上传
				isAutoUploading = true;
				autoUploadProgress = 0;

				let uploadedCount = 0;
				const totalImages = autoDetectedImages.length;

				for (let i = 0; i < autoDetectedImages.length; i++) {
					const imagePath = autoDetectedImages[i];
					autoUploadProgress = ((i + 1) / totalImages) * 100;

					try {
						console.log(`📁 自动上传图片: ${imagePath}`);
						const imageId = await projectService.addImageFromPath(
							tempProjectId,
							imagePath
						);

						if (imageId) {
							uploadedCount++;
						}
					} catch (err) {
						console.error(`自动上传图片 ${imagePath} 失败:`, err);
					}
				}

				// 刷新项目图片列表
				await projectService.flushOpeningProjectImages(tempProjectId);

				// 重新获取项目信息
				projectInfo = await projectService.getOpeningProjectInfo(tempProjectId) as OpeningProjectInfo | null;

				isAutoUploading = false;
				autoUploadProgress = 0;

				if (uploadedCount > 0) {
					console.log(`✅ 自动上传完成，成功加载 ${uploadedCount} 张图片`);
				}
			}

			// 检查是否所有图片都已加载
			if (projectInfo?.isComplete) {
				// 自动进入完成阶段
				await handleFinalizeProject();
			} else {
				// 还有未加载的图片，进入手动上传步骤
				currentStep = 'upload-images';
				selectedImages = [];
			}
		} catch (err) {
			isAutoScanning = false;
			isAutoUploading = false;
			error = err instanceof Error ? err.message : '自动扫描图片失败';
			// 继续到手动上传步骤
			currentStep = 'upload-images';
		}
	}

	function handleImagesSelected(files: ImageFile[]) {
		selectedImages = files;
		error = '';
	}

	async function handleUploadImages() {
		if (!tempProjectId || selectedImages.length === 0) {
			error = '请选择要加载的图片';
			return;
		}

		isUploading = true;
		error = '';
		uploadProgress = 0;

		try {
			let uploadedCount = 0;
			const totalImages = selectedImages.length;

			// 批量加载所有选中的图片，后端会自动匹配
			for (let i = 0; i < selectedImages.length; i++) {
				const file = selectedImages[i];
				uploadProgress = ((i + 1) / totalImages) * 100;

				try {
					// 如果有文件路径（Tauri桌面版），直接使用路径加载
					if (file.path) {
						console.log(`📁 Uploading image via file path: ${file.path}`);
						const imageId = await projectService.addImageFromPath(
							tempProjectId,
							file.path
						);

						if (imageId) {
							uploadedCount++;
						}
					} else if (file.file) {
						// Web版本：将File对象转换为Uint8Array
						console.log(`📦 Uploading image via binary data: ${file.name}`);
						const arrayBuffer = await file.file.arrayBuffer();
						const uint8Array = new Uint8Array(arrayBuffer);
						
						// 从MIME类型推断格式
						const format = getImageFormat(file.type);
						
						// 加载图片，使用文件名作为图片名称
						const imageId = await projectService.addImageFromBinary(
							tempProjectId,
							format,
							uint8Array,
							file.name
						);

						if (imageId) {
							uploadedCount++;
						}
					}
				} catch (err) {
					console.error(`加载图片 ${file.name} 失败:`, err);
				}
			}

			// 刷新项目图片列表，后端会自动匹配和清理
			await projectService.flushOpeningProjectImages(tempProjectId);

			// 重新获取项目信息以更新待加载列表
			projectInfo = await projectService.getOpeningProjectInfo(tempProjectId) as OpeningProjectInfo | null;

			// 清空已选择的图片
			selectedImages = [];

			if (uploadedCount > 0) {
				console.log(`成功加载 ${uploadedCount} 张图片`);
			}

			// 检查是否所有图片都已加载
			if (projectInfo?.isComplete) {
				// 自动进入完成阶段
				await handleFinalizeProject();
			} else if (projectInfo?.pendingImages.length === 0) {
				error = '加载的图片都不在项目需求列表中';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '加载图片失败';
		} finally {
			isUploading = false;
			uploadProgress = 0;
		}
	}

	async function handleFinalizeProject() {
		if (!tempProjectId) return;

		currentStep = 'finalizing';
		error = '';

		try {
			// 将临时项目转为正式项目
			const success = await projectService.finalizeOpeningProject(tempProjectId);

			if (success) {
				onSuccess?.({
					projectId: tempProjectId,
					projectName: projectInfo?.projectName || projectName,
					imageCount: projectInfo?.uploadedImages.length || 0
				});
			} else {
				throw new Error('项目转正失败');
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '创建项目失败';
			currentStep = 'upload-images';
		}
	}

	function handleCancel() {
		// 删除临时项目
		if (tempProjectId && currentStep !== 'finalizing') {
			projectService.deleteOpeningProject(tempProjectId);
		}
		onCancel?.();
	}

	const canFinalize = $derived(projectInfo?.isComplete || false);
	const pendingCount = $derived(projectInfo?.pendingImages.length || 0);
	const uploadedCount = $derived(projectInfo?.uploadedImages.length || 0);
</script>

<Modal {visible} onClose={handleCancel}>
	<div class="mb-5">
		<h2 class="text-xl font-semibold text-theme-on-surface">打开项目</h2>
	</div>

	{#if currentStep === 'upload-project'}
		<div class="mb-5 min-w-[400px]">
			<p class="text-theme-on-surface-variant mb-5 text-sm">选择项目文件以导入</p>
			
			<FileUpload
				disabled={false}
				fileType="project"
				selectedFile={projectFile}
				selectedFilePath={projectFilePath}
				showSelectedFile={true}
				onFileSelected={handleProjectFileSelected}
				onError={handleProjectFileError}
			/>

			{#if platformService.isTauri() && projectFilePath}
				<div class="mt-4 p-3 bg-theme-surface-variant rounded-lg">
					<label class="flex items-center gap-3 cursor-pointer">
						<input
							type="checkbox"
							bind:checked={enableAutoScan}
							class="w-4 h-4 rounded border-theme-outline text-theme-primary focus:ring-2 focus:ring-theme-primary focus:ring-offset-0 cursor-pointer"
						/>
						<span class="text-sm text-theme-on-surface-variant select-none">
							自动扫描并添加项目文件同目录下的图片
						</span>
					</label>
					<p class="text-xs text-theme-on-surface-variant mt-2 ml-7">
						启用后将自动查找并添加项目所需的图片文件
					</p>
				</div>
			{/if}

			{#if error}
				<div class="p-2 mb-3 bg-theme-error-container border border-theme-error rounded">
					<p class="text-sm text-theme-on-error-container">{error}</p>
				</div>
			{/if}
		</div>

		<div class="flex justify-end gap-3 pt-4 border-t border-theme-outline">
			<button 
				class="bg-theme-surface-variant text-theme-on-surface-variant hover:bg-theme-surface-container hover:text-theme-on-surface rounded px-6 py-2 text-sm font-medium transition-colors"
				onclick={handleCancel}
			>
				取消
			</button>
			<button 
				class="bg-theme-primary text-theme-on-primary rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
				onclick={handleParseProjectFile}
				disabled={!projectFilePath && !projectFile}
			>
				下一步
			</button>
		</div>
	{:else if currentStep === 'auto-scanning'}
		<div class="mb-5 min-w-[400px]">
			<div class="flex flex-col items-center justify-center py-10">
				{#if isAutoScanning}
					<div class="w-10 h-10 border-3 border-theme-outline border-t-theme-primary rounded-full animate-spin"></div>
					<p class="mt-4 text-theme-on-surface-variant text-sm">正在扫描项目目录中的图片...</p>
				{:else if isAutoUploading}
					<div class="w-full">
						<p class="text-theme-on-surface mb-3 text-center">正在自动上传检测到的图片</p>
						<div class="h-2 bg-theme-surface-variant rounded-full overflow-hidden">
							<div class="h-full bg-theme-primary transition-all duration-300" style="width: {autoUploadProgress}%"></div>
						</div>
						<p class="text-xs text-theme-on-surface-variant text-center mt-2">{Math.round(autoUploadProgress)}%</p>
					</div>
				{:else}
					<p class="text-theme-on-surface-variant">处理中...</p>
				{/if}
			</div>
			
			{#if autoDetectedImages.length > 0 && !isAutoScanning}
				<div class="mt-4 p-3 bg-theme-surface-variant rounded-md">
					<p class="text-sm text-theme-on-surface mb-2">检测到 {autoDetectedImages.length} 张图片：</p>
					<ul class="text-xs text-theme-on-surface-variant max-h-32 overflow-y-auto">
						{#each autoDetectedImages as imagePath}
							<li class="truncate" title={imagePath}>{imagePath.split('/').pop()}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{:else if currentStep === 'upload-images'}
		<div class="mb-5 min-w-[400px]">
			<div class="p-4 bg-theme-surface-variant rounded-lg mb-5">
				<h3 class="text-lg font-medium text-theme-on-surface mb-3">{projectInfo?.projectName}</h3>
				<div class="grid grid-cols-3 gap-4">
					<div class="flex flex-col gap-1">
						<span class="text-xs text-theme-on-surface-variant uppercase tracking-wider">需要图片：</span>
						<span class="text-xl font-semibold text-theme-on-surface">{projectInfo?.requiredImages.length || 0}</span>
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-xs text-theme-on-surface-variant uppercase tracking-wider">已加载：</span>
						<span class="text-xl font-semibold text-theme-primary">{uploadedCount}</span>
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-xs text-theme-on-surface-variant uppercase tracking-wider">待加载：</span>
						<span class="text-xl font-semibold text-theme-secondary">{pendingCount}</span>
					</div>
				</div>
			</div>

			{#if !canFinalize}
				<div class="my-5">
					<h4 class="text-base font-medium text-theme-on-surface mb-2">加载图片</h4>
					<p class="text-sm text-theme-on-surface-variant mb-4">
						选择项目需要的图片，系统会自动匹配文件名
					</p>
					
					<FileUpload 
						onFilesSelected={handleImagesSelected}
						accept="image/*"
						multiple={true}
						disabled={isUploading}
						fileType="image"
					/>
					
					{#if selectedImages.length > 0}
						<div class="mt-3 text-sm text-theme-on-surface-variant">
							已选择 {selectedImages.length} 个文件
						</div>
					{/if}

					{#if pendingCount > 0}
						<details class="mt-4 p-3 bg-theme-surface-variant rounded-md">
							<summary class="cursor-pointer font-medium text-theme-on-surface select-none">查看待加载图片列表 ({pendingCount})</summary>
							<ul class="mt-3 pl-5 max-h-[200px] overflow-y-auto">
								{#each projectInfo?.pendingImages || [] as imageName (imageName)}
									<li class="my-1 text-theme-on-surface-variant">{imageName}</li>
								{/each}
							</ul>
						</details>
					{/if}
				</div>
			{:else}
				<div class="p-4 bg-theme-primary-container border border-theme-primary rounded-md text-center my-5">
					<p class="text-theme-on-primary-container">✅ 所有图片已加载完成，可以创建项目了</p>
				</div>
			{/if}

			{#if uploadedCount > 0}
				<details class="mt-4 p-3 bg-theme-surface-variant rounded-md">
					<summary class="cursor-pointer font-medium text-theme-on-surface select-none">已加载图片 ({uploadedCount})</summary>
					<ul class="mt-3 pl-5 max-h-[200px] overflow-y-auto">
						{#each projectInfo?.uploadedImages || [] as imageName (imageName)}
							<li class="my-1 text-theme-primary">✓ {imageName}</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if isUploading}
				<div class="mt-4">
					<div class="h-1 bg-theme-surface-variant rounded-full overflow-hidden mb-1.5">
						<div class="h-full bg-theme-primary transition-all duration-300" style="width: {uploadProgress}%"></div>
					</div>
					<span class="block text-xs text-theme-on-surface-variant">加载中... {Math.round(uploadProgress)}%</span>
				</div>
			{/if}

			{#if error}
				<div class="p-2 mt-3 bg-theme-error-container border border-theme-error rounded">
					<p class="text-sm text-theme-on-error-container">{error}</p>
				</div>
			{/if}
		</div>

		<div class="flex justify-end gap-3 pt-4 border-t border-theme-outline">
			<button 
				class="bg-theme-surface-variant text-theme-on-surface-variant rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-surface-container enabled:hover:text-theme-on-surface"
				onclick={handleCancel} 
				disabled={isUploading}
			>
				取消
			</button>
			{#if !canFinalize}
				<button 
					class="bg-theme-primary text-theme-on-primary rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
					onclick={handleUploadImages}
					disabled={isUploading || selectedImages.length === 0}
				>
					{isUploading ? '加载中...' : '加载图片'}
				</button>
			{:else}
				<button 
					class="bg-theme-primary text-theme-on-primary rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
					onclick={handleFinalizeProject}
					disabled={isUploading}
				>
					创建项目
				</button>
			{/if}
		</div>
	{:else if currentStep === 'finalizing'}
		<div class="mb-5">
			<div class="flex flex-col items-center justify-center py-10">
				<div class="w-10 h-10 border-3 border-theme-outline border-t-theme-primary rounded-full animate-spin"></div>
				<p class="mt-4 text-theme-on-surface-variant text-sm">正在创建项目...</p>
			</div>
		</div>
	{/if}
</Modal>

