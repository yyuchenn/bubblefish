import { writable, derived, get } from 'svelte/store';
import type { TranslationProject } from '../types';

export interface ProjectState {
	projects: TranslationProject[];
	currentProjectId: number | null;
	currentProjectName: string;
}

const initialState: ProjectState = {
	projects: [],
	currentProjectId: null,
	currentProjectName: ''
};

function createProjectStore() {
	const { subscribe, set, update } = writable<ProjectState>(initialState);

	return {
		subscribe,
		
		// State setters
		setProjects(projects: TranslationProject[]) {
			update(state => ({
				...state,
				projects
			}));
		},

		addProject(project: TranslationProject) {
			update(state => {
				const exists = state.projects.some(p => p.id === project.id);
				if (!exists) {
					return {
						...state,
						projects: [...state.projects, project]
					};
				}
				return state;
			});
		},

		removeProject(projectId: number) {
			update(state => ({
				...state,
				projects: state.projects.filter(p => p.id !== projectId),
				...(state.currentProjectId === projectId && {
					currentProjectId: null,
					currentProjectName: ''
				})
			}));
		},

		updateProject(projectId: number, updates: Partial<TranslationProject>) {
			update(state => ({
				...state,
				projects: state.projects.map(p => 
					p.id === projectId ? { ...p, ...updates } : p
				),
				...(state.currentProjectId === projectId && updates.name && {
					currentProjectName: updates.name
				})
			}));
		},

		setCurrentProject(projectId: number | null, projectName: string = '') {
			update(state => ({
				...state,
				currentProjectId: projectId,
				currentProjectName: projectName
			}));
		},

		// Getters
		getProjects(): TranslationProject[] {
			return get({ subscribe }).projects;
		},

		getCurrentProjectId(): number | null {
			return get({ subscribe }).currentProjectId;
		},

		getCurrentProjectName(): string {
			return get({ subscribe }).currentProjectName;
		},

		getProjectById(projectId: number): TranslationProject | null {
			const state = get({ subscribe });
			return state.projects.find(p => p.id === projectId) || null;
		},

		reset() {
			set(initialState);
		}
	};
}

export const projectStore = createProjectStore();

// Derived stores
export const currentProject = derived(
	projectStore,
	$projectStore => $projectStore.projects.find(p => p.id === $projectStore.currentProjectId) || null
);

export const hasProjects = derived(
	projectStore,
	$projectStore => $projectStore.projects.length > 0
);

export const projectCount = derived(
	projectStore,
	$projectStore => $projectStore.projects.length
);