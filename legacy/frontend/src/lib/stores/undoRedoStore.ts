import { writable, get, derived } from 'svelte/store';

export interface ProjectUndoRedoState {
	undoActionName: string | null;  // Action name or "none" if nothing to undo
	canRedo: boolean;
	currentCommitId: string | null;
	lastSavedCommitId: string | null;
}

export interface UndoRedoState {
	// Map of project ID to undo/redo state
	projectStates: Map<number, ProjectUndoRedoState>;
}

const initialState: UndoRedoState = {
	projectStates: new Map()
};

export const undoRedoStore = writable<UndoRedoState>(initialState);

export const undoRedoActions = {
	updateProjectState(projectId: number, undoActionName: string | null, canRedo: boolean, currentCommitId: string | null) {
		undoRedoStore.update(state => {
			const newStates = new Map(state.projectStates);
			const existingState = newStates.get(projectId);
			
			// Preserve lastSavedCommitId from existing state
			const lastSavedCommitId = existingState?.lastSavedCommitId || null;
			
			newStates.set(projectId, { 
				undoActionName, 
				canRedo, 
				currentCommitId,
				lastSavedCommitId
			});
			
			return {
				...state,
				projectStates: newStates
			};
		});
	},
	
	markProjectAsSaved(projectId: number) {
		undoRedoStore.update(state => {
			const newStates = new Map(state.projectStates);
			const existingState = newStates.get(projectId);
			
			if (existingState) {
				newStates.set(projectId, {
					...existingState,
					lastSavedCommitId: existingState.currentCommitId
				});
			}
			
			return {
				...state,
				projectStates: newStates
			};
		});
	},

	getProjectState(projectId: number): ProjectUndoRedoState & { hasUnsaved: boolean, canUndo: boolean } {
		const state = get(undoRedoStore);
		const projectState = state.projectStates.get(projectId);
		
		if (!projectState) {
			return { 
				undoActionName: null, 
				canRedo: false, 
				currentCommitId: null,
				lastSavedCommitId: null,
				hasUnsaved: false,
				canUndo: false 
			};
		}
		
		// Calculate hasUnsaved by comparing commit IDs
		const hasUnsaved = projectState.currentCommitId !== projectState.lastSavedCommitId;
		// Calculate canUndo from undoActionName
		const canUndo = projectState.undoActionName !== null && projectState.undoActionName !== 'none';
		
		return {
			...projectState,
			hasUnsaved,
			canUndo
		};
	},

	clearProjectState(projectId: number) {
		undoRedoStore.update(state => {
			const newStates = new Map(state.projectStates);
			newStates.delete(projectId);
			return {
				...state,
				projectStates: newStates
			};
		});
	},

	clearAllStates() {
		undoRedoStore.set(initialState);
	}
};

// Helper function for non-reactive access
export function getUndoRedoStateForProject(projectId: number | null) {
	if (!projectId) {
		return { 
			undoActionName: null, 
			canRedo: false, 
			currentCommitId: null,
			lastSavedCommitId: null,
			hasUnsaved: false,
			canUndo: false 
		};
	}
	
	return undoRedoActions.getProjectState(projectId);
}

// Create a derived store for a specific project's undo/redo state
export function createProjectUndoRedoStore(projectId: number | null) {
	return derived(undoRedoStore, ($undoRedoStore) => {
		if (!projectId) {
			return { 
				undoActionName: null, 
				canRedo: false,
				currentCommitId: null,
				lastSavedCommitId: null,
				hasUnsaved: false,
				canUndo: false 
			};
		}
		
		const projectState = $undoRedoStore.projectStates.get(projectId);
		if (!projectState) {
			return { 
				undoActionName: null, 
				canRedo: false,
				currentCommitId: null,
				lastSavedCommitId: null,
				hasUnsaved: false,
				canUndo: false 
			};
		}
		
		// Calculate hasUnsaved and canUndo
		const hasUnsaved = projectState.currentCommitId !== projectState.lastSavedCommitId;
		const canUndo = projectState.undoActionName !== null && projectState.undoActionName !== 'none';
		
		return {
			...projectState,
			hasUnsaved,
			canUndo
		};
	});
}