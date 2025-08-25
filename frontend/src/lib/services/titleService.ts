import { isTauri } from '../core/tauri';
import { projectStore } from '../stores/projectStore';
import { undoRedoStore } from '../stores/undoRedoStore';
import { titleStore } from '../stores/titleStore';
import { get } from 'svelte/store';
import { getCurrentWindow } from '@tauri-apps/api/window';

class TitleService {
	private unsubscribeApp?: () => void;
	private unsubscribeUndoRedo?: () => void;

	initialize() {
		this.unsubscribeApp = projectStore.subscribe(() => {
			this.updateTitle();
		});

		this.unsubscribeUndoRedo = undoRedoStore.subscribe(() => {
			this.updateTitle();
		});

		this.updateTitle();
	}

	private async updateTitle() {
		const projectState = get(projectStore);
		const undoRedoState = get(undoRedoStore);
		
		const projectName = projectState.currentProjectName;
		const projectId = projectState.currentProjectId;
		
		let hasUnsaved = false;
		if (projectId) {
			const projectState = undoRedoState.projectStates.get(projectId);
			if (projectState) {
				hasUnsaved = projectState.currentCommitId !== projectState.lastSavedCommitId;
			}
		}
		
		const unsavedMarker = hasUnsaved ? '[*]' : '';
		
		if (isTauri()) {
			const title = projectName ? `${projectName}${unsavedMarker}` : 'Bubblefish';
			
			try {
				const appWindow = getCurrentWindow();
				await appWindow.setTitle(title);
			} catch (error) {
				console.error('Failed to set Tauri window title:', error);
			}
			
			if (typeof document !== 'undefined') {
				document.title = title;
			}
			
			titleStore.set({ title, hasUnsaved });
		} else {
			const title = projectName ? `${projectName}${unsavedMarker} - Bubblefish` : 'Bubblefish';
			
			if (typeof document !== 'undefined') {
				document.title = title;
			}
			
			titleStore.set({ title, hasUnsaved });
		}
	}

	destroy() {
		if (this.unsubscribeApp) {
			this.unsubscribeApp();
		}
		if (this.unsubscribeUndoRedo) {
			this.unsubscribeUndoRedo();
		}
	}
}

export const titleService = new TitleService();