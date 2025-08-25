<script lang="ts">
	import { imageService, images, currentImageId, currentImageIndex, totalImages } from '$lib/services/imageService';
	import { 
		imageViewerService, 
		scale,
		zoomMode,
		dynamicMaxScale,
		ZOOM_CONSTANTS
	} from '$lib/services/imageViewerService';
	import { currentImage } from '$lib/services/imageService';
	import { modalStore } from '$lib/services/modalService';
	import { derived } from 'svelte/store';
	import { onDestroy } from 'svelte';
	import { browser } from '$app/environment';

	const status = $state('Bubblefish');
	const mode = $state('翻译模式');

	// 编辑状态
	let isEditing = $state(false);
	let inputValue = $state('');
	let inputElement = $state<HTMLInputElement>();

	// 缩放弹出菜单状态
	let showZoomPopup = $state(false);
	let zoomPopupElement = $state<HTMLDivElement>();
	let zoomButtonElement = $state<HTMLButtonElement>();

	// 缩放滑块的步长
	const scaleStep = 0.01;

	// currentImageIndex and totalImages are now imported from imageService

	// 计算总页数的位数
	const totalDigits = derived(totalImages, ($totalImages) => {
		if ($totalImages === 0) return 1;
		return Math.floor(Math.log10($totalImages)) + 1;
	});

	// 计算显示的位置信息（分离的数字和斜杠）
	const displayData = derived(
		[currentImageIndex, totalImages, totalDigits],
		([$currentImageIndex, $totalImages, $totalDigits]) => {
			if ($totalImages === 0) {
				return {
					currentPage: '0',
					totalPages: '0',
					digitWidth: $totalDigits
				};
			}
			return {
				currentPage: `${$currentImageIndex}`,
				totalPages: `${$totalImages}`,
				digitWidth: $totalDigits
			};
		}
	);

	// 检查是否可以翻页
	const canGoPrev = derived(
		[currentImageIndex, totalImages],
		([$currentImageIndex, $totalImages]) => $totalImages > 0 && $currentImageIndex > 1
	);

	const canGoNext = derived(
		[currentImageIndex, totalImages],
		([$currentImageIndex, $totalImages]) => 
			$totalImages > 0 && $currentImageIndex < $totalImages
	);

	function handlePrevImage() {
		if ($canGoPrev) {
			imageService.prevImage();
		}
	}

	function handleNextImage() {
		if ($canGoNext) {
			imageService.nextImage();
		}
	}

	// 处理点击序号开始编辑
	function handlePageNumberClick() {
		if ($totalImages === 0) return;
		
		isEditing = true;
		inputValue = $displayData.currentPage;
		
		// 等待DOM更新后聚焦并选中输入框
		requestAnimationFrame(() => {
			if (inputElement) {
				inputElement.focus();
				inputElement.select();
			}
		});

		// 添加文档级别的点击监听器（仅在浏览器环境）
		if (browser) {
			document.addEventListener('mousedown', handleDocumentClick);
		}
	}

	// 处理回车键提交
	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			submitPageNumber();
		} else if (event.key === 'Escape') {
			cancelEdit();
		}
	}

	// 提交页码
	function submitPageNumber() {
		const pageNumber = parseInt(inputValue.trim());
		
		// 验证输入是否合法
		if (isNaN(pageNumber) || pageNumber < 1 || pageNumber > $totalImages) {
			// 输入不合法，取消编辑
			cancelEdit();
			return;
		}
		
		// 获取对应页码的图片ID并跳转（复用现有的切换机制）
		const imageState = { images: $images, currentImageId: $currentImageId };
		const targetIndex = pageNumber - 1; // 页码从1开始，索引从0开始
		const targetImage = imageState.images[targetIndex];
		
		if (targetImage) {
			// 使用现有的图片切换方法
			imageService.setCurrentImage(targetImage.id);
			isEditing = false;
		} else {
			// 跳转失败，取消编辑
			cancelEdit();
		}
	}

	// 取消编辑
	function cancelEdit() {
		isEditing = false;
		inputValue = '';
		// 移除文档级别的点击监听器（仅在浏览器环境）
		if (browser) {
			document.removeEventListener('mousedown', handleDocumentClick);
		}
	}

	// 处理文档级别的点击事件
	function handleDocumentClick(event: MouseEvent) {
		if (isEditing && inputElement && !inputElement.contains(event.target as Node)) {
			cancelEdit();
		}
	}

	// 处理缩放滑块输入
	function handleScaleInput(event: Event) {
		const newScale = parseFloat((event.target as HTMLInputElement).value);

		// 获取视口元素（图片查看器的容器）
		const viewportElement = document.querySelector('.absolute.inset-0.overflow-hidden') as HTMLElement;
		if (!viewportElement) return;

		const viewportRect = viewportElement.getBoundingClientRect();
		const viewportCenterX = viewportRect.width / 2;
		const viewportCenterY = viewportRect.height / 2;

		// 使用统一的 zoomAtPoint 函数，以视口中心为锚点进行缩放
		imageViewerService.zoomAtPoint(viewportCenterX, viewportCenterY, newScale);
	}

	// 处理适合屏幕按钮点击
	function handleFitScreen() {
		imageViewerService.setZoomMode('fit-screen');
		applyCurrentZoomMode();
	}

	// 处理适合宽度按钮点击
	function handleFitWidth() {
		imageViewerService.setZoomMode('fit-width');
		applyCurrentZoomMode();
	}

	// 处理适合高度按钮点击
	function handleFitHeight() {
		imageViewerService.setZoomMode('fit-height');
		applyCurrentZoomMode();
	}

	// 应用当前缩放模式
	function applyCurrentZoomMode() {
		const viewportElement = document.querySelector('.absolute.inset-0.overflow-hidden') as HTMLElement;
		if (!viewportElement || !$currentImage) return;

		// 获取当前图片的显示尺寸
		const displaySize = imageViewerService.calculateDisplaySize(
			$currentImage.width || 100,
			$currentImage.height || 100,
			viewportElement.clientWidth,
			viewportElement.clientHeight
		);

		imageViewerService.applyZoomMode(
			displaySize.width,
			displaySize.height,
			viewportElement.clientWidth,
			viewportElement.clientHeight,
			$currentImage.width || 100,
			$currentImage.height || 100,
			$zoomMode
		);
	}

	// 切换缩放弹出菜单
	function toggleZoomPopup() {
		showZoomPopup = !showZoomPopup;
		if (showZoomPopup && browser) {
			// 延迟添加监听器，避免立即触发关闭
			setTimeout(() => {
				document.addEventListener('mousedown', handleZoomPopupOutsideClick);
			}, 0);
		} else if (browser) {
			document.removeEventListener('mousedown', handleZoomPopupOutsideClick);
		}
	}

	// 处理缩放弹出菜单外部点击
	function handleZoomPopupOutsideClick(event: MouseEvent) {
		if (zoomPopupElement && !zoomPopupElement.contains(event.target as Node) &&
			zoomButtonElement && !zoomButtonElement.contains(event.target as Node)) {
			showZoomPopup = false;
			if (browser) {
				document.removeEventListener('mousedown', handleZoomPopupOutsideClick);
			}
		}
	}


	// 组件卸载时清理监听器
	onDestroy(() => {
		if (browser) {
			document.removeEventListener('mousedown', handleDocumentClick);
			document.removeEventListener('mousedown', handleZoomPopupOutsideClick);
		}
	});
