<script lang="ts">
	import { createEventDispatcher, onDestroy } from 'svelte';
	import { projectService } from '$lib/services/projectService';
	import Modal from './Modal.svelte';
	import FileUpload from '../FileUpload.svelte';
	import type { ImageFile, ImageFormat } from '$lib/types';

	export let visible: boolean = false;
	export let defaultName: string = '';

	const dispatch = createEventDispatcher();

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

	let projectName = defaultName;
	let selectedFiles: ImageFile[] = [];
	let isUploading = false;
	let uploadProgress = 0;
	let tempProjectId: number | null = null;
	let error: string = '';
	
	// Drag and drop state
	let draggedIndex: number | null = null;
	let draggedElement: HTMLElement | null = null;
	let draggedClone: HTMLElement | null = null;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let elementStartX = 0;
	let elementStartY = 0;
	
	// Cache for preview URLs to avoid recreating them
	let previewUrlCache = new Map<ImageFile, string>();

	function handleFilesSelected(event: CustomEvent<ImageFile[]>) {
		// Append new files to existing ones instead of replacing
		selectedFiles = [...selectedFiles, ...event.detail];
		error = '';
	}

	async function handleCreateProject() {
		if (!projectName.trim()) {
			error = '请输入项目名称';
			return;
		}

		if (selectedFiles.length === 0) {
			error = '请选择至少一张图片';
			return;
		}

		isUploading = true;
		error = '';

		try {
			// 创建一个空的临时项目
			tempProjectId = await projectService.createEmptyOpeningProject(projectName);

			if (!tempProjectId) {
				throw new Error('创建临时项目失败');
			}

			// 加载图片
			let successCount = 0;
			for (let i = 0; i < selectedFiles.length; i++) {
				const file = selectedFiles[i];
				uploadProgress = ((i + 1) / selectedFiles.length) * 100;

				try {
					let imageId: number | null = null;
					
					// 如果有文件路径（Tauri桌面版），直接使用路径加载
					if ('path' in file && file.path) {
						console.log(`📁 使用文件路径加载: ${file.path}`);
						imageId = await projectService.addImageFromPath(
							tempProjectId,
							file.path
						);
					} else if ('file' in file && file.file) {
						// Web版本：将File对象转换为Uint8Array
						console.log(`📦 使用二进制数据加载: ${file.name}`);
						const arrayBuffer = await file.file.arrayBuffer();
						const uint8Array = new Uint8Array(arrayBuffer);
						
						// 从MIME类型推断格式
						const format = getImageFormat(file.type);
						
						imageId = await projectService.addImageFromBinary(
							tempProjectId,
							format,
							uint8Array,
							file.name
						);
					}
					
					if (imageId) {
						successCount++;
					}
				} catch (err) {
					console.error(`加载图片 ${file.name} 失败:`, err);
				}
			}

			// 刷新临时项目的图片列表
			await projectService.flushOpeningProjectImages(tempProjectId);

			// 将临时项目转为正式项目
			const finalized = await projectService.finalizeOpeningProject(tempProjectId);
			
			if (finalized) {
				dispatch('success', {
					projectId: tempProjectId,
					projectName,
					imageCount: successCount
				});
			} else {
				throw new Error('项目创建失败');
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '创建项目失败';
			
			// 如果失败，删除临时项目
			if (tempProjectId) {
				await projectService.deleteOpeningProject(tempProjectId);
			}
		} finally {
			isUploading = false;
			uploadProgress = 0;
		}
	}

	function handleCancel() {
		dispatch('cancel');
	}
	
	// Sort files by name
	function sortFilesByName() {
		selectedFiles = [...selectedFiles].sort((a, b) => 
			a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
		);
	}
	
	// Remove a file from the list
	function removeFile(index: number) {
		const fileToRemove = selectedFiles[index];
		// Clean up preview URL if it's a blob URL
		const cachedUrl = previewUrlCache.get(fileToRemove);
		if (cachedUrl && cachedUrl.startsWith('blob:')) {
			URL.revokeObjectURL(cachedUrl);
			previewUrlCache.delete(fileToRemove);
		}
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
	}
	
	// Handle pointer down for drag start
	function handlePointerDown(event: PointerEvent, index: number) {
		// Completely disable drag when uploading
		if (isUploading) {
			event.preventDefault();
			return;
		}
		
		const target = event.currentTarget as HTMLElement;
		draggedIndex = index;
		draggedElement = target.parentElement as HTMLElement;
		
		// Create a clone for visual feedback
		draggedClone = draggedElement.cloneNode(true) as HTMLElement;
		draggedClone.style.position = 'fixed';
		draggedClone.style.pointerEvents = 'none';
		draggedClone.style.opacity = '0.8';
		draggedClone.style.zIndex = '9999';
		draggedClone.style.transform = 'scale(1.05)';
		draggedClone.style.width = draggedElement.offsetWidth + 'px';
		
		// Store initial positions
		pointerStartX = event.clientX;
		pointerStartY = event.clientY;
		const rect = draggedElement.getBoundingClientRect();
		elementStartX = rect.left;
		elementStartY = rect.top;
		
		// Position the clone at the element's current position
		draggedClone.style.left = elementStartX + 'px';
		draggedClone.style.top = elementStartY + 'px';
		
		document.body.appendChild(draggedClone);
		
		// Add opacity to original element
		draggedElement.style.opacity = '0.3';
		
		// Capture pointer for this element
		target.setPointerCapture(event.pointerId);
		
		// Prevent text selection
		event.preventDefault();
	}
	
	// Handle pointer move for dragging
	function handlePointerMove(event: PointerEvent) {
		// Disable dragging when uploading
		if (isUploading) return;
		
		if (draggedClone && draggedIndex !== null) {
			const deltaX = event.clientX - pointerStartX;
			const deltaY = event.clientY - pointerStartY;
			
			draggedClone.style.left = (elementStartX + deltaX) + 'px';
			draggedClone.style.top = (elementStartY + deltaY) + 'px';
			
			// Find the element under the pointer (excluding the clone)
			draggedClone.style.pointerEvents = 'none';
			const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
			
			if (elementBelow) {
				const itemBelow = elementBelow.closest('[data-sortable-item]');
				if (itemBelow && itemBelow !== draggedElement) {
					const itemBelowIndex = parseInt(itemBelow.getAttribute('data-index') || '0');
					
					if (itemBelowIndex !== draggedIndex) {
						// Reorder the array
						const newFiles = [...selectedFiles];
						const [removed] = newFiles.splice(draggedIndex, 1);
						newFiles.splice(itemBelowIndex, 0, removed);
						selectedFiles = newFiles;
						draggedIndex = itemBelowIndex;
					}
				}
			}
		}
	}
	
	// Handle pointer up for drag end
	function handlePointerUp(event: PointerEvent) {
		if (draggedClone) {
			document.body.removeChild(draggedClone);
			draggedClone = null;
		}
		
		if (draggedElement) {
			draggedElement.style.opacity = '1';
			draggedElement = null;
		}
		
		draggedIndex = null;
		
		// Release pointer capture
		const target = event.currentTarget as HTMLElement;
		target.releasePointerCapture(event.pointerId);
	}
	
	// Get image preview URL with caching
	function getImagePreview(file: ImageFile): string {
		// Check cache first
		if (previewUrlCache.has(file)) {
			return previewUrlCache.get(file)!;
		}
		
		let url = '';
		if (file.url) {
			// Tauri desktop version with converted URL
			url = file.url;
		} else if (file.file) {
			// Web version with File object
			url = URL.createObjectURL(file.file);
		}
		
		// Cache the URL
		if (url) {
			previewUrlCache.set(file, url);
		}
		
		return url;
	}
	
	// Clean up blob URLs when component is destroyed
	onDestroy(() => {
		// Clean up all blob URLs
		for (const [, url] of previewUrlCache.entries()) {
			if (url.startsWith('blob:')) {
				URL.revokeObjectURL(url);
			}
		}
		previewUrlCache.clear();
	});
</script>

<Modal {visible} onClose={handleCancel}>
	<div class="w-[500px] md:w-[600px] lg:w-[700px]">
		<div class="mb-5">
			<h2 class="text-xl font-semibold text-theme-on-surface">新建项目</h2>
		</div>
		
		<div class="mb-5">
		<div class="mb-4">
			<label for="project-name" class="block mb-1.5 text-sm font-medium text-theme-on-surface-variant">项目名称</label>
			<input
				id="project-name"
				type="text"
				bind:value={projectName}
				placeholder="输入项目名称"
				disabled={isUploading}
				class="w-full px-3 py-2 border border-theme-outline rounded bg-theme-surface text-theme-on-surface text-sm transition-colors focus:outline-none focus:border-theme-primary disabled:opacity-50 disabled:cursor-not-allowed"
			/>
		</div>

		<div class="mb-4">
			<div class="block mb-1.5 text-sm font-medium text-theme-on-surface-variant" id="file-upload-label">选择图片</div>
			<div aria-labelledby="file-upload-label">
				<FileUpload 
					on:filesSelected={handleFilesSelected}
					accept="image/*"
					multiple={true}
					disabled={isUploading}
					fileType="image"
				/>
			</div>
			
			{#if selectedFiles.length > 0}
				<div class="mt-4">
					<div class="flex items-center justify-between mb-2">
						<div class="text-sm text-theme-on-surface-variant">
							已选择 {selectedFiles.length} 个文件{#if !isUploading}（拖拽排序）{/if}
						</div>
						<button
							type="button"
							class="px-3 py-1 text-xs bg-theme-surface-variant text-theme-on-surface-variant rounded hover:bg-theme-surface-container transition-colors"
							on:click={sortFilesByName}
							disabled={isUploading}
						>
							按文件名排序
						</button>
					</div>
					
					<div class="max-h-64 overflow-y-auto border border-theme-outline rounded p-2 bg-theme-surface {isUploading ? 'opacity-60' : ''}">
						<div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
							{#each selectedFiles as file, index (file)}
								<div 
									data-sortable-item
									data-index={index}
									class="relative group bg-theme-surface-variant rounded p-1 select-none {isUploading ? 'cursor-not-allowed' : 'cursor-move'}"
								>
									<div 
										class="{isUploading ? 'pointer-events-none' : 'touch-none'}"
										on:pointerdown={(e) => handlePointerDown(e, index)}
										on:pointermove={handlePointerMove}
										on:pointerup={handlePointerUp}
										on:pointercancel={handlePointerUp}
									>
										<!-- Thumbnail -->
										<div class="w-full aspect-square bg-theme-surface rounded mb-1 overflow-hidden flex items-center justify-center">
											{#if getImagePreview(file)}
												<img 
													src={getImagePreview(file)} 
													alt={file.name}
													class="max-w-full max-h-full object-contain"
												/>
											{:else}
												<div class="text-theme-on-surface-variant text-xs">无预览</div>
											{/if}
										</div>
										
										<!-- File name -->
										<div class="text-[10px] leading-tight text-theme-on-surface-variant truncate" title={file.name}>
											{file.name}
										</div>
										
										<!-- Order number -->
										<div class="absolute top-0.5 left-0.5 w-4 h-4 bg-theme-primary text-theme-on-primary rounded-full flex items-center justify-center text-[10px] font-medium">
											{index + 1}
										</div>
									</div>
									
									<!-- Remove button -->
									<button
										type="button"
										class="absolute top-0.5 right-0.5 w-4 h-4 bg-theme-error text-theme-on-error rounded-full items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity hidden group-hover:flex"
										on:click={() => removeFile(index)}
										disabled={isUploading}
										title="移除图片"
									>
										×
									</button>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</div>

		{#if error}
			<div class="p-2 mb-3 bg-theme-error-container border border-theme-error rounded">
				<p class="text-sm text-theme-on-error-container">{error}</p>
			</div>
		{/if}

		{#if isUploading}
			<div class="mt-4">
				<div class="h-1 bg-theme-surface-variant rounded-full overflow-hidden mb-1.5">
					<div class="h-full bg-theme-primary transition-all duration-300" style="width: {uploadProgress}%"></div>
				</div>
				<span class="block text-xs text-theme-on-surface-variant">加载中... {Math.round(uploadProgress)}%</span>
			</div>
		{/if}
	</div>

	<div class="flex justify-end gap-3 pt-4 border-t border-theme-outline">
		<button 
			class="bg-theme-surface-variant text-theme-on-surface-variant rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-surface-container enabled:hover:text-theme-on-surface"
			on:click={handleCancel} 
			disabled={isUploading}
		>
			取消
		</button>
		<button 
			class="bg-theme-primary text-theme-on-primary rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
			on:click={handleCreateProject} 
			disabled={isUploading || !projectName.trim() || selectedFiles.length === 0}
		>
			{isUploading ? '创建中...' : '创建项目'}
		</button>
	</div>
	</div>
</Modal>

