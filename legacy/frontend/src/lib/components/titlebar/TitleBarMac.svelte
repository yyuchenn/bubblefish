<script lang="ts">
	import { sidebarState } from '$lib/services/layoutService';
	import { onMount } from 'svelte';
	import { undoRedoStore } from '$lib/services/undoRedoService';

	interface Props {
		showProjectMenu: boolean;
		onToggleProjectMenu: () => void;
		onSelectProject: (index: number) => void;
		onCreateNewProject: () => void;
		onCloseProject: (projectId: number) => void;
		onToggleLeftSidebar: () => void;
		onToggleBottomPanel: () => void;
		onToggleRightSidebar: () => void;
		projects: Array<{ id: number; name: string }>;
		currentProjectId: number | null;
		hasUnsaved?: boolean;
	}

	let {
		showProjectMenu,
		onToggleProjectMenu,
		onSelectProject,
		onCreateNewProject,
		onCloseProject,
		onToggleLeftSidebar,
		onToggleBottomPanel,
		onToggleRightSidebar,
		projects,
		currentProjectId,
		hasUnsaved = false
	}: Props = $props();
	
	// 检测系统是否为深色模式
	let isSystemDarkMode = $state(false);
	
	onMount(() => {
		// 检测系统主题
		const checkSystemTheme = () => {
			isSystemDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		};
		
		checkSystemTheme();
		
		// 监听系统主题变化
		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		mediaQuery.addEventListener('change', checkSystemTheme);
		
		return () => {
			mediaQuery.removeEventListener('change', checkSystemTheme);
		};
	});
	
	// Window title is now managed by titleManager in +layout.svelte
	
	// 计算原生标题的预估宽度
	let titleWidth = $derived((() => {
		const currentProject = projects.find((p) => p.id === currentProjectId);
		const unsavedMarker = hasUnsaved ? '[*]' : '';
		// No longer include " - Bubblefish" for desktop
		const titleText = currentProject ? `${currentProject.name}${unsavedMarker}` : 'Bubblefish';
		
		// 更精确的宽度计算
		let width = 0;
		for (const char of titleText) {
			if (/[\u4e00-\u9fa5]/.test(char)) {
				// 中文字符
				width += 13;
			} else if (/[A-Z]/.test(char)) {
				// 大写字母
				width += 8;
			} else if (/[a-z0-9]/.test(char)) {
				// 小写字母和数字
				width += 6;
			} else {
				// 其他字符（空格、标点等）
				width += 5;
			}
		}
		
		// 添加额外的缓冲空间 - reduced buffer since title is shorter
		const finalWidth = Math.max(width + 40, 80); // 最小 80px，添加 40px 缓冲
		return finalWidth;
	})());
</script>

<!-- macOS标题栏：使用原生菜单，只保留项目选择器和布局控制 -->
<div
	class="title-bar fixed top-0 right-0 left-0 z-[1000] flex transform-gpu items-center will-change-transform h-[28px] justify-between border-none p-0 animate-[fadeIn_0.15s_ease-out] {isSystemDarkMode ? 'bg-[#2a2a2a]' : 'bg-[#f6f6f6]'}"
	data-tauri-drag-region={true}
