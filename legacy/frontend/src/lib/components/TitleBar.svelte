<script lang="ts">
	import { onMount } from 'svelte';
	import { platformService } from '$lib/services/platformService';
	import type { Platform } from '../core/tauri.js';
	import { projects, currentProjectId, projectService } from '$lib/services/projectService';
	import { modalStore } from '$lib/services/modalService';
	import { imageService, canNavigatePrev, canNavigateNext } from '$lib/services/imageService';
	import { markerService } from '$lib/services/markerService';
	import { toggleLogViewer } from '$lib/services/logViewerService';
	import './titlebar/titlebar-global.css';
	import { undoRedoService, undoRedoStore } from '$lib/services/undoRedoService';
	import { sidebarState, layoutActions } from '$lib/services/layoutService';
	import { menuService, menuState } from '$lib/services/menuService';
	import { windowService, windowState } from '$lib/services/windowService';
	import { menuEventService } from '$lib/services/menuEventService';
	import TitleBarMac from './titlebar/TitleBarMac.svelte';
	import TitleBarWindows from './titlebar/TitleBarWindows.svelte';
	import TitleBarWeb from './titlebar/TitleBarWeb.svelte';

	let platform: Platform = 'unknown' as Platform;
	let environmentReady = $state(false);

	// Subscribe to store states
	let isMaximized = $derived($windowState.isMaximized);
	let showFileMenu = $derived($menuState.fileMenu);
	let showEditMenu = $derived($menuState.editMenu);
	let showWindowMenu = $derived($menuState.windowMenu);
	let showMoreMenu = $derived($menuState.moreMenu);
	let showProjectMenu = $derived($menuState.projectMenu);
	let hasAnyMenuOpen = $derived(showFileMenu || showEditMenu || showWindowMenu || showMoreMenu || showProjectMenu);


	// 监听布局状态变化，更新 macOS 菜单选中状态
	$effect(() => {
		if (environmentReady && platform === 'macos' && platformService.isTauri()) {
			platformService.updateMenuCheckedState('translation', $sidebarState.rightSidebarOpen);
			const isLeftOpen = $sidebarState.leftSidebarOpen;
			const leftType = $sidebarState.leftSidebarType;
			platformService.updateMenuCheckedState('thumbnail', isLeftOpen && leftType === 'images');
			platformService.updateMenuCheckedState('dictionary', isLeftOpen && leftType === 'dictionary');
			platformService.updateMenuCheckedState('project-config', isLeftOpen && leftType === 'projectSettings');
		}
	});

	// 监听导航状态变化，更新 macOS 菜单启用状态
	$effect(() => {
		if (environmentReady && platform === 'macos' && platformService.isTauri()) {
			platformService.updateMenuEnabledState('prev-image', $canNavigatePrev);
			platformService.updateMenuEnabledState('next-image', $canNavigateNext);
		}
	});

	onMount(() => {
		let cleanupBeforeUnload: (() => void) | undefined;
		
		// Setup beforeunload handler for web platform
		if (!platformService.isTauri()) {
			cleanupBeforeUnload = windowService.setupBeforeUnloadHandler();
		}

		const checkEnvironment = async () => {
			const isInTauri = platformService.isTauri();
			if (isInTauri) {
				platform = platformService.getPlatform();
				console.log('Detected platform:', platform);

				// Initialize window service
				await windowService.initialize();

				// Initialize menu event service for macOS
				if (platform === 'macos') {
					await menuEventService.initialize();
				}
			}
			environmentReady = true;
		};

		requestAnimationFrame(checkEnvironment);

		return () => {
			if (cleanupBeforeUnload) {
				cleanupBeforeUnload();
			}
			menuEventService.destroy();
		};
	});

	// Window operations
	const minimizeWindow = () => windowService.minimizeWindow();
	const maximizeWindow = () => windowService.maximizeWindow();
	const closeWindow = () => windowService.closeWindow();

	// Debug and modal operations
	function openDebugWindow() {
		toggleLogViewer();
		menuService.closeAllMenus();
	}

	function createNewProject() {
		const uploadDefaultName = `项目 ${$projects.length + 1}`;
		menuService.closeAllMenus();
		modalStore.showModal('newProject', {
			defaultName: uploadDefaultName
		});
	}

	function openProject() {
		menuService.closeAllMenus();
		modalStore.showModal('openProject');
	}

	function selectProject(index: number) {
		projectService.setCurrentProject($projects[index]?.id || null);
		menuService.closeAllMenus();
	}

	// Menu operations
	const toggleFileMenu = () => menuService.toggleMenu('fileMenu');
	const toggleEditMenu = () => menuService.toggleMenu('editMenu');
	const toggleWindowMenu = () => menuService.toggleMenu('windowMenu');
	const toggleProjectMenu = () => menuService.toggleMenu('projectMenu');
	const toggleMoreMenu = () => menuService.toggleMenu('moreMenu');
	const openFileMenu = () => menuService.openMenu('fileMenu');
	const openEditMenu = () => menuService.openMenu('editMenu');
	const openWindowMenu = () => menuService.openMenu('windowMenu');
	const openMoreMenu = () => menuService.openMenu('moreMenu');

	function handleOverlayClick(event: MouseEvent) {
		// 阻止事件传播，防止触发下层元素的点击事件
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		
		// 关闭所有菜单
		menuService.closeAllMenus();
	}
	
	function handleOverlayContextMenu(event: MouseEvent) {
		// 阻止默认的右键菜单
		event.preventDefault();
		event.stopPropagation();
		
		// 关闭所有菜单
		menuService.closeAllMenus();
	}



	// Layout operations
	const toggleLeftSidebar = () => layoutActions.toggleLeftSidebarSimple();
	const toggleBottomPanel = () => $sidebarState.bottomPanelOpen ? layoutActions.closeBottomPanel() : layoutActions.openBottomPanel();
	const toggleRightSidebar = () => $sidebarState.rightSidebarOpen ? layoutActions.closeRightSidebar() : layoutActions.openRightSidebar();

	// Panel operations
	function toggleTranslationPanel() {
		layoutActions.toggleRightSidebar();
		menuService.closeAllMenus();
	}

	function toggleThumbnailPanel() {
		layoutActions.toggleLeftSidebarType('images');
		menuService.closeAllMenus();
	}

	function toggleDictionaryPanel() {
		layoutActions.toggleLeftSidebarType('dictionary');
		menuService.closeAllMenus();
	}

	function toggleProjectConfigPanel() {
		layoutActions.toggleLeftSidebarType('projectSettings');
		menuService.closeAllMenus();
	}

	let isMac = $derived(platform === 'macos');
	let isWindows = $derived(platform === 'windows');
	let isWeb = $derived(!platformService.isTauri());
	
	// Undo/Redo availability states - derived from store
	let canUndo = $derived((() => {
		const projectId = $currentProjectId;
		if (!projectId) return false;
		const projectState = $undoRedoStore.projectStates.get(projectId);
		const undoActionName = projectState?.undoActionName;
		return undoActionName !== null && undoActionName !== undefined && undoActionName !== 'none';
	})());
	
	let undoActionDisplayName = $derived((() => {
		const projectId = $currentProjectId;
		if (!projectId) return null;
		const projectState = $undoRedoStore.projectStates.get(projectId);
		return undoRedoService.getUndoActionDisplayName(projectState?.undoActionName || null);
	})());
	
	let canRedo = $derived((() => {
		const projectId = $currentProjectId;
		if (!projectId) return false;
		const projectState = $undoRedoStore.projectStates.get(projectId);
		return projectState?.canRedo || false;
	})());
	let hasUnsaved = $derived((() => {
		const projectId = $currentProjectId;
		if (!projectId) return false;
		const projectState = $undoRedoStore.projectStates.get(projectId);
		if (!projectState) return false;
		return projectState.currentCommitId !== projectState.lastSavedCommitId;
	})());
	
	// Marker navigation availability states
	let canNextMarker = $derived(markerService.canNavigateNext());
	let canPrevMarker = $derived(markerService.canNavigatePrev());
	
	// Check if a project is currently open
	let hasProject = $derived($currentProjectId !== null);
	
	
	
	// Monitor undo/redo state changes and update macOS native menu
	$effect(() => {
		if (environmentReady && platform === 'macos' && platformService.isTauri()) {
			platformService.updateMenuEnabledState('undo', canUndo);
			platformService.updateMenuEnabledState('redo', canRedo);
			platformService.updateMenuEnabledState('next-marker', canNextMarker);
			platformService.updateMenuEnabledState('prev-marker', canPrevMarker);
			platformService.updateMenuEnabledState('save', hasProject);
			platformService.updateMenuEnabledState('save-as', hasProject);
			platformService.updateMenuEnabledState('export-submenu', hasProject);
			
			// Update undo menu text with action name
			const undoText = undoActionDisplayName ? `撤销${undoActionDisplayName}` : '撤销';
			platformService.updateMenuText('undo', undoText);
		}
	});
	
	// Undo/Redo operations
	async function handleUndo() {
		try {
			await undoRedoService.undo();
		} catch (error) {
			console.error('Undo failed:', error);
		}
		menuService.closeAllMenus();
	}
	
	async function handleRedo() {
		try {
			await undoRedoService.redo();
		} catch (error) {
			console.error('Redo failed:', error);
		}
		menuService.closeAllMenus();
	}

	// Modal operations
	function showSoftwareLicense() {
		modalStore.showModal('license');
		menuService.closeAllMenus();
	}

	function showAbout() {
		modalStore.showModal('about');
		menuService.closeAllMenus();
	}
	
	function showSnapshot() {
		modalStore.showModal('snapshot');
		menuService.closeAllMenus();
	}

	// Image navigation operations
	function handlePrevImage() {
		imageService.prevImage();
		menuService.closeAllMenus();
	}

	function handleNextImage() {
		imageService.nextImage();
		menuService.closeAllMenus();
	}

	// Project operations
	async function handleCloseProject(projectId: number) {
		await projectService.handleCloseProject(projectId);
		menuService.closeAllMenus();
	}
	
	// Marker navigation operations
	function handleNextMarker() {
		markerService.navigateToNextMarker();
		menuService.closeAllMenus();
	}

	function handlePrevMarker() {
		markerService.navigateToPrevMarker();
		menuService.closeAllMenus();
	}
	
	// Save operations
	async function handleSaveProject() {
		if ($currentProjectId) {
			await projectService.handleSaveProject($currentProjectId);
		}
		menuService.closeAllMenus();
	}
	
	async function handleSaveAs() {
		if ($currentProjectId) {
			await projectService.handleSaveAs($currentProjectId);
		}
		menuService.closeAllMenus();
	}

	async function handleExportLabelplus() {
		if ($currentProjectId) {
			await projectService.handleExportLabelplus($currentProjectId);
		}
		menuService.closeAllMenus();
	}
