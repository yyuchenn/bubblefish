// Log viewer service - manages debug log viewer state
import { logViewerVisible, toggleLogViewer } from '../stores/logViewerStore';

// Export read-only store subscription for components
export { logViewerVisible };

// Log viewer service API
export const logViewerService = {
	// Toggle log viewer visibility
	toggle(): void {
		toggleLogViewer();
	},

	// Show log viewer
	show(): void {
		logViewerVisible.set(true);
	},

	// Hide log viewer
	hide(): void {
		logViewerVisible.set(false);
	},

	// Check if log viewer is visible
	isVisible(): boolean {
		let visible = false;
		logViewerVisible.subscribe(v => visible = v)();
		return visible;
	}
};

// Re-export for backward compatibility
export { toggleLogViewer };