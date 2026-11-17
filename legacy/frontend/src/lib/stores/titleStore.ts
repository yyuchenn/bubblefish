import { writable } from 'svelte/store';

interface TitleState {
	title: string;
	hasUnsaved: boolean;
}

function createTitleStore() {
	const { subscribe, set, update } = writable<TitleState>({
		title: 'Bubblefish',
		hasUnsaved: false
	});

	return {
		subscribe,
		set,
		update
	};
}

export const titleStore = createTitleStore();