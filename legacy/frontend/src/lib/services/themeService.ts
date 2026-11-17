// Theme service - manages application theme
import { currentTheme, switchToNextTheme, type Theme } from '../stores/themeStore';
import { get } from 'svelte/store';

// Export read-only store subscription for components
export { currentTheme };

// Theme service API
export const themeService = {
	// Switch to next theme
	switchToNext(): void {
		switchToNextTheme();
	},

	// Get current theme
	getCurrentTheme(): Theme {
		return get(currentTheme);
	}
};

// Re-export for backward compatibility
export { switchToNextTheme };