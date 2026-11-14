import { writable, get } from 'svelte/store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { platformService } from './platformService';
import { projects, currentProjectId } from './projectService';
import { modalStore } from './modalService';
import { undoRedoActions } from './undoRedoService';
import { projectService } from './projectService';

interface WindowState {
	isMaximized: boolean;
	appWindow: ReturnType<typeof getCurrentWindow> | undefined;
}

function createWindowService() {
	const windowState = writable<WindowState>({
		isMaximized: false,
		appWindow: undefined
	});

	async function initialize() {
		if (!platformService.isTauri()) return;

		try {
			const appWindow = getCurrentWindow();
			windowState.update(state => ({ ...state, appWindow }));

			await appWindow.onResized(async () => {
				await checkWindowState();
			});

			await appWindow.onCloseRequested(async (event) => {
				const hasAnyUnsaved = get(projects).some(project => {
					const projectState = undoRedoActions.getProjectState(project.id);
					return projectState.hasUnsaved;
				});

				if (hasAnyUnsaved) {
					event.preventDefault();
					await closeWindow();
				}
			});

			await checkWindowState();
		} catch (error) {
			console.error('Failed to initialize window service:', error);
		}
	}

	async function checkWindowState() {
		const state = get(windowState);
		if (state.appWindow) {
			try {
				const isMaximized = await state.appWindow.isMaximized();
				windowState.update(s => ({ ...s, isMaximized }));
			} catch (error) {
				console.error('Failed to check window state:', error);
			}
		}
	}

	async function minimizeWindow() {
		const state = get(windowState);
		if (state.appWindow) {
			await state.appWindow.minimize();
		}
	}

	async function maximizeWindow() {
		const state = get(windowState);
		if (state.appWindow) {
			const isMaximized = get(windowState).isMaximized;
			if (isMaximized) {
				await state.appWindow.unmaximize();
			} else {
				await state.appWindow.maximize();
			}
			await checkWindowState();
		}
	}

	async function closeWindow() {
		const state = get(windowState);
		if (!state.appWindow) return;

		const unsavedProjects = get(projects).filter(project => {
			const projectState = undoRedoActions.getProjectState(project.id);
			return projectState.hasUnsaved;
		});

		if (unsavedProjects.length > 0) {
			const savedProjects = get(projects).filter(project => {
				const projectState = undoRedoActions.getProjectState(project.id);
				return !projectState.hasUnsaved;
			});

			for (const project of savedProjects) {
				await performCloseProject(project.id);
			}

			if (unsavedProjects.length > 0) {
				await projectService.setCurrentProject(unsavedProjects[0].id);

				modalStore.showModal('confirm', {
					title: '关闭应用',
					message: `项目 "${unsavedProjects[0].name}" 有未保存的修改。确定要关闭吗？`,
					confirmText: '关闭',
					cancelText: '取消',
					onConfirm: async () => {
						await performCloseProject(unsavedProjects[0].id);

						const remainingUnsaved = get(projects).filter(project => {
							const projectState = undoRedoActions.getProjectState(project.id);
							return projectState.hasUnsaved;
						});

						if (remainingUnsaved.length > 0) {
							await closeWindow();
						} else {
							if (state.appWindow) {
								await state.appWindow.close();
							}
						}
					}
				});
			}
		} else {
			await state.appWindow.close();
		}
	}

	async function performCloseProject(projectId: number) {
		try {
			if (get(currentProjectId) === projectId) {
				await projectService.setCurrentProject(null);
			}

			const success = await projectService.deleteProject(projectId);
			if (success) {
				const currentProjects = get(projects);
				projectService.setProjects(currentProjects.filter((p) => p.id !== projectId));
				undoRedoActions.clearProjectState(projectId);

				const remainingProjects = get(projects).filter(p => p.id !== projectId);
				if (remainingProjects.length > 0 && get(currentProjectId) === null) {
					await projectService.setCurrentProject(remainingProjects[0].id);
				}
			}
		} catch (error) {
			console.error('Failed to close project:', error);
		}
	}

	function setupBeforeUnloadHandler() {
		if (platformService.isTauri()) return;

		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			const hasAnyUnsaved = get(projects).some(project => {
				const projectState = undoRedoActions.getProjectState(project.id);
				return projectState.hasUnsaved;
			});

			if (hasAnyUnsaved) {
				event.preventDefault();
				event.returnValue = '';
				return '';
			}
			return undefined;
		};

		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	}

	return {
		windowState,
		initialize,
		minimizeWindow,
		maximizeWindow,
		closeWindow,
		setupBeforeUnloadHandler,
		performCloseProject
	};
}

export const windowService = createWindowService();
export const { windowState } = windowService;