>
	<!-- 左侧空白区域（系统按钮区域） -->
	<div class="pointer-events-none h-full w-[70px]"></div>

	<!-- 中间区域：为原生标题留出空间，项目选择器放在旁边 -->
	<div class="pointer-events-auto absolute left-1/2 -translate-x-1/2 transform flex items-center [-webkit-app-region:no-drag]">
		<!-- 透明占位区域，为原生标题留出空间 -->
		<div 
			class="pointer-events-none transition-all duration-300" 
			style="width: {titleWidth}px"
		></div>
		
		<!-- 项目选择下拉按钮 -->
		<div class="relative ml-2">
			<button
				class="rounded-md px-2 py-1 text-[13px] font-medium backdrop-blur-[10px] transition-all duration-200 flex items-center gap-1 select-none h-[22px] {isSystemDarkMode ? 'text-gray-300 hover:text-white bg-gray-800/30 hover:bg-gray-700/50' : 'text-gray-600 hover:text-gray-900 bg-white/30 hover:bg-white/50'}"
				onclick={onToggleProjectMenu}
				title="选择项目"
				aria-label="选择项目"
			>
				<svg 
					class="w-3 h-3 transition-transform duration-200 {showProjectMenu ? 'rotate-180' : ''}" 
					viewBox="0 0 12 12" 
					fill="currentColor"
				>
					<path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
				</svg>
			</button>
			{#if showProjectMenu}
				<div class="absolute top-full left-0 z-[1002] mt-1 min-w-[150px] rounded border shadow-lg {isSystemDarkMode ? 'bg-[#2a2a2a] border-gray-600' : 'bg-white border-gray-300'}"
				>
					{#if projects.length === 0}
						<button
							class="block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors {isSystemDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'}"
							onclick={onCreateNewProject}
						>
							创建新项目
						</button>
					{:else}
						{#each projects as project, idx (project.id)}
							<div class="flex items-stretch group">
								<button
									class="flex-1 cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors {isSystemDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'}"
									onclick={() => onSelectProject(idx)}
								>
									{project.name}{(() => {
										const state = $undoRedoStore.projectStates.get(project.id);
										return state && state.currentCommitId !== state.lastSavedCommitId ? '[*]' : '';
									})()}
								</button>
								<button
									class="opacity-0 group-hover:opacity-100 cursor-pointer border-none bg-transparent px-2 transition-all flex items-center justify-center {isSystemDarkMode ? 'text-gray-400 hover:text-red-400 hover:bg-gray-700' : 'text-gray-500 hover:text-red-500 hover:bg-gray-100'}"
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
						<hr class="my-1 border-t {isSystemDarkMode ? 'border-gray-600' : 'border-gray-200'}" />
						<button
							class="block w-full cursor-pointer border-none bg-transparent px-4 py-2 text-left text-sm transition-colors {isSystemDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'}"
							onclick={onCreateNewProject}
						>
							创建新项目
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- 右侧布局控制按钮组 -->
	<div class="pointer-events-auto flex items-center gap-2 pr-4 [-webkit-app-region:no-drag]">
		<div class="flex items-center gap-1">
			<button
				class="cursor-pointer rounded border-none bg-none p-1.5 backdrop-blur-[10px] transition-all duration-200 ease-out hover:scale-105 {isSystemDarkMode ? 'text-gray-400 bg-gray-800/30 hover:bg-gray-700/50 hover:text-gray-200' : 'text-gray-600 bg-white/30 hover:bg-white/50 hover:text-gray-800'}"
				onclick={onToggleLeftSidebar}
				aria-label="切换左边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="5" y1="1" x2="5" y2="15"/>
					{#if $sidebarState.leftSidebarOpen}
						<rect x="1" y="1" width="4" height="14" fill="currentColor" opacity="1"/>
					{/if}
				</svg>
			</button>
			<button
				class="cursor-pointer rounded border-none bg-none p-1.5 backdrop-blur-[10px] transition-all duration-200 ease-out hover:scale-105 {isSystemDarkMode ? 'text-gray-400 bg-gray-800/30 hover:bg-gray-700/50 hover:text-gray-200' : 'text-gray-600 bg-white/30 hover:bg-white/50 hover:text-gray-800'}"
				onclick={onToggleBottomPanel}
				aria-label="切换下边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="1" y1="11" x2="15" y2="11"/>
					{#if $sidebarState.bottomPanelOpen}
						<rect x="1" y="11" width="14" height="4" fill="currentColor" opacity="1"/>
					{/if}
				</svg>
			</button>
			<button
				class="cursor-pointer rounded border-none bg-none p-1.5 backdrop-blur-[10px] transition-all duration-200 ease-out hover:scale-105 {isSystemDarkMode ? 'text-gray-400 bg-gray-800/30 hover:bg-gray-700/50 hover:text-gray-200' : 'text-gray-600 bg-white/30 hover:bg-white/50 hover:text-gray-800'}"
				onclick={onToggleRightSidebar}
				aria-label="切换右边栏"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1">
					<rect x="1" y="1" width="14" height="14" rx="1"/>
					<line x1="11" y1="1" x2="11" y2="15"/>
					{#if $sidebarState.rightSidebarOpen}
						<rect x="11" y="1" width="4" height="14" fill="currentColor" opacity="1"/>
					{/if}
				</svg>
			</button>
		</div>
	</div>
</div>