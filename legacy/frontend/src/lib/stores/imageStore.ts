import { writable, derived, get } from 'svelte/store';
import type { ImageMetadata } from '../types';

export interface ImageState {
	images: ImageMetadata[];
	currentImageId: number | null;
	currentImageIndex: number;
	totalImages: number;
}

const initialState: ImageState = {
	images: [],
	currentImageId: null,
	currentImageIndex: -1,
	totalImages: 0
};

function createImageStore() {
	const { subscribe, set, update } = writable<ImageState>(initialState);

	return {
		subscribe,

		setImages(images: ImageMetadata[]) {
			update(state => {
				// 如果当前有选择的图片，并且该图片在新列表中存在，保持选择
				let newCurrentImageId = null;
				let newCurrentImageIndex = -1;
				
				if (state.currentImageId && images.some(img => img.id === state.currentImageId)) {
					newCurrentImageId = state.currentImageId;
					newCurrentImageIndex = images.findIndex(img => img.id === state.currentImageId);
				} else if (images.length > 0) {
					// 如果当前没有选择或选择的图片不存在，默认选择第一张
					newCurrentImageId = images[0].id;
					newCurrentImageIndex = 0;
				}
				
				return {
					...state,
					images,
					totalImages: images.length,
					currentImageId: newCurrentImageId,
					currentImageIndex: newCurrentImageIndex
				};
			});
		},

		addImage(image: ImageMetadata) {
			update(state => ({
				...state,
				images: [...state.images, image],
				totalImages: state.totalImages + 1
			}));
		},

		removeImage(imageId: number) {
			update(state => {
				const newImages = state.images.filter(img => img.id !== imageId);
				let newCurrentImageId = state.currentImageId;
				let newCurrentImageIndex = state.currentImageIndex;

				// 如果删除的是当前图片，切换到下一张或上一张
				if (state.currentImageId === imageId) {
					if (newImages.length > 0) {
						const nextIndex = Math.min(state.currentImageIndex, newImages.length - 1);
						const nextImage = newImages[nextIndex];
						if (nextImage) {
							newCurrentImageId = nextImage.id;
							newCurrentImageIndex = nextIndex;
						} else {
							newCurrentImageId = null;
							newCurrentImageIndex = -1;
						}
					} else {
						newCurrentImageId = null;
						newCurrentImageIndex = -1;
					}
				} else if (newCurrentImageId) {
					// 更新当前图片的索引
					newCurrentImageIndex = newImages.findIndex(img => img.id === newCurrentImageId);
				}

				return {
					...state,
					images: newImages,
					totalImages: newImages.length,
					currentImageId: newCurrentImageId,
					currentImageIndex: newCurrentImageIndex
				};
			});
		},

		updateImage(imageId: number, updates: Partial<ImageMetadata>) {
			update(state => ({
				...state,
				images: state.images.map(img =>
					img.id === imageId ? { ...img, ...updates } : img
				)
			}));
		},

		setCurrentImage(imageId: number) {
			update(state => {
				const imageIndex = state.images.findIndex(img => img.id === imageId);
				if (imageIndex !== -1) {
					return {
						...state,
						currentImageId: imageId,
						currentImageIndex: imageIndex
					};
				}
				return state;
			});
		},

		clearCurrentImage() {
			update(state => ({
				...state,
				currentImageId: null,
				currentImageIndex: -1
			}));
		},

		nextImage() {
			update(state => {
				if (state.currentImageIndex < state.images.length - 1) {
					const nextImage = state.images[state.currentImageIndex + 1];
					return {
						...state,
						currentImageId: nextImage.id,
						currentImageIndex: state.currentImageIndex + 1
					};
				}
				return state;
			});
		},

		prevImage() {
			update(state => {
				if (state.currentImageIndex > 0) {
					const prevImage = state.images[state.currentImageIndex - 1];
					return {
						...state,
						currentImageId: prevImage.id,
						currentImageIndex: state.currentImageIndex - 1
					};
				}
				return state;
			});
		},

		// Getters
		getImages(): ImageMetadata[] {
			return get({ subscribe }).images;
		},

		getCurrentImageId(): number | null {
			return get({ subscribe }).currentImageId;
		},

		getCurrentImage(): ImageMetadata | null {
			const state = get({ subscribe });
			return state.images.find(img => img.id === state.currentImageId) || null;
		},

		getImageById(imageId: number): ImageMetadata | null {
			return get({ subscribe }).images.find(img => img.id === imageId) || null;
		},

		getImageIndex(imageId: number): number {
			return get({ subscribe }).images.findIndex(img => img.id === imageId);
		},

		hasImages(): boolean {
			return get({ subscribe }).images.length > 0;
		},

		reset() {
			set(initialState);
		}
	};
}

export const imageStore = createImageStore();

// Derived stores
export const currentImage = derived(
	imageStore,
	$imageStore => $imageStore.images.find(img => img.id === $imageStore.currentImageId) || null
);

export const canNavigatePrev = derived(
	imageStore,
	$imageStore => $imageStore.currentImageIndex > 0 && $imageStore.images.length > 0
);

export const canNavigateNext = derived(
	imageStore,
	$imageStore => $imageStore.currentImageIndex < $imageStore.images.length - 1 && $imageStore.images.length > 0
);

export const imageCount = derived(
	imageStore,
	$imageStore => $imageStore.totalImages
);

export const currentImageInfo = derived(
	imageStore,
	$imageStore => ({
		current: $imageStore.currentImageIndex + 1,
		total: $imageStore.totalImages
	})
);