// Modal service - manages modal dialog state
import { modalStore, type ModalType, type ModalData } from '../stores/modalStore';

// Export read-only store subscription for components
export { modalStore };

// Modal service API
export const modalService = {
	// Show a modal
	showModal(modalType: ModalType, data?: ModalData): void {
		modalStore.showModal(modalType, data);
	},

	// Hide the current modal
	hideModal(): void {
		modalStore.hideModal();
	},
	
	// Show snapshot modal
	showSnapshotModal(): void {
		modalStore.showModal('snapshot');
	},

	// Check if a specific modal is active
	isModalActive(modalType: ModalType): boolean {
		let isActive = false;
		modalStore.subscribe(state => {
			isActive = state.activeModal === modalType;
		})();
		return isActive;
	},

	// Get current modal data
	getModalData(): ModalData {
		let data: ModalData = {};
		modalStore.subscribe(state => {
			data = state.modalData;
		})();
		return data;
	}
};