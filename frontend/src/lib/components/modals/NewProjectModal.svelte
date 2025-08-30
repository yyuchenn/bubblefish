<script lang="ts">
	import { projectService } from '$lib/services/projectService';
	import Modal from './Modal.svelte';
	import FileUpload from '../FileUpload.svelte';
	import type { ImageFile, ImageFormat } from '$lib/types';

	interface Props {
		visible?: boolean;
		defaultName?: string;
		onSuccess?: (data: { projectId: number; projectName: string; imageCount: number }) => void;
		onCancel?: () => void;
	}

	let { 
		visible = false, 
		defaultName = '',
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

	let projectName = $state(defaultName);
	let selectedFiles = $state<ImageFile[]>([]);
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let tempProjectId = $state<number | null>(null);
	let error = $state('');
	
	// Drag and drop state
	let draggedIndex: number | null = null;
	let draggedElement: HTMLElement | null = null;
	let draggedClone: HTMLElement | null = null;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let elementStartX = 0;
	let elementStartY = 0;
	let activePointerId: number | null = null;
	
	// Track the original order and if order has changed
	let originalIndex: number | null = null;
	let originalFiles: ImageFile[] | null = null;
	// Temporary order during dragging
	let tempDragOrder = $state<ImageFile[] | null>(null);
	
	// Display files: use temp order during drag, otherwise use selectedFiles
	let displayFiles = $derived(tempDragOrder || selectedFiles);
	
	// Auto-scroll references and state
	let scrollContainer: HTMLElement | null = $state(null);
	let autoScrollInterval: number | null = null;
	
	// Cache for preview URLs to avoid recreating them
	const previewUrlCache = $state(new Map<ImageFile, string>());

	function handleFilesSelected(files: ImageFile[]) {
		// Append new files to existing ones instead of replacing
		selectedFiles = [...selectedFiles, ...files];
		// Clear temp drag order when new files are added
		tempDragOrder = null;
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
				onSuccess?.({
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
		onCancel?.();
	}
	
	// Sort files by name
	function sortFilesByName() {
		const sortedFiles = [...displayFiles].sort((a, b) => 
			a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
		);
		
		// Check if order actually changed
		const originalNames = displayFiles.map(f => f.name);
		const sortedNames = sortedFiles.map(f => f.name);
		
		// Compare arrays to see if order changed
		const orderChanged = originalNames.some((name, index) => name !== sortedNames[index]);
		
		if (orderChanged) {
			selectedFiles = sortedFiles;
			tempDragOrder = null;
		}
	}
	
	// Remove a file from the list
	function removeFile(index: number) {
		const fileToRemove = displayFiles[index];
		// Clean up preview URL if it's a blob URL
		const cachedUrl = previewUrlCache.get(fileToRemove);
		if (cachedUrl && cachedUrl.startsWith('blob:')) {
			URL.revokeObjectURL(cachedUrl);
			previewUrlCache.delete(fileToRemove);
		}
		selectedFiles = selectedFiles.filter(f => f !== fileToRemove);
		tempDragOrder = null;
	}
	
	// Handle pointer down for drag start
	function handlePointerDown(event: PointerEvent, index: number) {
		// Completely disable drag when uploading
		if (isUploading) {
			event.preventDefault();
			return;
		}
		
		const target = event.currentTarget as HTMLElement;
		
		// Clean up any existing drag state first
		cleanupDragState();
		
		draggedIndex = index;
		originalIndex = index;  // Store the original index
		originalFiles = [...selectedFiles];  // Store the original order
		tempDragOrder = [...selectedFiles];  // Initialize temp order for dragging
		draggedElement = target.parentElement as HTMLElement;
		activePointerId = event.pointerId;
		
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
		
		// Add global listeners to handle pointer events
		document.addEventListener('pointermove', handleGlobalPointerMove);
		document.addEventListener('pointerup', handleGlobalPointerUp);
		document.addEventListener('pointercancel', handleGlobalPointerUp);
		
		// Prevent text selection
		event.preventDefault();
	}
	
	// Handle global pointer move for dragging
	function handleGlobalPointerMove(event: PointerEvent) {
		// Only handle events for our active pointer
		if (event.pointerId !== activePointerId) return;
		
		// Disable dragging when uploading
		if (isUploading) {
			cleanupDragState();
			return;
		}
		
		if (draggedClone && draggedIndex !== null) {
			const deltaX = event.clientX - pointerStartX;
			const deltaY = event.clientY - pointerStartY;
			
			draggedClone.style.left = (elementStartX + deltaX) + 'px';
			draggedClone.style.top = (elementStartY + deltaY) + 'px';
			
			// Auto-scroll logic
			handleAutoScroll(event.clientY);
			
			// Find the element under the pointer (excluding the clone)
			draggedClone.style.pointerEvents = 'none';
			const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
			
			if (elementBelow) {
				const itemBelow = elementBelow.closest('[data-sortable-item]');
				if (itemBelow) {
					const itemBelowIndex = parseInt(itemBelow.getAttribute('data-index') || '0');
					
					if (itemBelowIndex !== draggedIndex && tempDragOrder) {
						// Update temp order locally (not in store)
						const newTempOrder = [...tempDragOrder];
						const [removed] = newTempOrder.splice(draggedIndex, 1);
						newTempOrder.splice(itemBelowIndex, 0, removed);
						tempDragOrder = newTempOrder;
						
						// Track the new index
						draggedIndex = itemBelowIndex;
						// Note: draggedElement reference is kept but DOM element may change
					}
				}
			}
		}
	}
	
	// Handle global pointer up for drag end
	function handleGlobalPointerUp(event: PointerEvent) {
		// Only handle events for our active pointer
		if (event.pointerId !== activePointerId) return;
		
		// Check if order actually changed
		if (originalIndex !== null && draggedIndex !== null && originalIndex !== draggedIndex && originalFiles) {
			// Calculate the final reordered array
			const finalFiles = [...originalFiles];
			const [movedItem] = finalFiles.splice(originalIndex, 1);
			finalFiles.splice(draggedIndex, 0, movedItem);
			
			// Update the selected files with the new order
			selectedFiles = finalFiles;
		}
		// If order hasn't changed, do nothing (UI is already correct)
		
		cleanupDragState();
	}
	
	// Handle auto-scroll during drag
	function handleAutoScroll(pointerY: number) {
		if (!scrollContainer) return;
		
		const rect = scrollContainer.getBoundingClientRect();
		const scrollZoneSize = 50; // Size of the auto-scroll zone
		const scrollSpeed = 5; // Pixels to scroll per frame
		
		// Clear existing interval
		if (autoScrollInterval) {
			clearInterval(autoScrollInterval);
			autoScrollInterval = null;
		}
		
		// Check if pointer is in top scroll zone
		if (pointerY < rect.top + scrollZoneSize) {
			const intensity = 1 - (pointerY - rect.top) / scrollZoneSize;
			autoScrollInterval = window.setInterval(() => {
				if (scrollContainer) {
					scrollContainer.scrollTop -= scrollSpeed * (1 + intensity * 2);
				}
			}, 16); // ~60fps
		}
		// Check if pointer is in bottom scroll zone
		else if (pointerY > rect.bottom - scrollZoneSize) {
			const intensity = 1 - (rect.bottom - pointerY) / scrollZoneSize;
			autoScrollInterval = window.setInterval(() => {
				if (scrollContainer) {
					scrollContainer.scrollTop += scrollSpeed * (1 + intensity * 2);
				}
			}, 16); // ~60fps
		}
	}
	
	// Stop auto-scroll
	function stopAutoScroll() {
		if (autoScrollInterval) {
			clearInterval(autoScrollInterval);
			autoScrollInterval = null;
		}
	}
	
	// Clean up drag state
	function cleanupDragState() {
		// Remove global event listeners
		document.removeEventListener('pointermove', handleGlobalPointerMove);
		document.removeEventListener('pointerup', handleGlobalPointerUp);
		document.removeEventListener('pointercancel', handleGlobalPointerUp);
		
		// Remove clone
		if (draggedClone && draggedClone.parentNode) {
			try {
				document.body.removeChild(draggedClone);
			} catch (_e) {
				// Ignore if already removed
			}
			draggedClone = null;
		}
		
		// Reset element opacity - find element by index since DOM may have changed
		if (draggedIndex !== null && scrollContainer) {
			const items = scrollContainer.querySelectorAll('[data-sortable-item]');
			items.forEach(item => {
				(item as HTMLElement).style.opacity = '1';
			});
		}
		draggedElement = null;
		
		// Reset drag index and tracking variables
		draggedIndex = null;
		originalIndex = null;
		originalFiles = null;
		tempDragOrder = null;  // Clear temp order to use selectedFiles again
		activePointerId = null;
		
		// Stop auto-scroll
		stopAutoScroll();
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
	$effect(() => {
		return () => {
			// Clean up any active drag state when component unmounts
			cleanupDragState();
			// Make sure to stop auto-scroll
			stopAutoScroll();
			// Clean up all blob URLs
			for (const [, url] of previewUrlCache.entries()) {
				if (url.startsWith('blob:')) {
					URL.revokeObjectURL(url);
				}
			}
			previewUrlCache.clear();
		};
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
					onFilesSelected={handleFilesSelected}
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
							已选择 {displayFiles.length} 个文件{#if !isUploading}（拖拽排序）{/if}
						</div>
						<button
							type="button"
							class="px-3 py-1 text-xs bg-theme-surface-variant text-theme-on-surface-variant rounded hover:bg-theme-surface-container transition-colors"
							onclick={sortFilesByName}
							disabled={isUploading}
						>
							按文件名排序
						</button>
					</div>
					
					<div bind:this={scrollContainer} class="max-h-64 overflow-y-auto border border-theme-outline rounded p-2 bg-theme-surface {isUploading ? 'opacity-60' : ''}">
						<div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
							{#each displayFiles as file, index (file)}
								<div 
									data-sortable-item
									data-index={index}
									class="relative group bg-theme-surface-variant rounded p-1 select-none {isUploading ? 'cursor-not-allowed' : 'cursor-move'}"
								>
									<div 
										class={isUploading ? 'pointer-events-none' : 'touch-none'}
										onpointerdown={(e) => handlePointerDown(e, index)}
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
										onclick={() => removeFile(index)}
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
			onclick={handleCancel} 
			disabled={isUploading}
		>
			取消
		</button>
		<button 
			class="bg-theme-primary text-theme-on-primary rounded px-6 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
			onclick={handleCreateProject} 
			disabled={isUploading || !projectName.trim() || selectedFiles.length === 0}
		>
			{isUploading ? '创建中...' : '创建项目'}
		</button>
	</div>
	</div>
</Modal>

