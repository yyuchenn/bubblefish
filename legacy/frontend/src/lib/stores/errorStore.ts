import { writable, get } from 'svelte/store';

export interface ErrorState {
	error: string | null;
	errorTimestamp: number | null;
}

const initialState: ErrorState = {
	error: null,
	errorTimestamp: null
};

function createErrorStore() {
	const { subscribe, set, update } = writable<ErrorState>(initialState);

	return {
		subscribe,

		setError(error: string | Error) {
			const errorMessage = error instanceof Error ? error.message : error;
			update(state => ({
				...state,
				error: errorMessage,
				errorTimestamp: Date.now()
			}));
		},

		clearError() {
			update(state => ({
				...state,
				error: null,
				errorTimestamp: null
			}));
		},

		// Getters
		getError(): string | null {
			return get({ subscribe }).error;
		},

		hasError(): boolean {
			return get({ subscribe }).error !== null;
		},

		getErrorAge(): number | null {
			const state = get({ subscribe });
			if (state.errorTimestamp) {
				return Date.now() - state.errorTimestamp;
			}
			return null;
		},

		reset() {
			set(initialState);
		}
	};
}

export const errorStore = createErrorStore();

// Auto-clear old errors after 10 seconds
let errorTimeout: ReturnType<typeof setTimeout> | null = null;
errorStore.subscribe(state => {
	if (state.error) {
		if (errorTimeout) {
			clearTimeout(errorTimeout);
		}
		errorTimeout = setTimeout(() => {
			errorStore.clearError();
		}, 10000);
	}
});