<script lang="ts">
	import { imageService, images as imageStore, currentImageId as currentImageIdStore } from '$lib/services/imageService';
	import { layoutConfig } from '$lib/services/layoutService';
	import { thumbnailService, thumbnailStore } from '$lib/services/thumbnailService';
	import { currentProject } from '$lib/services/projectService';
	import { onMount, onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	// 从布局store获取面板标题栏高度
	const panelTitleBarHeight = $derived($layoutConfig.panelTitleBarHeight);

	// 获取当前图片列表
	const images = $derived($imageStore);
	const currentImageId = $derived($currentImageIdStore);
	
	// 缩略图store (用于响应式更新)
	const thumbnails = $derived($thumbnailStore);

	// 可视区域检测
	let containerElement: HTMLElement;
	let scrollElement: HTMLElement | undefined = $state();  // 真正的滚动容器
	let listElement: HTMLElement | undefined = $state();
	const visibleThumbnails = new SvelteSet<number>();

	// 处理缩略图点击
	function handleThumbnailClick(imageId: number) {
		imageService.setCurrentImage(imageId);
	}

	// 获取文件名（从完整路径或名称中提取）
	function getFileName(imageName: string | undefined): string {
		if (!imageName) return 'Untitled';
		const parts = imageName.split(/[/\\]/);
		return parts[parts.length - 1] || imageName;
	}

	// 获取缩略图数据URL（直接从响应式store获取）
	function getThumbnailUrl(imageId: number): string | null {
		const thumbnail = thumbnails.thumbnails.get(imageId);
		
		if (!thumbnail) {
			return null;
		}

		const mimeType = formatToMimeType(thumbnail.format);
		return `data:${mimeType};base64,${thumbnail.data}`;
	}

	// 检查缩略图是否正在加载（直接从响应式store获取）
	function isThumbnailLoading(imageId: number): boolean {
		return thumbnails.loadingThumbnails.has(imageId);
	}

	// 格式转换辅助函数
	function formatToMimeType(format: 'Jpeg' | 'Png' | 'Gif' | 'Webp' | 'Bmp'): string {
		switch (format) {
			case 'Jpeg': return 'image/jpeg';
			case 'Png': return 'image/png';
			case 'Gif': return 'image/gif';
			case 'Webp': return 'image/webp';
			case 'Bmp': return 'image/bmp';
			default: return 'image/png';
		}
	}

	// 可视区域检测函数
	function checkVisibleThumbnails() {
		if (!scrollElement || !listElement) return;

		const scrollRect = scrollElement.getBoundingClientRect();
		const thumbnailElements = listElement.querySelectorAll('[data-thumbnail-id]');
		const newVisibleIds = new SvelteSet<number>();

		thumbnailElements.forEach((element) => {
			const rect = element.getBoundingClientRect();
			const imageId = parseInt(element.getAttribute('data-thumbnail-id') || '0');

			// 检查元素是否在可视区域内（包含一些预加载边距）
			const margin = 100; // 100px预加载边距
			const isVisible = (
				rect.bottom > scrollRect.top - margin &&
				rect.top < scrollRect.bottom + margin
			);

			if (isVisible) {
				newVisibleIds.add(imageId);
				
				// 如果新进入可视区域且没有缩略图，则请求缩略图
				if (!visibleThumbnails.has(imageId) && !thumbnailService.hasThumbnail(imageId)) {
					thumbnailService.requestThumbnail(imageId);
				}
			}
		});

		// 更新可视缩略图集合
		visibleThumbnails.clear();
		newVisibleIds.forEach(id => visibleThumbnails.add(id));
	}

	// 防抖处理
	let checkTimeout: NodeJS.Timeout;
	function debouncedCheck() {
		clearTimeout(checkTimeout);
		checkTimeout = setTimeout(checkVisibleThumbnails, 100);
	}

	onMount(() => {
		// 初始检查
		setTimeout(checkVisibleThumbnails, 200);

		// 延迟添加滚动监听器，确保元素已绑定
		setTimeout(() => {
			if (scrollElement) {
				scrollElement.addEventListener('scroll', debouncedCheck, { passive: true });
			} else if (containerElement) {
				containerElement.addEventListener('scroll', debouncedCheck, { passive: true });
			}
		}, 50);

		// 监听窗口大小变化
		window.addEventListener('resize', debouncedCheck);
	});

	onDestroy(() => {
		if (scrollElement) {
			scrollElement.removeEventListener('scroll', debouncedCheck);
		}
		if (containerElement) {
			containerElement.removeEventListener('scroll', debouncedCheck);
		}
		window.removeEventListener('resize', debouncedCheck);
		clearTimeout(checkTimeout);
	});

	// 滚动到当前图片
	function scrollToCurrentImage() {
		if (!scrollElement || !currentImageId) return;
		
		// 查找当前图片的元素
		const currentElement = listElement?.querySelector(`[data-thumbnail-id="${currentImageId}"]`) as HTMLElement;
		if (!currentElement) return;
		
		// 获取元素和容器的位置信息
		const elementRect = currentElement.getBoundingClientRect();
		const containerRect = scrollElement.getBoundingClientRect();
		
		// 检查元素是否在可视区域内
		const isAboveView = elementRect.top < containerRect.top;
		const isBelowView = elementRect.bottom > containerRect.bottom;
		
		// 如果元素不在可视区域内，则滚动到它
		if (isAboveView || isBelowView) {
			// 计算需要滚动的位置，使元素居中显示
			const elementOffsetTop = currentElement.offsetTop;
			const containerHeight = containerRect.height;
			const elementHeight = elementRect.height;
			
			// 滚动到元素，使其在容器中居中（如果可能）
			const targetScrollTop = elementOffsetTop - (containerHeight - elementHeight) / 2;
			
			scrollElement.scrollTo({
				top: Math.max(0, targetScrollTop),
				behavior: 'smooth'
			});
		}
	}

	// 当图片列表或缩略图数据变化时，重新检查可视区域
	$effect(() => {
		// 依赖于thumbnails的变化
		void thumbnails;
		if (images.length > 0) {
			setTimeout(checkVisibleThumbnails, 100);
		}
	});
	
	// 当当前图片ID变化时，滚动到对应的缩略图
	$effect(() => {
		if (currentImageId) {
			// 延迟执行以确保DOM已更新
			setTimeout(scrollToCurrentImage, 100);
		}
	});
</script>

<!-- 缩略图列表组件 -->
<div class="bg-theme-surface relative h-full w-full overflow-hidden">
	<!-- 标题栏 -->
	<div
		class="bg-theme-surface-variant border-theme-outline absolute top-0 right-0 left-0 z-10 flex items-center border-b px-3"
		style="height: {panelTitleBarHeight}px;"
	>
		<span class="text-theme-on-surface text-sm font-medium select-none">图片</span>
	</div>

	<!-- 缩略图列表 -->
	<div
		bind:this={containerElement}
		class="absolute right-0 left-0 bottom-0 overflow-hidden bg-theme-surface"
		style="top: {panelTitleBarHeight}px;"
	>
		{#if !$currentProject}
			<!-- 没有项目打开时的提示 -->
			<div class="flex flex-col items-center justify-center h-full text-center p-4">
				<svg class="w-16 h-16 mb-4 text-theme-on-surface-variant opacity-50" viewBox="0 0 36 36" fill="currentColor">
					<path d="M30.14,3h0a1,1,0,0,0-1-1h-22a1,1,0,0,0-1,1h0V4h24Z"/>
					<path d="M32.12,7V7a1,1,0,0,0-1-1h-26a1,1,0,0,0-1,1h0V8h28Z"/>
					<path d="M32.12,10H3.88A1.88,1.88,0,0,0,2,11.88V30.12A1.88,1.88,0,0,0,3.88,32H32.12A1.88,1.88,0,0,0,34,30.12V11.88A1.88,1.88,0,0,0,32.12,10ZM8.56,13.45a3,3,0,1,1-3,3A3,3,0,0,1,8.56,13.45ZM30,28h-24l7.46-7.47a.71.71,0,0,1,1,0l3.68,3.68L23.21,19a.71.71,0,0,1,1,0L30,24.79Z"/>
				</svg>
				<h3 class="text-lg font-semibold text-theme-on-surface mb-2 select-none">请先打开一个项目</h3>
			</div>
		{:else}
			<!-- 恢复鼠标滚轮行为 -->
			<div bind:this={scrollElement} class="h-full overflow-y-auto" onwheel={(e) => e.stopPropagation()}>
				<div bind:this={listElement} class="p-2 space-y-2">
					{#each images as image (image.id)}
						<button
							type="button"
							class="hover-theme w-full rounded p-2 transition-colors {currentImageId === image.id
								? 'bg-theme-primary-container border-theme-primary border'
								: 'border border-transparent'}"
							onclick={() => handleThumbnailClick(image.id)}
							data-thumbnail-id={image.id}
						>
							<!-- 缩略图容器 -->
							<div class="flex flex-col items-center gap-2">
								<!-- 缩略图显示区域 -->
								<div class="flex h-24 w-24 items-center justify-center"
								>
									{#if getThumbnailUrl(image.id)}
										<!-- 显示实际缩略图 -->
										<img
											src={getThumbnailUrl(image.id)}
											alt={getFileName(image.name)}
											class="max-w-full max-h-full object-contain rounded border border-theme-outline shadow-sm"
											loading="lazy"
										/>
									{:else if isThumbnailLoading(image.id)}
										<!-- 加载中状态 -->
										<div class="flex flex-col items-center justify-center bg-white rounded border border-theme-outline shadow-sm p-4">
											<div class="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"></div>
											<span class="text-gray-400 text-xs mt-1">加载中</span>
										</div>
									{:else}
										<!-- 占位状态 -->
										<div class="flex flex-col items-center justify-center bg-white rounded border border-theme-outline shadow-sm p-4">
											<div class="w-8 h-6 border border-gray-300 rounded bg-gray-100"></div>
											<span class="text-gray-400 text-xs mt-1">缩略图</span>
										</div>
									{/if}
								</div>
								
								<!-- 文件名 -->
								<span 
									class="text-theme-on-surface text-xs text-center break-all line-clamp-2"
									title={image.name}
								>
									{getFileName(image.name)}
								</span>
							</div>
						</button>
					{/each}
					
					{#if images.length === 0}
						<div class="text-center py-8">
							<p class="text-theme-on-surface-variant text-sm">暂无图片</p>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.line-clamp-2 {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>