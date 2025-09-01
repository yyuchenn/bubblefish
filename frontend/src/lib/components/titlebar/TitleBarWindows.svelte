<script lang="ts">
	import { sidebarState } from '$lib/services/layoutService';
	import { undoRedoActions } from '$lib/services/undoRedoService';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	import { onMount } from 'svelte';

	interface Props {
		showFileMenu: boolean;
		showEditMenu: boolean;
		showWindowMenu: boolean;
		showMoreMenu: boolean;
		showProjectMenu: boolean;
		isMaximized: boolean;
		onToggleFileMenu: () => void;
		onToggleEditMenu: () => void;
		onToggleWindowMenu: () => void;
		onToggleMoreMenu: () => void;
		onToggleProjectMenu: () => void;
		onOpenFileMenu: () => void;
		onOpenEditMenu: () => void;
		onOpenWindowMenu: () => void;
		onOpenMoreMenu: () => void;
		onCreateNewProject: () => void;
		onOpenProject: () => void;
		onSelectProject: (index: number) => void;
		onCloseProject: (projectId: number) => void;
		onMinimizeWindow: () => void;
		onMaximizeWindow: () => void;
		onCloseWindow: () => void;
		onOpenDebugWindow: () => void;
		onToggleLeftSidebar: () => void;
		onToggleBottomPanel: () => void;
		onToggleRightSidebar: () => void;
		onToggleTranslationPanel: () => void;
		onToggleThumbnailPanel: () => void;
		onToggleDictionaryPanel: () => void;
		onToggleProjectConfigPanel: () => void;
		onHandleUndo: () => void;
		onHandleRedo: () => void;
		canUndo: boolean;
		canRedo: boolean;
		undoActionDisplayName?: string | null;
		onShowSoftwareLicense: () => void;
		onShowAbout: () => void;
		onShowSnapshot: () => void;
		onPrevImage: () => void;
		onNextImage: () => void;
		canPrevImage: boolean;
		canNextImage: boolean;
		projects: Array<{ id: number; name: string }>;
		currentProjectId: number | null;
		onNextMarker: () => void;
		onPrevMarker: () => void;
		canNextMarker: boolean;
		canPrevMarker: boolean;
		onExportLabelplus: () => void;
		onSaveProject: () => void;
		onSaveAs: () => void;
		hasUnsaved?: boolean;
		hasProject?: boolean;
	}

	let {
		showFileMenu,
		showEditMenu,
		showWindowMenu,
		showMoreMenu,
		showProjectMenu,
		isMaximized,
		onToggleFileMenu,
		onToggleEditMenu,
		onToggleWindowMenu,
		onToggleMoreMenu,
		onToggleProjectMenu,
		onOpenFileMenu,
		onOpenEditMenu,
		onOpenWindowMenu,
		onOpenMoreMenu,
		onCreateNewProject,
		onOpenProject,
		onSelectProject,
		onCloseProject,
		onMinimizeWindow,
		onMaximizeWindow,
		onCloseWindow,
		onOpenDebugWindow,
		onToggleLeftSidebar,
		onToggleBottomPanel,
		onToggleRightSidebar,
		onToggleTranslationPanel,
		onToggleThumbnailPanel,
		onToggleDictionaryPanel,
		onToggleProjectConfigPanel,
		onHandleUndo,
		onHandleRedo,
		canUndo,
		canRedo,
		undoActionDisplayName,
		onShowSoftwareLicense,
		onShowAbout,
		onShowSnapshot,
		onPrevImage,
		onNextImage,
		canPrevImage,
		canNextImage,
		projects,
		currentProjectId,
		onNextMarker,
		onPrevMarker,
		canNextMarker,
		canPrevMarker,
		onExportLabelplus,
		onSaveProject,
		onSaveAs,
		hasUnsaved = false,
		hasProject = false
	}: Props = $props();
	
	// Get modifier key symbols from keyboard shortcut service
	let modifierSymbols = $state(keyboardShortcutService.getModifierSymbols());
	
	onMount(() => {
		// Update symbols on mount to ensure correct platform detection
		modifierSymbols = keyboardShortcutService.getModifierSymbols();
	});
	
	let modifierKey = $derived(modifierSymbols.modifierKey);
	let shiftKey = $derived(modifierSymbols.shiftKey);
	let keySeparator = $derived(modifierSymbols.keySeparator);
	
	// Window title is now managed by titleManager in +layout.svelte
</script>

