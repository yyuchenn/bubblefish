<script lang="ts">
	import '../app.css';
	import { TitleBar } from '$lib/components';
	import DebugWindow from '$lib/components/debug/DebugWindow.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import GlobalKeyboardShortcuts from '$lib/components/GlobalKeyboardShortcuts.svelte';
	import { Modals } from '$lib/components/modals';
	import { platformService } from '$lib/services/platformService';
	import type { Platform } from '$lib/core/tauri';
	import { onMount } from 'svelte';
	import { themeActions } from '$lib/stores/themeStore';
	import { layoutActions } from '$lib/stores/layoutStore';
	import { progressManager } from '$lib/utils/progressManager';
	import { eventService } from '$lib/services/eventService';
	import { titleService } from '$lib/services/titleService';
	import { undoRedoService } from '$lib/services/undoRedoService';
	import { coordinatorService } from '$lib/services/coordinatorService';
	import { imageService } from '$lib/services/imageService';
	import { fileAssociationService } from '$lib/services/fileAssociationService';
	import { recentMenuService } from '$lib/services/recentMenuService';

	// 创建响应式引用
	const activeProgress = $derived(progressManager.activeProgress);

	let { children } = $props();
	let isInTauri = $state(false);
	let platform = $state<Platform>('unknown');

	onMount(() => {
		// Initialize theme
		themeActions.loadSavedTheme();
		
		// Initialize layout (sidebar states)
		layoutActions.loadSavedSidebarState();

		// Initialize event system asynchronously
		eventService.initialize();

		// Initialize title service
		titleService.initialize();

		// Initialize undo/redo service with event listener
		const unsubscribeUndoRedo = undoRedoService.initialize();

		// Initialize image service with event listener
		const unsubscribeImageService = imageService.initialize();

		// Initialize coordinator service for managing side effects
		coordinatorService.initialize();

		// Initialize file association service (for handling .bf file double-click)
		fileAssociationService.init();
		
		// Initialize recent menu service (for macOS native menu)
		recentMenuService.init();

		isInTauri = platformService.isTauri();
		if (isInTauri) {
			document.body.classList.add('tauri');
			platform = platformService.getPlatform();
		} else {
			// 网页版也显示 titlebar
			document.body.classList.add('web');
		}

		// 禁用鼠标滚轮滚动，但允许在模态框内滚动
		const preventScroll = (e: WheelEvent) => {
			// 检查事件目标是否在模态框内
			const target = e.target as Element;
			const modalContent = target.closest('[data-modal-content]');

			// 如果在模态框内，允许滚动
			if (modalContent) {
				return;
			}

			e.preventDefault();
		};

		window.addEventListener('wheel', preventScroll, { passive: false });

		// 全局禁用右键菜单
		const preventContextMenu = (e: Event) => {
			e.preventDefault();
		};

		// 使用捕获阶段确保优先处理
		window.addEventListener('contextmenu', preventContextMenu, true);

		// 清理函数
		return () => {
			window.removeEventListener('wheel', preventScroll);
			window.removeEventListener('contextmenu', preventContextMenu, true);
			titleService.destroy();
			unsubscribeUndoRedo();
			unsubscribeImageService();
			coordinatorService.destroy();
		};
	});
</script>

<!-- 始终显示 TitleBar，由组件内部决定布局 -->
<TitleBar />

<!-- 全局键盘快捷键监听 -->
<GlobalKeyboardShortcuts />

<div class="relative top-0 left-0 z-[1] h-screen w-full overflow-hidden">
	<main
		class="flex h-screen flex-col overflow-hidden {platform === 'macos'
			? 'pt-7'
			: platform === 'windows'
				? 'pt-8'
				: !isInTauri
					? 'pt-10'
					: ''}"
	>
		{@render children()}
	</main>
</div>

<!-- 调试窗口组件 -->
<DebugWindow />

<!-- 全局Modal管理 -->
<Modals />

<!-- 全局进度条组件 -->
{#if $activeProgress}
	{@const progress = $activeProgress}
	<ProgressBar
		visible={progress.visible}
		title={progress.title}
		subtitle={progress.subtitle || ''}
		progress={progress.progress}
		canCancel={progress.canCancel}
		showPercentage={true}
		on:cancel={() => {
			// TODO: 实现取消功能
			console.log('Progress cancelled');
		}}
	>
		<!-- 可以在这里添加额外的进度信息 -->
	</ProgressBar>
{/if}
