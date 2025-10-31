<script lang="ts">
	import {
		ImageViewer,
		TranslationPanel,
		ResizableBar,
		ButtonBar,
		StatusBar,
		ImagesPanel,
		DictionaryPanel,
		ProjectSettingsPanel,
		ToolbarControls,
		WelcomePage,
		BunnyPanel,
		NotificationToasts
	} from '$lib/components';
	import { projectService } from '$lib/services/projectService';
	import { currentImage } from '$lib/stores/imageStore';
	import { onMount } from 'svelte';
	import { sidebarState, layoutActions } from '$lib/stores/layoutStore';

	// 响应式计算侧边栏限制
	let windowWidth = $state(0);
	let windowHeight = $state(0);
	
	// 左侧边栏：最小宽度为固定值200px和视窗15%中的较小值，最大为固定值600px和视窗35%中的较小值
	const leftSidebarMinSize = $derived(Math.min(200, Math.floor(windowWidth * 0.15)));
	const leftSidebarMaxSize = $derived(Math.min(600, Math.floor(windowWidth * 0.35)));
	
	// 右侧边栏：最小宽度为固定值250px和视窗20%中的较小值，最大为固定值800px和视窗40%中的较小值
	const rightSidebarMinSize = $derived(Math.min(250, Math.floor(windowWidth * 0.2)));
	const rightSidebarMaxSize = $derived(Math.min(800, Math.floor(windowWidth * 0.4)));
	
	// 底部面板：最小高度为固定值200px和视窗15%中的较小值，最大为固定值600px和视窗35%中的较小值
	const bottomPanelMinSize = $derived(Math.min(200, Math.floor(windowHeight * 0.15)));
	const bottomPanelMaxSize = $derived(Math.min(600, Math.floor(windowHeight * 0.35)));

	// 计算实际使用的尺寸（约束在限制范围内）
	const actualLeftSidebarWidth = $derived(
		Math.min(Math.max($sidebarState.leftSidebarWidth, leftSidebarMinSize), leftSidebarMaxSize)
	);
	const actualRightSidebarWidth = $derived(
		Math.min(Math.max($sidebarState.rightSidebarWidth, rightSidebarMinSize), rightSidebarMaxSize)
	);
	const actualBottomPanelHeight = $derived(
		Math.min(Math.max($sidebarState.bottomPanelHeight, bottomPanelMinSize), bottomPanelMaxSize)
	);
	
	// 使用防抖处理窗口大小变化时的尺寸调整
	let resizeTimer: NodeJS.Timeout | null = null;
	
	// 当窗口大小改变时调整侧边栏尺寸
	$effect(() => {
		// 只有当窗口尺寸初始化后才进行调整
		if (windowWidth === 0 || windowHeight === 0) return;
		
		// 清除之前的定时器
		if (resizeTimer) {
			clearTimeout(resizeTimer);
		}
		
		// 使用防抖避免频繁调整
		resizeTimer = setTimeout(() => {
			// 检查并调整左侧边栏宽度
			const currentLeftWidth = $sidebarState.leftSidebarWidth;
			if (currentLeftWidth < leftSidebarMinSize && currentLeftWidth !== leftSidebarMinSize) {
				layoutActions.setLeftSidebarWidth(leftSidebarMinSize);
			} else if (currentLeftWidth > leftSidebarMaxSize && currentLeftWidth !== leftSidebarMaxSize) {
				layoutActions.setLeftSidebarWidth(leftSidebarMaxSize);
			}
			
			// 检查并调整右侧边栏宽度
			const currentRightWidth = $sidebarState.rightSidebarWidth;
			if (currentRightWidth < rightSidebarMinSize && currentRightWidth !== rightSidebarMinSize) {
				layoutActions.setRightSidebarWidth(rightSidebarMinSize);
			} else if (currentRightWidth > rightSidebarMaxSize && currentRightWidth !== rightSidebarMaxSize) {
				layoutActions.setRightSidebarWidth(rightSidebarMaxSize);
			}
			
			// 检查并调整底部面板高度
			const currentBottomHeight = $sidebarState.bottomPanelHeight;
			if (currentBottomHeight < bottomPanelMinSize && currentBottomHeight !== bottomPanelMinSize) {
				layoutActions.setBottomPanelHeight(bottomPanelMinSize);
			} else if (currentBottomHeight > bottomPanelMaxSize && currentBottomHeight !== bottomPanelMaxSize) {
				layoutActions.setBottomPanelHeight(bottomPanelMaxSize);
			}
		}, 100);
		
		// 清理函数
		return () => {
			if (resizeTimer) {
				clearTimeout(resizeTimer);
			}
		};
	});

	// 初始化时加载项目
	onMount(() => {
		projectService.loadProjects();
		
		// 初始化窗口尺寸
		windowWidth = window.innerWidth;
		windowHeight = window.innerHeight;
		
		// 监听窗口大小变化
		const handleResize = () => {
			windowWidth = window.innerWidth;
			windowHeight = window.innerHeight;
		};
		
		window.addEventListener('resize', handleResize);
		
		return () => {
			window.removeEventListener('resize', handleResize);
		};
	});
