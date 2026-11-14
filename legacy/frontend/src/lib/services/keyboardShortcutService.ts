import { keyboardShortcutStore } from '$lib/stores/keyboardShortcutStore';
import { derived } from 'svelte/store';

export type ShortcutHandler = (event: KeyboardEvent) => void | boolean;

export interface Shortcut {
	key: string;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	meta?: boolean;
	handler: ShortcutHandler;
	preventDefault?: boolean;
}

class KeyboardShortcutService {
	private shortcuts: Map<string, Shortcut[]> = new Map();
	private initialized = false;
	
	// Expose reactive stores
	public readonly ctrlOrCmd = keyboardShortcutStore.ctrlOrCmd;
	public readonly shift = derived(keyboardShortcutStore.modifierKeys, $keys => $keys.shift);
	public readonly alt = derived(keyboardShortcutStore.modifierKeys, $keys => $keys.alt);
	public readonly modifierKeys = keyboardShortcutStore.modifierKeys;
	
	// Platform detection helper
	public isMacPlatform(): boolean {
		return typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);
	}
	
	// Get modifier key symbols based on platform
	public getModifierSymbols() {
		const isMac = this.isMacPlatform();
		return {
			modifierKey: isMac ? '⌘' : 'Ctrl',
			shiftKey: isMac ? '⇧' : 'Shift',
			altKey: isMac ? '⌥' : 'Alt',
			keySeparator: isMac ? '' : '+'
		};
	}

	init() {
		if (this.initialized) return;
		
		window.addEventListener('keydown', this.handleKeyDown.bind(this));
		window.addEventListener('keyup', this.handleKeyUp.bind(this));
		window.addEventListener('blur', this.handleBlur.bind(this));
		
		this.initialized = true;
	}

	destroy() {
		if (!this.initialized) return;
		
		window.removeEventListener('keydown', this.handleKeyDown.bind(this));
		window.removeEventListener('keyup', this.handleKeyUp.bind(this));
		window.removeEventListener('blur', this.handleBlur.bind(this));
		
		this.initialized = false;
		this.shortcuts.clear();
	}

	private handleKeyDown(event: KeyboardEvent) {
		// Update modifier keys
		if (event.key === 'Control') keyboardShortcutStore.updateModifierKey('ctrl', true);
		if (event.key === 'Shift') keyboardShortcutStore.updateModifierKey('shift', true);
		if (event.key === 'Alt') keyboardShortcutStore.updateModifierKey('alt', true);
		if (event.key === 'Meta') keyboardShortcutStore.updateModifierKey('meta', true);

		// Check for matching shortcuts - try both event.key and event.code
		const normalizedKey = event.key.toLowerCase();
		const codeKey = event.code.replace('Key', '').toLowerCase(); // KeyN -> n
		
		// Try to find shortcuts by key or code
		let shortcuts = this.shortcuts.get(normalizedKey) || [];
		if (shortcuts.length === 0 && codeKey) {
			shortcuts = this.shortcuts.get(codeKey) || [];
		}
		
		// Use event modifiers directly instead of store
		const eventModifiers = {
			meta: event.metaKey,
			alt: event.altKey,
			ctrl: event.ctrlKey,
			shift: event.shiftKey
		};
		
		for (const shortcut of shortcuts) {
			if (this.matchesModifiers(shortcut, eventModifiers)) {
				const result = shortcut.handler(event);
				if (shortcut.preventDefault !== false && result !== false) {
					event.preventDefault();
				}
				break;
			}
		}
	}

	private handleKeyUp(event: KeyboardEvent) {
		// Update modifier keys
		if (event.key === 'Control') keyboardShortcutStore.updateModifierKey('ctrl', false);
		if (event.key === 'Shift') keyboardShortcutStore.updateModifierKey('shift', false);
		if (event.key === 'Alt') keyboardShortcutStore.updateModifierKey('alt', false);
		if (event.key === 'Meta') keyboardShortcutStore.updateModifierKey('meta', false);
	}

	private handleBlur() {
		// Reset all modifiers when window loses focus
		keyboardShortcutStore.resetModifiers();
	}

	private matchesModifiers(shortcut: Shortcut, modifiers: any): boolean {
		const isMac = this.isMacPlatform();
		// Handle ctrl/cmd based on platform
		const ctrlRequired = shortcut.ctrl || shortcut.meta;
		const ctrlPressed = isMac ? modifiers.meta : modifiers.ctrl;
		
		if (ctrlRequired && !ctrlPressed) return false;
		if (!ctrlRequired && ctrlPressed) return false;
		
		// Check other modifiers
		if (shortcut.shift !== undefined && shortcut.shift !== modifiers.shift) return false;
		if (shortcut.alt !== undefined && shortcut.alt !== modifiers.alt) return false;
		
		return true;
	}

	register(shortcut: Shortcut): () => void {
		const key = shortcut.key.toLowerCase();
		if (!this.shortcuts.has(key)) {
			this.shortcuts.set(key, []);
		}
		this.shortcuts.get(key)!.push(shortcut);

		// Return unregister function
		return () => {
			const shortcuts = this.shortcuts.get(key);
			if (shortcuts) {
				const index = shortcuts.indexOf(shortcut);
				if (index > -1) {
					shortcuts.splice(index, 1);
				}
				if (shortcuts.length === 0) {
					this.shortcuts.delete(key);
				}
			}
		};
	}

	registerMultiple(shortcuts: Shortcut[]): () => void {
		const unregisterFns = shortcuts.map(s => this.register(s));
		return () => unregisterFns.forEach(fn => fn());
	}
}

export const keyboardShortcutService = new KeyboardShortcutService();