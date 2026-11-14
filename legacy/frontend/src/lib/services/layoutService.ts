// Layout service - manages UI layout state
import { 
	sidebarState, 
	layoutActions, 
	layoutConfig, 
	currentPlatform
} from '../stores/layoutStore';
import type { Platform } from '$lib/core/tauri';

// Export read-only store subscriptions for components
export { sidebarState, layoutConfig, currentPlatform };

// Layout service API
export const layoutService = {
	// Sidebar operations
	toggleLeftSidebar(): void {
		layoutActions.toggleLeftSidebar();
	},

	toggleRightSidebar(): void {
		layoutActions.toggleRightSidebar();
	},

	openLeftSidebar(width?: number): void {
		layoutActions.openLeftSidebar(width);
	},

	closeLeftSidebar(): void {
		layoutActions.closeLeftSidebar();
	},

	openRightSidebar(width?: number): void {
		layoutActions.openRightSidebar(width);
	},

	closeRightSidebar(): void {
		layoutActions.closeRightSidebar();
	},

	toggleLeftSidebarType(type: 'images' | 'dictionary' | 'projectSettings'): void {
		layoutActions.toggleLeftSidebarType(type);
	},

	setLeftSidebar(type: 'images' | 'dictionary' | 'projectSettings' | null): void {
		if (type === null) {
			layoutActions.setLeftSidebar(false);
		} else {
			layoutActions.setLeftSidebar(true);
			layoutActions.toggleLeftSidebarType(type);
		}
	},

	// Platform operations
	setPlatform(platform: Platform): void {
		layoutActions.setPlatform(platform);
	},

	detectPlatform(): void {
		layoutActions.detectPlatform();
	}
};

// Re-export layoutActions for backward compatibility
export { layoutActions };