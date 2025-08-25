// Error service - manages global error state
import { errorStore } from '../stores/errorStore';

// Export read-only store subscription for components
export { errorStore };

// Error service API
export const errorService = {
	// Set an error
	setError(message: string): void {
		errorStore.setError(message);
	},

	// Clear the current error
	clearError(): void {
		errorStore.clearError();
	},

	// Get current error
	getError(): string | null {
		return errorStore.getError();
	},

	// Check if there's an error
	hasError(): boolean {
		return errorStore.hasError();
	}
};