<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { projectService, currentProject } from '$lib/services/projectService';
	import { imageService, images } from '$lib/services/imageService';
	import FileUpload from './FileUpload.svelte';
	import type { ImageFile, ImageFormat, ImageMetadata } from '$lib/types';
	
	let selectedFiles = $state<ImageFile[]>([]);
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let error = $state('');
	
	// Drag and drop state
	let draggedIndex: number | null = null;
	let draggedElement: HTMLElement | null = null;
	let draggedClone: HTMLElement | null = null;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let elementStartX = 0;
	let elementStartY = 0;
	
	// Track if drag operation is disabled globally
	let isDragDisabled = $state(false);
	
	// Track the original order and if order has changed
	let originalIndex: number | null = null;
	let originalImages: ImageMetadata[] | null = null;
	// Temporary order during dragging
	let tempDragOrder = $state<ImageMetadata[] | null>(null);
	
	// Display images: use temp order during drag, otherwise use store
	let displayImages = $derived(tempDragOrder || $images);
	
	// Auto-scroll references and state
	let scrollContainer: HTMLElement | null = $state(null);
	let autoScrollInterval: number | null = null;
	
	onMount(() => {
		// Disable drag when uploading
		isDragDisabled = isUploading;
	});
	
	onDestroy(() => {
		// Clean up any active drag state when component unmounts
		cleanupDragState();
		// Make sure to stop auto-scroll
		stopAutoScroll();
	});
	
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
	
	function handleFilesSelected(files: ImageFile[]) {
		selectedFiles = [...selectedFiles, ...files];
		error = '';
	}
	
	async function handleUploadImages() {
		if (!$currentProject) {
			error = '请先选择一个项目';
			return;
		}
		
		if (selectedFiles.length === 0) {
			error = '请选择至少一张图片';
			return;
		}
		
		isUploading = true;
		isDragDisabled = true;
		error = '';
		
		try {
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
							$currentProject.id,
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
							$currentProject.id,
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
			
			// 刷新项目的图片列表
			await projectService.flushOpeningProjectImages($currentProject.id);
			
			// 清空已选择的文件
			selectedFiles = [];
			
			// 刷新图片列表
			await imageService.refreshProjectImages($currentProject.id);
			
			if (successCount > 0) {
				console.log(`成功加载 ${successCount} 张图片`);
			} else {
				error = '图片加载失败';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '加载失败';
		} finally {
			isUploading = false;
			isDragDisabled = false;
			uploadProgress = 0;
		}
	}
	
	// Sort images by name
	async function sortImagesByName() {
		if (!$currentProject || displayImages.length === 0) return;
		
		const sortedImages = [...displayImages].sort((a, b) => {
			const nameA = a.name || '';
			const nameB = b.name || '';
			return nameA.localeCompare(nameB, 'zh-CN', { numeric: true });
		});
		
		// Check if order actually changed
		const originalIds = displayImages.map(img => img.id);
		const sortedIds = sortedImages.map(img => img.id);
		
		// Compare arrays to see if order changed
		const orderChanged = originalIds.some((id, index) => id !== sortedIds[index]);
		
		if (orderChanged) {
			// Only send reorder request if order actually changed
			await imageService.reorderImages($currentProject.id, sortedIds);
		}
	}
	
	// Remove an image
	async function removeImage(imageId: number) {
		if (!$currentProject) return;
		
		const confirmed = confirm('确定要删除这张图片吗？');
		if (!confirmed) return;
		
		await imageService.removeImage($currentProject.id, imageId);
	}
	
	// Handle pointer down for drag start
	function handlePointerDown(event: PointerEvent, index: number) {
		// Completely disable drag when uploading or globally disabled
		if (isUploading || isDragDisabled) {
			event.preventDefault();
			return;
		}
		
		const target = event.currentTarget as HTMLElement;
		
		// Clean up any existing drag state first
		cleanupDragState();
		
		draggedIndex = index;
		originalIndex = index;  // Store the original index
		originalImages = [...$images];  // Store the original order
		tempDragOrder = [...$images];  // Initialize temp order for dragging
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
		// Disable dragging when uploading or globally disabled
		if (isUploading || isDragDisabled) {
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
				if (itemBelow && itemBelow !== draggedElement) {
					const itemBelowIndex = parseInt(itemBelow.getAttribute('data-index') || '0');
					
					if (itemBelowIndex !== draggedIndex && tempDragOrder) {
						// Update temp order locally (not in store)
						const newTempOrder = [...tempDragOrder];
						const [removed] = newTempOrder.splice(draggedIndex, 1);
						newTempOrder.splice(itemBelowIndex, 0, removed);
						tempDragOrder = newTempOrder;
						
						// Track the new index
						draggedIndex = itemBelowIndex;
					}
				}
			}
		}
	}
	
	// Handle pointer up for drag end
	async function handlePointerUp(event: PointerEvent) {
		// Release pointer capture
		const target = event.currentTarget as HTMLElement;
		if (target && typeof target.releasePointerCapture === 'function') {
			try {
				target.releasePointerCapture(event.pointerId);
			} catch (_e) {
				// Ignore if pointer was not captured
			}
		}
		
		// Check if order actually changed
		if (originalIndex !== null && draggedIndex !== null && originalIndex !== draggedIndex && originalImages) {
			// Calculate the final reordered array
			const finalImages = [...originalImages];
			const [movedItem] = finalImages.splice(originalIndex, 1);
			finalImages.splice(draggedIndex, 0, movedItem);
			
			// Update the UI with the new order
			imageService.setImages(finalImages);
			
			// Send to backend
			await updateImageOrder(finalImages);
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
		// Remove clone
		if (draggedClone && draggedClone.parentNode) {
			try {
				document.body.removeChild(draggedClone);
			} catch (_e) {
				// Ignore if already removed
			}
			draggedClone = null;
		}
		
		// Reset element opacity
		if (draggedElement) {
			draggedElement.style.opacity = '1';
			draggedElement = null;
		}
		
		// Reset drag index and tracking variables
		draggedIndex = null;
		originalIndex = null;
		originalImages = null;
		tempDragOrder = null;  // Clear temp order to use store again
		
		// Stop auto-scroll
		stopAutoScroll();
	}
	
	// Update image order in backend
	async function updateImageOrder(newImages: ImageMetadata[]) {
		if (!$currentProject) return;
		
		const imageIds = newImages.map(img => img.id);
		await imageService.reorderImages($currentProject.id, imageIds);
	}
	
</script>

<!-- 图片管理组件 -->
<div class="border-b border-theme-outline pb-4">
	<div class="text-xs text-theme-on-surface-variant uppercase tracking-wide mb-2 select-none">图片管理</div>
	
	{#if $currentProject}
		<!-- 项目图片列表 -->
		{#if displayImages.length > 0}
			<div class="mb-4">
				<div class="flex items-center justify-between mb-2">
					<div class="text-sm text-theme-on-surface-variant select-none">
						{displayImages.length} 张图片{#if !isUploading && !isDragDisabled}（拖拽排序）{/if}
					</div>
					<button
						type="button"
						class="px-3 py-1 text-xs bg-theme-surface-variant text-theme-on-surface-variant rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-surface-container enabled:hover:shadow-md"
						onclick={sortImagesByName}
						disabled={isUploading || isDragDisabled}
					>
						按文件名排序
					</button>
				</div>
				
				<div bind:this={scrollContainer} class="max-h-48 overflow-y-auto border border-theme-outline rounded p-2 bg-theme-surface {isUploading || isDragDisabled ? 'opacity-60' : ''}">
					<div class="space-y-1">
						{#each displayImages as image, index (image.id)}
							<div 
								data-sortable-item
								data-index={index}
								class="flex items-center justify-between py-1 px-2 hover:bg-theme-surface-variant rounded group {isUploading || isDragDisabled ? 'cursor-not-allowed' : 'cursor-move'}"
							>
								<div 
									class="flex items-center gap-2 flex-1 min-w-0 select-none {isUploading || isDragDisabled ? 'pointer-events-none' : 'touch-none'}"
									onpointerdown={(e) => handlePointerDown(e, index)}
									onpointermove={handlePointerMove}
									onpointerup={handlePointerUp}
									onpointercancel={handlePointerUp}
								>
									<!-- Order number -->
									<span class="text-xs text-theme-on-surface-variant opacity-60 w-6 text-center flex-shrink-0">
										{index + 1}
									</span>
									
									<!-- File name -->
									<span class="text-sm text-theme-on-surface truncate" title={image.name}>
										{image.name}
									</span>
								</div>
								
								<!-- Delete button -->
								<button
									type="button"
									class="p-1 text-theme-error opacity-0 group-hover:opacity-100 transition-opacity"
									onclick={() => removeImage(image.id)}
									disabled={isUploading || isDragDisabled}
									title="删除图片"
									aria-label="删除图片"
								>
									<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6"/>
									</svg>
								</button>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{:else}
			<div class="mb-4 p-3 bg-theme-surface-variant rounded text-sm text-theme-on-surface-variant text-center select-none">
				暂无图片
			</div>
		{/if}
		
		<!-- 加载区域 -->
		<div class="space-y-3">
			<div class="text-sm text-theme-on-surface-variant select-none">添加新图片</div>
			
			<!-- 文件选择 -->
			<FileUpload 
				onFilesSelected={handleFilesSelected}
				accept="image/*"
				multiple={true}
				disabled={isUploading}
				fileType="image"
			/>
			
			<!-- 已选择的文件列表 -->
			{#if selectedFiles.length > 0}
				<div class="border border-theme-outline rounded p-2 bg-theme-surface">
					<div class="text-xs text-theme-on-surface-variant mb-1 select-none">
						已选择 {selectedFiles.length} 个文件
					</div>
					<div class="space-y-0.5 max-h-24 overflow-y-auto">
						{#each selectedFiles as file, index}
							<div class="text-xs text-theme-on-surface truncate select-none" title={file.name}>
								{index + 1}. {file.name}
							</div>
						{/each}
					</div>
				</div>
				
				<!-- 加载按钮 -->
				<button 
					class="w-full bg-theme-primary text-theme-on-primary rounded px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-theme-primary-container enabled:hover:text-theme-on-primary-container"
					onclick={handleUploadImages} 
					disabled={isUploading || selectedFiles.length === 0}
				>
					{isUploading ? '加载中...' : '加载图片'}
				</button>
			{/if}
			
			{#if error}
				<div class="p-2 bg-theme-error-container border border-theme-error rounded">
					<p class="text-xs text-theme-on-error-container">{error}</p>
				</div>
			{/if}
			
			{#if isUploading}
				<div>
					<div class="h-1 bg-theme-surface-variant rounded-full overflow-hidden mb-1">
						<div class="h-full bg-theme-primary transition-all duration-300" style="width: {uploadProgress}%"></div>
					</div>
					<span class="block text-xs text-theme-on-surface-variant">加载中... {Math.round(uploadProgress)}%</span>
				</div>
			{/if}
		</div>
	{:else}
		<div class="p-3 bg-theme-surface-variant rounded text-sm text-theme-on-surface-variant text-center select-none">
			请先选择一个项目
		</div>
	{/if}
</div>