</script>

<!-- VSCode风格的布局 -->
<div class="bg-theme-background flex h-full flex-col">
	<!-- 主体区域 (不包括状态栏) -->
	<div class="flex flex-1">
		<!-- 最左侧按钮栏 -->
		<ButtonBar />

		<!-- 左侧边栏 + 主区域 + 右侧边栏 -->
		<div class="flex flex-1 overflow-hidden">
					<!-- 左侧边栏 - 使用可伸缩组件 -->
		{#if $sidebarState.leftSidebarOpen}
			<ResizableBar 
				direction="horizontal" 
				initialSize={actualLeftSidebarWidth} 
				minSize={leftSidebarMinSize}
				maxSize={leftSidebarMaxSize}
				onSizeChange={(size) => layoutActions.setLeftSidebarWidth(size)}
			>
				<div class="bg-theme-surface border-theme-outline flex h-full flex-col border-r">
					{#if $sidebarState.leftSidebarType === 'images'}
						<ImagesPanel />
					{:else if $sidebarState.leftSidebarType === 'dictionary'}
						<DictionaryPanel />
					{:else if $sidebarState.leftSidebarType === 'projectSettings'}
						<ProjectSettingsPanel />
					{/if}
				</div>
			</ResizableBar>
		{/if}

			<!-- 主编辑区域 -->
			<div class="flex flex-1 flex-col min-w-0">
				<!-- 主区域顶部工具栏 -->
				<div class="bg-theme-surface border-theme-outline flex h-10 items-center justify-center border-b px-4"
				>
					<ToolbarControls />
				</div>

				<!-- 主内容区域 -->
				<div
					id="main-content-area"
					class="bg-theme-background relative flex flex-1 items-center justify-center overflow-hidden"
				>
					{#if $currentImage}
						<ImageViewer />
					{:else}
						<WelcomePage />
					{/if}
				</div>

							<!-- 底部控制台面板 - 只在中间栏显示 -->
			{#if $sidebarState.bottomPanelOpen}
				<ResizableBar
					direction="vertical"
					initialSize={actualBottomPanelHeight}
					minSize={bottomPanelMinSize}
					maxSize={bottomPanelMaxSize}
					barPosition="start"
					onSizeChange={(size) => layoutActions.setBottomPanelHeight(size)}
				>
					<BunnyPanel />
				</ResizableBar>
			{/if}
			</div>

					<!-- 右侧边栏 - 翻译面板，使用可伸缩组件，伸缩条在左边 -->
		{#if $sidebarState.rightSidebarOpen}
			<ResizableBar
				direction="horizontal"
				initialSize={actualRightSidebarWidth}
				minSize={rightSidebarMinSize}
				maxSize={rightSidebarMaxSize}
				barPosition="start"
				onSizeChange={(size) => layoutActions.setRightSidebarWidth(size)}
			>
					<div class="bg-theme-surface border-theme-outline h-full border-l">
						<TranslationPanel />
					</div>
				</ResizableBar>
			{/if}
		</div>
	</div>

	<!-- 状态栏 - 横跨全屏宽度 -->
	<StatusBar />
</div>

<NotificationToasts />