</script>

<!-- VSCode风格的状态栏 -->
<div class="bg-theme-primary text-theme-on-primary flex h-6 w-full flex-shrink-0 items-center justify-between px-3 text-xs"
>
	<!-- 左侧状态信息 -->
	<div class="flex items-center gap-4">
		<button
			class="hover-theme rounded px-1 transition-colors font-medium"
			onclick={() => modalStore.showModal('about')}
			title="关于 Bubblefish"
		>
			{status}
		</button>
		
		<!-- 图片序号按钮，支持悬浮显示导航 -->
		{#if $totalImages > 0}
		<div class="group relative">
			{#if isEditing}
				<!-- 编辑模式：显示输入框 -->
				<div class="flex items-center font-mono px-1">
					<!-- 左侧：输入框，替换当前页号 -->
					<input
						bind:this={inputElement}
						bind:value={inputValue}
						onkeydown={handleInputKeydown}
						onmousedown={(e) => e.stopPropagation()}
						class="bg-transparent border border-white/30 rounded text-center outline-none focus:border-white/60"
						style="width: {$displayData.digitWidth * 0.8}em;"
						type="text"
						inputmode="numeric"
					/>
					<!-- 中间：斜杠，固定宽度 -->
					<div class="w-3 text-center">
						/
					</div>
					<!-- 右侧：总页数，根据位数设置宽度 -->
					<div 
						class="text-center"
						style="width: {$displayData.digitWidth * 0.6}em;"
					>
						{$displayData.totalPages}
					</div>
				</div>
			{:else}
				<!-- 正常模式：显示按钮 -->
				<button
					class="hover-theme rounded px-1 transition-colors font-mono"
					onclick={handlePageNumberClick}
					title="点击编辑页码"
				>
					<!-- 固定宽度的三栏布局 -->
					<div class="flex items-center">
						<!-- 左侧：当前页号，根据总页数位数设置宽度 -->
						<div 
							class="text-center"
							style="width: {$displayData.digitWidth * 0.6}em;"
						>
							{$displayData.currentPage}
						</div>
						<!-- 中间：斜杠，固定宽度 -->
						<div class="w-3 text-center">
							/
						</div>
						<!-- 右侧：总页数，根据位数设置宽度 -->
						<div 
							class="text-center"
							style="width: {$displayData.digitWidth * 0.6}em;"
						>
							{$displayData.totalPages}
						</div>
					</div>
				</button>
			{/if}
			
			<!-- 左箭头，悬浮时显示（仅在非编辑模式下） -->
			{#if !isEditing && $canGoPrev}
				<button
					class="absolute -left-3 top-0 flex h-full w-4 items-center justify-center 
						   opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 rounded"
					onclick={handlePrevImage}
					title="上一页"
					aria-label="上一页"
				>
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
						<path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
					</svg>
				</button>
			{/if}
			
			<!-- 右箭头，悬浮时显示（仅在非编辑模式下） -->
			{#if !isEditing && $canGoNext}
				<button
					class="absolute -right-3 top-0 flex h-full w-4 items-center justify-center 
						   opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 rounded"
					onclick={handleNextImage}
					title="下一页"
					aria-label="下一页"
				>
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
						<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
					</svg>
				</button>
			{/if}
		</div>
		{/if}

		<!-- 缩放控制 -->
		{#if $totalImages > 0}
		<div class="relative">
			<button
				bind:this={zoomButtonElement}
				class="hover-theme rounded px-2 py-0.5 transition-colors font-mono text-xs flex items-center gap-1"
				onclick={toggleZoomPopup}
				title="点击调整缩放"
			>
				{Math.round(($scale || 1) * 100)}%
				
				<!-- 缩放模式图标 -->
				{#if $zoomMode !== 'free'}
					{#if $zoomMode === 'fit-screen'}
						<!-- 适合屏幕图标 -->
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M9 9L5 5M5 5L5 9M5 5L9 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M15 9L19 5M19 5L15 5M19 5L19 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M9 15L5 19M5 19L9 19M5 19L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M15 15L19 19M19 19L19 15M19 19L15 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					{:else if $zoomMode === 'fit-width'}
						<!-- 适合宽度图标 -->
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M21 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M3 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M7 12H17M7 12L9.5 9.5M7 12L9.5 14.5M17 12L14.5 9.5M17 12L14.5 14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					{:else if $zoomMode === 'fit-height'}
						<!-- 适合高度图标 -->
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M17 21L7 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M17 3L7 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M12 7L12 17M12 7L14.5 9.5M12 7L9.5 9.5M12 17L14.5 14.5M12 17L9.5 14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					{/if}
				{/if}
			</button>

			<!-- 缩放弹出菜单 -->
			{#if showZoomPopup}
				<div
					bind:this={zoomPopupElement}
					class="absolute bottom-full left-0 mb-2 bg-theme-surface border border-theme-outline rounded-lg shadow-lg p-3"
					style="min-width: 200px;"
				>
					<div class="flex flex-col gap-3">
						<!-- 缩放滑块 -->
						<div class="flex items-center gap-2">
							<span class="text-xs text-theme-on-surface-variant whitespace-nowrap">缩放:</span>
							<input
								type="range"
								min={ZOOM_CONSTANTS.MIN_SCALE}
								max={$dynamicMaxScale}
								step={scaleStep}
								value={$scale || 1}
								oninput={handleScaleInput}
								class="slider-thumb h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-theme-surface-variant outline-none"
							/>
							<span class="text-xs text-theme-on-surface-variant min-w-[40px] text-right">
								{Math.round(($scale || 1) * 100)}%
							</span>
						</div>

						<!-- 按钮组：适合屏幕、适合宽度、适合高度 -->
						<div class="flex justify-end">
							<div class="flex items-center gap-1 bg-theme-surface-variant rounded-md p-1">
								<!-- 适合屏幕按钮 -->
								<button
									onclick={handleFitScreen}
									class="flex items-center justify-center w-7 h-7 rounded transition-colors
										{$zoomMode === 'fit-screen' ? 'bg-theme-primary text-theme-on-primary' : 'text-theme-on-surface-variant hover:bg-theme-surface'}"
									title="适合屏幕"
									aria-label="适合屏幕"
								>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M9 9L5 5M5 5L5 9M5 5L9 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M15 9L19 5M19 5L15 5M19 5L19 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M9 15L5 19M5 19L9 19M5 19L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M15 15L19 19M19 19L19 15M19 19L15 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								</button>
								
								<!-- 适合宽度按钮 -->
								<button
									onclick={handleFitWidth}
									class="flex items-center justify-center w-7 h-7 rounded transition-colors
										{$zoomMode === 'fit-width' ? 'bg-theme-primary text-theme-on-primary' : 'text-theme-on-surface-variant hover:bg-theme-surface'}"
									title="适合宽度"
									aria-label="适合宽度"
								>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M21 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M3 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M7 12H17M7 12L9.5 9.5M7 12L9.5 14.5M17 12L14.5 9.5M17 12L14.5 14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								</button>
								
								<!-- 适合高度按钮 -->
								<button
									onclick={handleFitHeight}
									class="flex items-center justify-center w-7 h-7 rounded transition-colors
										{$zoomMode === 'fit-height' ? 'bg-theme-primary text-theme-on-primary' : 'text-theme-on-surface-variant hover:bg-theme-surface'}"
									title="适合高度"
									aria-label="适合高度"
								>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M17 21L7 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M17 3L7 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
										<path d="M12 7L12 17M12 7L14.5 9.5M12 7L9.5 9.5M12 17L14.5 14.5M12 17L9.5 14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								</button>
							</div>
						</div>
					</div>
				</div>
			{/if}
		</div>
		{/if}
	</div>

	<!-- 右侧配置信息 -->
	<div class="flex items-center gap-4">
		<button
			class="hover-theme rounded px-1 transition-colors"
			onclick={() => {}}
			title="当前模式"
		>
			{mode}
		</button>
	</div>
</div>
