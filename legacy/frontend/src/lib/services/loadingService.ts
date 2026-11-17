// Loading service - manages global loading state
import { loadingStore } from '../stores/loadingStore';

// Export read-only store subscription for components
export { loadingStore };

// Loading service API
export const loadingService = {
	// Start a task and return its ID
	startTask(taskName: string): string {
		return loadingStore.startTask(taskName);
	},

	// End a task by its ID
	endTask(taskId: string): void {
		loadingStore.endTask(taskId);
	},

	// Check if any task is loading
	isLoading(): boolean {
		return loadingStore.isLoading();
	},

	// Clear all tasks (emergency reset)
	clearAllTasks(): void {
		loadingStore.reset();
	}
};