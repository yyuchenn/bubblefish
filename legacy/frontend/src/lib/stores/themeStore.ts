import { writable, get } from 'svelte/store';

export interface ColorScheme {
	// Background colors
	background: string;
	surface: string;
	surfaceVariant: string;

	// Text colors
	onBackground: string;
	onSurface: string;
	onSurfaceVariant: string;

	// Primary colors
	primary: string;
	onPrimary: string;
	primaryContainer: string;
	onPrimaryContainer: string;

	// Secondary colors
	secondary: string;
	onSecondary: string;
	secondaryContainer: string;
	onSecondaryContainer: string;

	// Error colors
	error: string;
	onError: string;
	errorContainer: string;
	onErrorContainer: string;

	// Border and outline
	outline: string;
	outlineVariant: string;

	// Interactive states
	hover: string;
	pressed: string;
	focus: string;
	disabled: string;
}

export interface Theme {
	name: string;
	colorScheme: ColorScheme;
}

const oceanTheme: Theme = {
	name: 'ocean',
	colorScheme: {
		background: '#ffffff',
		surface: '#f8fafc',
		surfaceVariant: '#f1f5f9',

		onBackground: '#1e293b',
		onSurface: '#334155',
		onSurfaceVariant: '#64748b',

		primary: '#3b82f6',
		onPrimary: '#ffffff',
		primaryContainer: '#dbeafe',
		onPrimaryContainer: '#1e40af',

		secondary: '#6b7280',
		onSecondary: '#ffffff',
		secondaryContainer: '#f3f4f6',
		onSecondaryContainer: '#374151',

		error: '#ef4444',
		onError: '#ffffff',
		errorContainer: '#fecaca',
		onErrorContainer: '#dc2626',

		outline: '#d1d5db',
		outlineVariant: '#e5e7eb',

		hover: 'rgba(0, 0, 0, 0.05)',
		pressed: 'rgba(0, 0, 0, 0.1)',
		focus: 'rgba(59, 130, 246, 0.1)',
		disabled: 'rgba(0, 0, 0, 0.38)'
	}
};

const fruitTheme: Theme = {
	name: 'fruit',
	colorScheme: {
		background: '#fef7ed',
		surface: '#fff7ed',
		surfaceVariant: '#fed7aa',

		onBackground: '#431407',
		onSurface: '#7c2d12',
		onSurfaceVariant: '#9a3412',

		primary: '#ff6b35',
		onPrimary: '#ffffff',
		primaryContainer: '#ffedd5',
		onPrimaryContainer: '#c2410c',

		secondary: '#e11d48',
		onSecondary: '#ffffff',
		secondaryContainer: '#fecdd3',
		onSecondaryContainer: '#be123c',

		error: '#dc2626',
		onError: '#ffffff',
		errorContainer: '#fecaca',
		onErrorContainer: '#991b1b',

		outline: '#fed7aa',
		outlineVariant: '#fdba74',

		hover: 'rgba(255, 107, 53, 0.1)',
		pressed: 'rgba(255, 107, 53, 0.2)',
		focus: 'rgba(225, 29, 72, 0.1)',
		disabled: 'rgba(120, 45, 18, 0.38)'
	}
};

const defaultDarkTheme: Theme = {
	name: 'dark',
	colorScheme: {
		background: '#0f172a',
		surface: '#1e293b',
		surfaceVariant: '#334155',

		onBackground: '#f8fafc',
		onSurface: '#e2e8f0',
		onSurfaceVariant: '#cbd5e1',

		primary: '#60a5fa',
		onPrimary: '#1e40af',
		primaryContainer: '#1e40af',
		onPrimaryContainer: '#dbeafe',

		secondary: '#9ca3af',
		onSecondary: '#374151',
		secondaryContainer: '#4b5563',
		onSecondaryContainer: '#f3f4f6',

		error: '#f87171',
		onError: '#7f1d1d',
		errorContainer: '#7f1d1d',
		onErrorContainer: '#fecaca',

		outline: '#4b5563',
		outlineVariant: '#374151',

		hover: 'rgba(255, 255, 255, 0.05)',
		pressed: 'rgba(255, 255, 255, 0.1)',
		focus: 'rgba(96, 165, 250, 0.1)',
		disabled: 'rgba(255, 255, 255, 0.38)'
	}
};

export const availableThemes: Theme[] = [fruitTheme, oceanTheme, defaultDarkTheme];

export const currentTheme = writable<Theme>(oceanTheme);

export const themeActions = {
	setTheme: (theme: Theme) => {
		currentTheme.set(theme);
		applyThemeToDocument(theme);
		localStorage.setItem('selectedTheme', theme.name);
	},

	setThemeByName: (themeName: string) => {
		const theme = availableThemes.find((t) => t.name === themeName);
		if (theme) {
			themeActions.setTheme(theme);
		}
	},

	loadSavedTheme: () => {
		const savedThemeName = localStorage.getItem('selectedTheme');
		if (savedThemeName) {
			const theme = availableThemes.find((t) => t.name === savedThemeName);
			if (theme) {
				themeActions.setTheme(theme);
				return;
			}
		}
		themeActions.setTheme(oceanTheme);
	},

	createCustomTheme: (name: string, colorScheme: ColorScheme) => {
		const customTheme: Theme = { name, colorScheme };
		availableThemes.push(customTheme);
		return customTheme;
	}
};

export function switchToNextTheme() {
	const current = get(currentTheme);

	const currentIndex = availableThemes.findIndex((theme) => theme.name === current.name);
	const nextIndex = (currentIndex + 1) % availableThemes.length;
	const nextTheme = availableThemes[nextIndex];

	themeActions.setTheme(nextTheme);
}

function applyThemeToDocument(theme: Theme) {
	const root = document.documentElement;
	const { colorScheme } = theme;

	// Apply CSS custom properties
	Object.entries(colorScheme).forEach(([key, value]) => {
		root.style.setProperty(`--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, value);
	});

	// Set data attribute for theme-specific styling
	root.setAttribute('data-theme', theme.name);
}

// Auto-load theme on module initialization (browser only)
if (typeof window !== 'undefined') {
	themeActions.loadSavedTheme();
}