<div class="title-bar fixed top-0 right-0 left-0 z-[1000] flex transform-gpu items-center will-change-transform bg-theme-surface glass-effect border-theme-outline-variant h-8 justify-between border-b p-0 animate-[fadeIn_0.15s_ease-out]"
>
	<div class="flex items-center gap-4 pl-2 [-webkit-app-region:no-drag]">
		<!-- 菜单栏 -->
		<div class="flex items-center">
			<!-- 文件菜单 -->
			<div class="relative">
				<button
					class="text-theme-on-surface hover:bg-theme-secondary-container/50 cursor-default border-none bg-transparent px-4 py-2 text-sm transition-colors"
					onclick={onToggleFileMenu}
					onmouseenter={onOpenFileMenu}
				>
					文件
				</button>
				{#if showFileMenu}
					<div class="bg-theme-background border-theme-outline absolute top-full left-0 z-[1002] min-w-[200px] rounded border shadow-lg"
					>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onCreateNewProject}
						>
							<span>新建项目</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}N</span>
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onOpenProject}
						>
							<span>打开项目</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}O</span>
						</button>
						
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {hasProject ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={hasProject ? onSaveProject : undefined}
							disabled={!hasProject}
						>
							<span class="text-theme-on-surface">保存</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}S</span>
						</button>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {hasProject ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={hasProject ? onSaveAs : undefined}
							disabled={!hasProject}
						>
							<span class="text-theme-on-surface">另存为...</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}{shiftKey}{keySeparator}S</span>
						</button>
						<div class="relative group">
							<button
								class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {hasProject ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
								disabled={!hasProject}
							>
								<span class="text-theme-on-surface">导出</span>
								<svg class="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
									<path d="M4.5 3L7.5 6L4.5 9" stroke="var(--color-on-surface)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
								</svg>
							</button>
							<div class="bg-theme-background border-theme-outline absolute left-full top-0 z-[1003] {hasProject ? 'invisible group-hover:visible' : 'invisible'} -ml-1 min-w-[150px] rounded border shadow-lg before:content-[''] before:absolute before:top-0 before:left-0 before:w-2 before:h-full before:-translate-x-full">
								<button
									class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
									onclick={onExportLabelplus}
								>
									Labelplus文件
								</button>
							</div>
						</div>
					</div>
				{/if}
			</div>

			<!-- 编辑菜单 -->
			<div class="relative">
				<button
					class="text-theme-on-surface hover:bg-theme-secondary-container/50 cursor-default border-none bg-transparent px-4 py-2 text-sm transition-colors"
					onclick={onToggleEditMenu}
					onmouseenter={onOpenEditMenu}
				>
					编辑
				</button>
				{#if showEditMenu}
					<div class="bg-theme-background border-theme-outline absolute top-full left-0 z-[1002] min-w-[200px] rounded border shadow-lg"
					>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canUndo ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canUndo ? onHandleUndo : undefined}
							disabled={!canUndo}
						>
							<span class="text-theme-on-surface">撤销{undoActionDisplayName ? undoActionDisplayName : ''}</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}Z</span>
						</button>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canRedo ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canRedo ? onHandleRedo : undefined}
							disabled={!canRedo}
						>
							<span class="text-theme-on-surface">重做</span>
							<span class="text-theme-on-surface-variant text-xs">{modifierKey}{keySeparator}{shiftKey}{keySeparator}Z</span>
						</button>
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canPrevMarker ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canPrevMarker ? onPrevMarker : undefined}
							disabled={!canPrevMarker}
						>
							<span class="text-theme-on-surface">上一个标记</span>
							<span class="text-theme-on-surface-variant text-xs">{shiftKey}{keySeparator}Tab</span>
						</button>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canNextMarker ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canNextMarker ? onNextMarker : undefined}
							disabled={!canNextMarker}
						>
							<span class="text-theme-on-surface">下一个标记</span>
							<span class="text-theme-on-surface-variant text-xs">Tab</span>
						</button>
					</div>
				{/if}
			</div>

			<!-- 视图菜单 -->
			<div class="relative">
				<button
					class="text-theme-on-surface hover:bg-theme-secondary-container/50 cursor-default border-none bg-transparent px-4 py-2 text-sm transition-colors"
					onclick={onToggleWindowMenu}
					onmouseenter={onOpenWindowMenu}
				>
					视图
				</button>
				{#if showWindowMenu}
					<div class="bg-theme-background border-theme-outline absolute top-full left-0 z-[1002] min-w-[200px] rounded border shadow-lg"
					>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canPrevImage ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canPrevImage ? onPrevImage : undefined}
							disabled={!canPrevImage}
						>
							<span class="text-theme-on-surface">上一张图片</span>
							<span class="text-theme-on-surface-variant text-xs">Ctrl+←</span>
						</button>
						<button
							class="block w-full border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between {canNextImage ? 'text-theme-on-surface hover:bg-theme-surface-variant cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
							onclick={canNextImage ? onNextImage : undefined}
							disabled={!canNextImage}
						>
							<span class="text-theme-on-surface">下一张图片</span>
							<span class="text-theme-on-surface-variant text-xs">Ctrl+→</span>
						</button>
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onMinimizeWindow}
						>
							最小化
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onMaximizeWindow}
						>
							{isMaximized ? '向下还原' : '最大化'}
						</button>
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onToggleTranslationPanel}
						>
							<span>翻译</span>
							{#if $sidebarState.rightSidebarOpen}
								<span class="text-theme-primary">✓</span>
							{/if}
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onToggleThumbnailPanel}
						>
							<span>缩略图</span>
							{#if $sidebarState.leftSidebarOpen && $sidebarState.leftSidebarType === 'images'}
								<span class="text-theme-primary">✓</span>
							{/if}
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onToggleDictionaryPanel}
						>
							<span>词库</span>
							{#if $sidebarState.leftSidebarOpen && $sidebarState.leftSidebarType === 'dictionary'}
								<span class="text-theme-primary">✓</span>
							{/if}
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors flex items-center justify-between"
							onclick={onToggleProjectConfigPanel}
						>
							<span>项目配置</span>
							{#if $sidebarState.leftSidebarOpen && $sidebarState.leftSidebarType === 'projectSettings'}
								<span class="text-theme-primary">✓</span>
							{/if}
						</button>
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onOpenDebugWindow}
						>
							调试窗口
						</button>
					</div>
				{/if}
			</div>

			<!-- 更多菜单 -->
			<div class="relative">
				<button
					class="text-theme-on-surface hover:bg-theme-secondary-container/50 cursor-default border-none bg-transparent px-4 py-2 text-sm transition-colors"
					onclick={onToggleMoreMenu}
					onmouseenter={onOpenMoreMenu}
				>
					更多
				</button>
				{#if showMoreMenu}
					<div class="bg-theme-background border-theme-outline absolute top-full left-0 z-[1002] min-w-[150px] rounded border shadow-lg"
					>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onShowSnapshot}
						>
							快照
						</button>
						<div class="bg-theme-outline-variant my-1 h-px"></div>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onShowAbout}
						>
							关于
						</button>
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onShowSoftwareLicense}
						>
							软件许可
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- 中间项目选择器作为标题 -->
	<div class="absolute left-1/2 -translate-x-1/2 transform flex items-center [-webkit-app-region:no-drag]">
		<div class="relative">
			<button
				class="text-theme-on-surface hover:text-theme-on-surface/90 hover:bg-theme-secondary-container/50 rounded-lg px-4 py-1.5 text-[13px] font-medium transition-all duration-200 flex items-center gap-2"
				onclick={onToggleProjectMenu}
			>
				<span>
					{projects.find((p) => p.id === currentProjectId)?.name || '选择项目'}{hasUnsaved ? '[*]' : ''}
				</span>
				<svg 
					class="w-3 h-3 transition-transform duration-200 {showProjectMenu ? 'rotate-180' : ''}" 
					viewBox="0 0 12 12" 
					fill="currentColor"
				>
					<path d="M3 4.5L6 7.5L9 4.5" stroke="var(--color-on-surface)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
				</svg>
			</button>
			{#if showProjectMenu}
				<div class="bg-theme-background border-theme-outline absolute top-full left-1/2 -translate-x-1/2 z-[1002] mt-1 min-w-[150px] rounded border shadow-lg"
				>
					{#if projects.length === 0}
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onCreateNewProject}
						>
							创建新项目
						</button>
					{:else}
						{#each projects as project, idx (project.id)}
							<div class="flex items-stretch group">
								<button
									class="text-theme-on-surface hover:bg-theme-surface-variant flex-1 cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
									onclick={() => onSelectProject(idx)}
								>
									{project.name}{undoRedoActions.getProjectState(project.id).hasUnsaved ? '[*]' : ''}
								</button>
								<button
									class="text-theme-on-surface-variant hover:text-theme-error hover:bg-theme-surface-variant opacity-0 group-hover:opacity-100 cursor-pointer border-none bg-transparent px-2 transition-all flex items-center justify-center"
									onclick={(e) => {
										e.stopPropagation();
										onCloseProject(project.id);
									}}
									aria-label="关闭项目"
								>
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
										<path d="M3 3L9 9M3 9L9 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
									</svg>
								</button>
							</div>
						{/each}
						<hr class="border-theme-outline-variant my-1 border-t border-none" />
						<button
							class="text-theme-on-surface hover:bg-theme-surface-variant block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors"
							onclick={onCreateNewProject}
						>
							创建新项目
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- 中间可拖拽区域 -->
	<div class="h-full flex-1 [-webkit-app-region:drag]"></div>

	<div class="flex h-full items-center gap-1 pr-1 [-webkit-app-region:no-drag]">
		<!-- 布局控制按钮组 -->
		<div class="flex items-center gap-1">
			<button
				class="text-theme-on-surface/60 hover:bg-theme-secondary-container/50 hover:text-theme-on-surface/80 cursor-pointer rounded-sm border-none bg-none p-1 transition-colors"
				onclick={onToggleLeftSidebar}
				aria-label="切换左边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-on-surface)" stroke-width="1" class="text-theme-on-surface/60">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="5" y1="1" x2="5" y2="15"/>
					{#if $sidebarState.leftSidebarOpen}
						<rect x="1" y="1" width="4" height="14" fill="var(--color-on-surface)" opacity="1"/>
					{/if}
				</svg>
			</button>
			<button
				class="text-theme-on-surface/60 hover:bg-theme-secondary-container/50 hover:text-theme-on-surface/80 cursor-pointer rounded-sm border-none bg-none p-1 transition-colors"
				onclick={onToggleBottomPanel}
				aria-label="切换下边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-on-surface)" stroke-width="1" class="text-theme-on-surface/60">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="1" y1="11" x2="15" y2="11"/>
					{#if $sidebarState.bottomPanelOpen}
						<rect x="1" y="11" width="14" height="4" fill="var(--color-on-surface)" opacity="1"/>
					{/if}
				</svg>
			</button>
			<button
				class="text-theme-on-surface/60 hover:bg-theme-secondary-container/50 hover:text-theme-on-surface/80 cursor-pointer rounded-sm border-none bg-none p-1 transition-colors"
				onclick={onToggleRightSidebar}
				aria-label="切换右边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-on-surface)" stroke-width="1" class="text-theme-on-surface/60">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="11" y1="1" x2="11" y2="15"/>
					{#if $sidebarState.rightSidebarOpen}
						<rect x="11" y="1" width="4" height="14" fill="var(--color-on-surface)" opacity="1"/>
					{/if}
				</svg>
			</button>
		</div>

		<button
			class="text-theme-on-surface/90 hover:bg-theme-secondary-container/50 flex h-full w-[46px] cursor-pointer items-center justify-center border-none bg-none transition-colors"
			onclick={onMinimizeWindow}
			aria-label="最小化"
		>
			<svg width="10" height="10" viewBox="0 0 10 10">
				<path d="M0 5 L10 5" stroke="var(--color-on-surface)" stroke-width="1" />
			</svg>
		</button>
		<button
			class="text-theme-on-surface/90 hover:bg-theme-secondary-container/50 flex h-full w-[46px] cursor-pointer items-center justify-center border-none bg-none transition-colors"
			onclick={onMaximizeWindow}
			aria-label={isMaximized ? '向下还原' : '最大化'}
		>
			{#if isMaximized}
				<svg width="10" height="10" viewBox="0 0 10 10">
					<path
						d="M1 3 L8 3 L8 10 L1 10 Z"
						stroke="var(--color-on-surface)"
						stroke-width="1"
						fill="none"
					/>
					<path d="M3 1 L10 1 L10 8 L8 8" stroke="var(--color-on-surface)" stroke-width="1" fill="none" />
				</svg>
			{:else}
				<svg width="10" height="10" viewBox="0 0 10 10">
					<path d="M1 1 L9 1 L9 9 L1 9 Z" stroke="var(--color-on-surface)" stroke-width="1" fill="none" />
				</svg>
			{/if}
		</button>
		<button
			class="text-theme-on-surface/90 hover:bg-theme-error hover:text-theme-on-error flex h-full w-[46px] cursor-pointer items-center justify-center border-none bg-none transition-colors"
			onclick={onCloseWindow}
			aria-label="关闭"
		>
			<svg width="10" height="10" viewBox="0 0 10 10">
				<path d="M1 1 L9 9 M9 1 L1 9" stroke="var(--color-on-surface)" stroke-width="1" />
			</svg>
		</button>
	</div>
</div>