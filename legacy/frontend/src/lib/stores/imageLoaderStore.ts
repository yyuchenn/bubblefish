import { writable, get } from 'svelte/store';

export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

export interface ImageLoaderState {
	imageUrl: string | null;
	loadingState: LoadingState;
	loadingStartTime: number | null;
	error: string | null;
}

const initialState: ImageLoaderState = {
	imageUrl: null,
	loadingState: 'idle',
	loadingStartTime: null,
	error: null
};

// Internal store - not exported
const imageLoaderStore = writable<ImageLoaderState>(initialState);

// Store actions - only for service use
export const imageLoaderActions = {
	startLoading() {
		imageLoaderStore.update(s => ({
			...s,
			loadingState: 'loading',
			loadingStartTime: Date.now(),
			error: null
		}));
	},

	setLoaded(imageUrl: string) {
		imageLoaderStore.update(s => ({
			...s,
			imageUrl,
			loadingState: 'loaded',
			loadingStartTime: null,
			error: null
		}));
	},

	setError(error: string) {
		imageLoaderStore.update(s => ({
			...s,
			loadingState: 'error',
			error,
			loadingStartTime: null
		}));
	},

	clear() {
		imageLoaderStore.update(s => ({
			...s,
			imageUrl: null,
			loadingState: 'idle',
			loadingStartTime: null,
			error: null
		}));
	},

	reset() {
		imageLoaderStore.set(initialState);
	},

	getState(): ImageLoaderState {
		return get(imageLoaderStore);
	},

	// Subscribe method for service to create derived stores
	subscribe: imageLoaderStore.subscribe
};