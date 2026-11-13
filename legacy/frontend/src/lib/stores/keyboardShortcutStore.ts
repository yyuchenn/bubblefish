import { writable, derived } from 'svelte/store';

export interface ModifierKeys {
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	meta: boolean;
}

function createKeyboardShortcutStore() {
	const modifierKeys = writable<ModifierKeys>({
		ctrl: false,
		shift: false,
		alt: false,
		meta: false
	});

	const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);

	const ctrlOrCmd = derived(modifierKeys, ($modifierKeys) => {
		return isMac ? $modifierKeys.meta : $modifierKeys.ctrl;
	});

	function updateModifierKey(key: keyof ModifierKeys, pressed: boolean) {
		modifierKeys.update(keys => ({
			...keys,
			[key]: pressed
		}));
	}

	function resetModifiers() {
		modifierKeys.set({
			ctrl: false,
			shift: false,
			alt: false,
			meta: false
		});
	}

	return {
		modifierKeys,
		ctrlOrCmd,
		isMac,
		updateModifierKey,
		resetModifiers
	};
}

export const keyboardShortcutStore = createKeyboardShortcutStore();