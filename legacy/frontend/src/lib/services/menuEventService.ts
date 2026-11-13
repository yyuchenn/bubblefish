import { listen } from '@tauri-apps/api/event';
import { platformService } from './platformService';
import { modalStore } from './modalService';
import { projectService, currentProjectId, projects } from './projectService';
import { imageService } from './imageService';
import { markerService } from './markerService';
import { undoRedoService } from './undoRedoService';
import { layoutActions } from './layoutService';
import { menuService } from './menuService';
import { windowService } from './windowService';
import { get } from 'svelte/store';

type UnlistenFn = () => void;

class MenuEventService {
	private unlisteners: UnlistenFn[] = [];

	async initialize() {
		if (!platformService.isTauri() || platformService.getPlatform() !== 'macos') {
			return;
		}

		try {
			// File menu events
			this.unlisteners.push(await listen('menu:file:new-project', () => {
				this.handleNewProject();
			}));

			this.unlisteners.push(await listen('menu:file:open-project', () => {
				this.handleOpenProject();
			}));

			this.unlisteners.push(await listen('menu:file:save', () => {
				this.handleSave();
			}));

			this.unlisteners.push(await listen('menu:file:save-as', () => {
				this.handleSaveAs();
			}));

			this.unlisteners.push(await listen('menu:file:export', () => {
				this.handleExport();
			}));

			// Edit menu events
			this.unlisteners.push(await listen('menu:edit:undo', () => {
				this.handleUndo();
			}));

			this.unlisteners.push(await listen('menu:edit:redo', () => {
				this.handleRedo();
			}));

			this.unlisteners.push(await listen('menu:edit:next-marker', () => {
				this.handleNextMarker();
			}));

			this.unlisteners.push(await listen('menu:edit:prev-marker', () => {
				this.handlePrevMarker();
			}));

			// Window menu events
			this.unlisteners.push(await listen('menu:window:minimize', () => {
				// Window minimize is handled by backend
			}));

			this.unlisteners.push(await listen('menu:window:maximize', () => {
				// Window maximize is handled by backend
			}));

			this.unlisteners.push(await listen('menu:window:translation', () => {
				this.handleToggleTranslation();
			}));

			this.unlisteners.push(await listen('menu:window:thumbnail', () => {
				this.handleToggleThumbnail();
			}));

			this.unlisteners.push(await listen('menu:window:dictionary', () => {
				this.handleToggleDictionary();
			}));

			this.unlisteners.push(await listen('menu:window:project-config', () => {
				this.handleToggleProjectConfig();
			}));

			// View menu events
			this.unlisteners.push(await listen('menu:view:prev-image', () => {
				this.handlePrevImage();
			}));

			this.unlisteners.push(await listen('menu:view:next-image', () => {
				this.handleNextImage();
			}));

			// Project menu events
			this.unlisteners.push(await listen('menu:project:select', (event: { payload: unknown }) => {
				const projectIndex = event.payload;
				if (typeof projectIndex === 'number') {
					this.handleSelectProject(projectIndex);
				}
			}));

			// More menu events
			this.unlisteners.push(await listen('menu:more:snapshots', () => {
				this.handleShowSnapshots();
			}));

			this.unlisteners.push(await listen('menu:more:version-info', () => {
				this.handleShowAbout();
			}));

			this.unlisteners.push(await listen('menu:more:software-license', () => {
				this.handleShowLicense();
			}));

			this.unlisteners.push(await listen('menu:more:quit', async () => {
				await this.handleQuit();
			}));

		} catch (error) {
			console.error('Error setting up menu listeners:', error);
		}
	}

	destroy() {
		this.unlisteners.forEach(unlisten => unlisten());
		this.unlisteners = [];
	}

	// File menu handlers
	private handleNewProject() {
		const projectsValue = get(projects);
		const uploadDefaultName = `项目 ${projectsValue.length + 1}`;
		menuService.closeAllMenus();
		modalStore.showModal('newProject', {
			defaultName: uploadDefaultName
		});
	}

	private handleOpenProject() {
		menuService.closeAllMenus();
		modalStore.showModal('openProject');
	}

	private async handleSave() {
		const projectId = get(currentProjectId);
		if (projectId) {
			await projectService.handleSaveProject(projectId);
		}
		menuService.closeAllMenus();
	}

	private async handleSaveAs() {
		const projectId = get(currentProjectId);
		if (projectId) {
			await projectService.handleSaveAs(projectId);
		}
		menuService.closeAllMenus();
	}

	private async handleExport() {
		const projectId = get(currentProjectId);
		if (projectId) {
			await projectService.handleExportLabelplus(projectId);
		}
		menuService.closeAllMenus();
	}

	// Edit menu handlers
	private async handleUndo() {
		try {
			await undoRedoService.undo();
		} catch (error) {
			console.error('Undo failed:', error);
		}
		menuService.closeAllMenus();
	}

	private async handleRedo() {
		try {
			await undoRedoService.redo();
		} catch (error) {
			console.error('Redo failed:', error);
		}
		menuService.closeAllMenus();
	}

	private handleNextMarker() {
		markerService.navigateToNextMarker();
		menuService.closeAllMenus();
	}

	private handlePrevMarker() {
		markerService.navigateToPrevMarker();
		menuService.closeAllMenus();
	}

	// Window menu handlers
	private handleToggleTranslation() {
		layoutActions.toggleRightSidebar();
		menuService.closeAllMenus();
	}

	private handleToggleThumbnail() {
		layoutActions.toggleLeftSidebarType('images');
		menuService.closeAllMenus();
	}

	private handleToggleDictionary() {
		layoutActions.toggleLeftSidebarType('dictionary');
		menuService.closeAllMenus();
	}

	private handleToggleProjectConfig() {
		layoutActions.toggleLeftSidebarType('projectSettings');
		menuService.closeAllMenus();
	}

	// View menu handlers
	private handlePrevImage() {
		imageService.prevImage();
		menuService.closeAllMenus();
	}

	private handleNextImage() {
		imageService.nextImage();
		menuService.closeAllMenus();
	}

	// Project menu handlers
	private handleSelectProject(index: number) {
		const projectsValue = get(projects);
		if (index >= 0 && index < projectsValue.length) {
			projectService.setCurrentProject(projectsValue[index]?.id || null);
		}
		menuService.closeAllMenus();
	}

	// More menu handlers
	private handleShowSnapshots() {
		modalStore.showModal('snapshot');
		menuService.closeAllMenus();
	}

	private handleShowAbout() {
		modalStore.showModal('about');
		menuService.closeAllMenus();
	}

	private handleShowLicense() {
		modalStore.showModal('license');
		menuService.closeAllMenus();
	}

	private async handleQuit() {
		await windowService.closeWindow();
	}
}

export const menuEventService = new MenuEventService();