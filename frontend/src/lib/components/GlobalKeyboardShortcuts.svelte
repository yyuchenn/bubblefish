<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { undoRedoService } from '$lib/services/undoRedoService';
	import { imageService, canNavigatePrev, canNavigateNext, images, currentImageIndex } from '$lib/services/imageService';
	import { markerService, selectedMarker, markers } from '$lib/services/markerService';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	import { get } from 'svelte/store';
	import { modalStore } from '$lib/services/modalService';
	import { projects, projectService, currentProjectId } from '$lib/services/projectService';
	import { platformService } from '$lib/services/platformService';

	let unregisterShortcuts: (() => void) | null = null;

	async function handleUndo() {
		try {
			await undoRedoService.undo();
		} catch (error) {
			console.error('Undo failed:', error);
		}
	}

	async function handleRedo() {
		try {
			await undoRedoService.redo();
		} catch (error) {
			console.error('Redo failed:', error);
		}
	}

	function handleTabNavigation() {
		const markersValue = get(markers);
		const imagesValue = get(images);
		const currentImageIndexValue = get(currentImageIndex);
		const isLastPage = currentImageIndexValue === imagesValue.length;
		
		if (markersValue.length === 0) {
			// No markers on current page
			if (!isLastPage) {
				// Not on last page, navigate to next page
				imageService.nextImage();
			}
			return;
		}
		
		// Get current selected marker
		const currentSelected = get(selectedMarker);
		const currentSelectedId = currentSelected?.id || null;
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		
		if (!currentSelectedId) {
			// No marker selected, select first one
			markerService.setSelectedMarker(sortedMarkers[0].id);
		} else {
			// Find current marker index
			const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelectedId);
			if (currentIndex === -1 || currentIndex === sortedMarkers.length - 1) {
				// Last marker or not found
				if (!isLastPage) {
					// Not on last page, go to next page
					imageService.nextImage();
					// After page change, select first marker if exists
					setTimeout(() => {
						const newMarkers = get(markers);
						if (newMarkers.length > 0) {
							const firstMarker = [...newMarkers].sort((a, b) => a.imageIndex - b.imageIndex)[0];
							markerService.setSelectedMarker(firstMarker.id);
						}
					}, 100);
				}
				// If on last page and last marker, do nothing
			} else {
				// Select next marker
				markerService.setSelectedMarker(sortedMarkers[currentIndex + 1].id);
			}
		}
	}

	function handleShiftTabNavigation() {
		const markersValue = get(markers);
		const currentImageIndexValue = get(currentImageIndex);
		const isFirstPage = currentImageIndexValue === 1;
		
		if (markersValue.length === 0) {
			// No markers on current page
			if (!isFirstPage) {
				// Not on first page, navigate to previous page
				imageService.prevImage();
			}
			return;
		}
		
		// Get current selected marker
		const currentSelected = get(selectedMarker);
		const currentSelectedId = currentSelected?.id || null;
		const sortedMarkers = [...markersValue].sort((a, b) => a.imageIndex - b.imageIndex);
		
		if (!currentSelectedId) {
			// No marker selected, select last one
			markerService.setSelectedMarker(sortedMarkers[sortedMarkers.length - 1].id);
		} else {
			// Find current marker index
			const currentIndex = sortedMarkers.findIndex(m => m.id === currentSelectedId);
			if (currentIndex === -1 || currentIndex === 0) {
				// First marker or not found
				if (!isFirstPage) {
					// Not on first page, go to previous page
					imageService.prevImage();
					// After page change, select last marker if exists
					setTimeout(() => {
						const newMarkers = get(markers);
						if (newMarkers.length > 0) {
							const sortedNewMarkers = [...newMarkers].sort((a, b) => a.imageIndex - b.imageIndex);
							markerService.setSelectedMarker(sortedNewMarkers[sortedNewMarkers.length - 1].id);
						}
					}, 100);
				}
				// If on first page and first marker, do nothing
			} else {
				// Select previous marker
				markerService.setSelectedMarker(sortedMarkers[currentIndex - 1].id);
			}
		}
	}

	onMount(() => {
		if (typeof window !== 'undefined') {
			// Initialize the keyboard shortcut service
			keyboardShortcutService.init();

			// Register all shortcuts
			unregisterShortcuts = keyboardShortcutService.registerMultiple([
				// Tab navigation
				{
					key: 'Tab',
					shift: false,
					handler: (_event) => {
						const currentSelected = get(selectedMarker);
						if (currentSelected) {
							handleTabNavigation();
							return true;
						}
						return false;
					}
				},
				// Shift+Tab navigation
				{
					key: 'Tab',
					shift: true,
					handler: (_event) => {
						const currentSelected = get(selectedMarker);
						if (currentSelected) {
							handleShiftTabNavigation();
							return true;
						}
						return false;
					}
				},
				// Undo
				{
					key: 'z',
					ctrl: true,
					shift: false,
					handler: () => {
						handleUndo();
					}
				},
				// Redo (Ctrl+Shift+Z)
				{
					key: 'z',
					ctrl: true,
					shift: true,
					handler: () => {
						handleRedo();
					}
				},
				// Redo (Ctrl+Y)
				{
					key: 'y',
					ctrl: true,
					shift: false,
					handler: () => {
						handleRedo();
					}
				},
				// Previous image
				{
					key: 'ArrowLeft',
					ctrl: true,
					shift: false,
					handler: () => {
						if (get(canNavigatePrev)) {
							imageService.prevImage();
							return true;
						}
						return false;
					}
				},
				// Next image
				{
					key: 'ArrowRight',
					ctrl: true,
					shift: false,
					handler: () => {
						if (get(canNavigateNext)) {
							imageService.nextImage();
							return true;
						}
						return false;
					}
				},
				// Open project (Ctrl+O)
				{
					key: 'o',
					ctrl: true,
					shift: false,
					handler: () => {
						modalStore.showModal('openProject');
						return true;
					}
				},
				// New project (Ctrl+N for desktop, Ctrl+Alt+N for web)
				{
					key: 'n',
					ctrl: true,
					shift: false,
					alt: !platformService.isTauri(), // Add Alt modifier for web platform
					handler: () => {
						const projectsValue = get(projects);
						const uploadDefaultName = `项目 ${projectsValue.length + 1}`;
						modalStore.showModal('newProject', {
							defaultName: uploadDefaultName
						});
						return true;
					}
				},
				// Save project (Ctrl+S)
				{
					key: 's',
					ctrl: true,
					shift: false,
					handler: async () => {
						const projectId = get(currentProjectId);
						if (projectId) {
							await projectService.handleSaveProject(projectId);
						}
						return true;
					}
				},
				// Save As (Ctrl+Shift+S)
				{
					key: 's',
					ctrl: true,
					shift: true,
					handler: async () => {
						const projectId = get(currentProjectId);
						if (projectId) {
							await projectService.handleSaveAs(projectId);
						}
						return true;
					}
				}
			]);
		}
	});

	onDestroy(() => {
		if (unregisterShortcuts) {
			unregisterShortcuts();
		}
		keyboardShortcutService.destroy();
	});
</script>