</script>

{#if environmentReady}
	{#if hasAnyMenuOpen}
		<!-- 透明遮罩层，用于拦截点击事件 -->
		<button
			type="button"
			class="fixed inset-0 z-[999] cursor-default"
			style="background-color: transparent; border: none; padding: 0; margin: 0;"
			aria-label="Close menu"
			onclick={handleOverlayClick}
			oncontextmenu={handleOverlayContextMenu}
			onmousedown={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
		></button>
	{/if}
		<!-- macOS 样式 -->
		{#if isMac}
		<TitleBarMac
			{showProjectMenu}
			onToggleProjectMenu={toggleProjectMenu}
			onSelectProject={selectProject}
			onCreateNewProject={createNewProject}
			onCloseProject={handleCloseProject}
			onToggleLeftSidebar={toggleLeftSidebar}
			onToggleBottomPanel={toggleBottomPanel}
			onToggleRightSidebar={toggleRightSidebar}
			projects={$projects}
			currentProjectId={$currentProjectId}
			{hasUnsaved}
		/>
		{/if}

		<!-- Windows 样式 -->
		{#if isWindows}
		<TitleBarWindows
			{showFileMenu}
			{showEditMenu}
			{showWindowMenu}
			{showMoreMenu}
			{showProjectMenu}
			{isMaximized}
			onToggleFileMenu={toggleFileMenu}
			onToggleEditMenu={toggleEditMenu}
			onToggleWindowMenu={toggleWindowMenu}
			onToggleMoreMenu={toggleMoreMenu}
			onToggleProjectMenu={toggleProjectMenu}
			onOpenFileMenu={openFileMenu}
			onOpenEditMenu={openEditMenu}
			onOpenWindowMenu={openWindowMenu}
			onOpenMoreMenu={openMoreMenu}
			onCreateNewProject={createNewProject}
			onOpenProject={openProject}
			onSelectProject={selectProject}
			onCloseProject={handleCloseProject}
			onMinimizeWindow={minimizeWindow}
			onMaximizeWindow={maximizeWindow}
			onCloseWindow={closeWindow}
			onOpenDebugWindow={openDebugWindow}
			onToggleLeftSidebar={toggleLeftSidebar}
			onToggleBottomPanel={toggleBottomPanel}
			onToggleRightSidebar={toggleRightSidebar}
			onToggleTranslationPanel={toggleTranslationPanel}
			onToggleThumbnailPanel={toggleThumbnailPanel}
			onToggleDictionaryPanel={toggleDictionaryPanel}
			onToggleProjectConfigPanel={toggleProjectConfigPanel}
			onHandleUndo={handleUndo}
			onHandleRedo={handleRedo}
			{canUndo}
			{canRedo}
			{undoActionDisplayName}
			onShowSoftwareLicense={showSoftwareLicense}
			onShowAbout={showAbout}
			onShowSnapshot={showSnapshot}
			onPrevImage={handlePrevImage}
			onNextImage={handleNextImage}
			canPrevImage={$canNavigatePrev}
			canNextImage={$canNavigateNext}
			onNextMarker={handleNextMarker}
			onPrevMarker={handlePrevMarker}
			{canNextMarker}
			{canPrevMarker}
			onExportLabelplus={handleExportLabelplus}
			onSaveProject={handleSaveProject}
			onSaveAs={handleSaveAs}
			projects={$projects}
			currentProjectId={$currentProjectId}
			{hasUnsaved}
			{hasProject}
		/>
		{/if}

		<!-- Web 样式 -->
		{#if isWeb}
		<TitleBarWeb
			{showFileMenu}
			{showEditMenu}
			{showWindowMenu}
			{showMoreMenu}
			{showProjectMenu}
			onToggleFileMenu={toggleFileMenu}
			onToggleEditMenu={toggleEditMenu}
			onToggleWindowMenu={toggleWindowMenu}
			onToggleMoreMenu={toggleMoreMenu}
			onToggleProjectMenu={toggleProjectMenu}
			onOpenFileMenu={openFileMenu}
			onOpenEditMenu={openEditMenu}
			onOpenWindowMenu={openWindowMenu}
			onOpenMoreMenu={openMoreMenu}
			onCreateNewProject={createNewProject}
			onOpenProject={openProject}
			onSelectProject={selectProject}
			onCloseProject={handleCloseProject}
			onOpenDebugWindow={openDebugWindow}
			onToggleLeftSidebar={toggleLeftSidebar}
			onToggleBottomPanel={toggleBottomPanel}
			onToggleRightSidebar={toggleRightSidebar}
			onToggleTranslationPanel={toggleTranslationPanel}
			onToggleThumbnailPanel={toggleThumbnailPanel}
			onToggleDictionaryPanel={toggleDictionaryPanel}
			onToggleProjectConfigPanel={toggleProjectConfigPanel}
			onHandleUndo={handleUndo}
			onHandleRedo={handleRedo}
			{canUndo}
			{canRedo}
			{undoActionDisplayName}
			onShowSoftwareLicense={showSoftwareLicense}
			onShowAbout={showAbout}
			onShowSnapshot={showSnapshot}
			onPrevImage={handlePrevImage}
			onNextImage={handleNextImage}
			canPrevImage={$canNavigatePrev}
			canNextImage={$canNavigateNext}
			onNextMarker={handleNextMarker}
			onPrevMarker={handlePrevMarker}
			{canNextMarker}
			{canPrevMarker}
			onExportLabelplus={handleExportLabelplus}
			onSaveProject={handleSaveProject}
			onSaveAs={handleSaveAs}
			projects={$projects}
			currentProjectId={$currentProjectId}
			{hasUnsaved}
			{hasProject}
		/>
		{/if}


{/if}

