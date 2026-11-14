import { writable, derived, get } from 'svelte/store';

export interface LoadingState {
	loadingTasks: Set<string>;
	globalLoading: boolean;
}

const initialState: LoadingState = {
	loadingTasks: new Set(),
	globalLoading: false
};

function createLoadingStore() {
	const { subscribe, set, update } = writable<LoadingState>(initialState);

	let taskCounter = 0;

	return {
		subscribe,

		startLoading(taskId: string = 'global') {
			update(state => {
				const tasks = new Set(state.loadingTasks);
				tasks.add(taskId);
				return {
					...state,
					loadingTasks: tasks,
					globalLoading: tasks.size > 0
				};
			});
		},

		stopLoading(taskId: string = 'global') {
			update(state => {
				const tasks = new Set(state.loadingTasks);
				tasks.delete(taskId);
				return {
					...state,
					loadingTasks: tasks,
					globalLoading: tasks.size > 0
				};
			});
		},

		// New methods for task-based loading
		startTask(taskName: string): string {
			const taskId = `${taskName}_${++taskCounter}`;
			this.startLoading(taskId);
			return taskId;
		},

		endTask(taskId: string) {
			this.stopLoading(taskId);
		},

		setGlobalLoading(loading: boolean) {
			update(state => ({
				...state,
				globalLoading: loading,
				loadingTasks: loading ? new Set(['global']) : new Set()
			}));
		},

		// Getters
		isLoading(taskId?: string): boolean {
			const state = get({ subscribe });
			if (taskId) {
				return state.loadingTasks.has(taskId);
			}
			return state.globalLoading;
		},

		getLoadingTasks(): string[] {
			return Array.from(get({ subscribe }).loadingTasks);
		},

		hasAnyLoading(): boolean {
			return get({ subscribe }).loadingTasks.size > 0;
		},

		reset() {
			set(initialState);
		}
	};
}

export const loadingStore = createLoadingStore();

// Derived stores for common loading states
export const isAnyLoading = derived(
	loadingStore,
	$loadingStore => $loadingStore.globalLoading
);

export const loadingTaskCount = derived(
	loadingStore,
	$loadingStore => $loadingStore.loadingTasks.size
);