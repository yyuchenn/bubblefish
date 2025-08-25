import { writable, get } from 'svelte/store';

export type ModalType = 'newProject' | 'openProject' | 'about' | 'license' | 'confirm' | 'snapshot' | null;

export interface ModalData {
	defaultName?: string;
	onConfirm?: (data: unknown) => void;
	title?: string;
	message?: string;
	confirmText?: string;
	cancelText?: string;
	onCancel?: () => void;
}

export interface ModalState {
	activeModal: ModalType;
	modalData: ModalData;
}

const initialState: ModalState = {
	activeModal: null,
	modalData: {}
};

function createModalStore() {
	const { subscribe, set, update } = writable<ModalState>(initialState);

	return {
		subscribe,

		showModal(modalType: ModalType, data: ModalData = {}) {
			update(state => ({
				...state,
				activeModal: modalType,
				modalData: data
			}));
		},

		hideModal() {
			update(state => ({
				...state,
				activeModal: null,
				modalData: {}
			}));
		},

		updateModalData(data: Partial<ModalData>) {
			update(state => ({
				...state,
				modalData: { ...state.modalData, ...data }
			}));
		},

		// Getters
		getActiveModal(): ModalType {
			return get({ subscribe }).activeModal;
		},

		getModalData(): ModalData {
			return get({ subscribe }).modalData;
		},

		isModalOpen(modalType?: ModalType): boolean {
			const state = get({ subscribe });
			if (modalType) {
				return state.activeModal === modalType;
			}
			return state.activeModal !== null;
		},

		reset() {
			set(initialState);
		}
	};
}

export const modalStore = createModalStore();