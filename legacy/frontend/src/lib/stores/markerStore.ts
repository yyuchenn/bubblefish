import { writable, derived, get } from 'svelte/store';
import type { Marker } from '../types';

export interface MarkerState {
	markers: Marker[];
	selectedMarkerId: number | null;
	hoveredMarkerId: number | null;
}

const initialState: MarkerState = {
	markers: [],
	selectedMarkerId: null,
	hoveredMarkerId: null
};

function createMarkerStore() {
	const { subscribe, set, update } = writable<MarkerState>(initialState);

	return {
		subscribe,

		setMarkers(markers: Marker[]) {
			update(state => ({
				...state,
				markers,
				// 如果当前选中的标记不在新的列表中，清除选中状态
				selectedMarkerId:
					state.selectedMarkerId && markers.find(m => m.id === state.selectedMarkerId)
						? state.selectedMarkerId
						: null
			}));
		},

		addMarker(marker: Marker) {
			update(state => ({
				...state,
				markers: [...state.markers, marker]
			}));
		},

		removeMarker(markerId: number) {
			update(state => ({
				...state,
				markers: state.markers.filter(m => m.id !== markerId),
				selectedMarkerId: state.selectedMarkerId === markerId ? null : state.selectedMarkerId,
				hoveredMarkerId: state.hoveredMarkerId === markerId ? null : state.hoveredMarkerId
			}));
		},

		updateMarker(markerId: number, updates: Partial<Marker>) {
			update(state => ({
				...state,
				markers: state.markers.map(marker =>
					marker.id === markerId ? { ...marker, ...updates } : marker
				)
			}));
		},

		updateMarkerPosition(markerId: number, x: number, y: number) {
			update(state => ({
				...state,
				markers: state.markers.map(marker => {
					if (marker.id === markerId) {
						// Update geometry based on type
						if (marker.geometry.type === 'point') {
							return { ...marker, geometry: { type: 'point', x, y } };
						} else if (marker.geometry.type === 'rectangle') {
							// For rectangle, update position but keep width/height
							return { 
								...marker, 
								geometry: { 
									...marker.geometry, 
									x, 
									y 
								}
							};
						}
					}
					return marker;
				})
			}));
		},

		updateMarkerGeometry(markerId: number, x: number, y: number, width: number, height: number) {
			update(state => ({
				...state,
				markers: state.markers.map(marker => {
					if (marker.id === markerId && marker.geometry.type === 'rectangle') {
						return { 
							...marker, 
							geometry: { 
								type: 'rectangle',
								x, 
								y,
								width,
								height
							}
						};
					}
					return marker;
				})
			}));
		},

		setSelectedMarker(markerId: number | null) {
			update(state => ({
				...state,
				selectedMarkerId: markerId
			}));
		},

		setHoveredMarker(markerId: number | null) {
			update(state => ({
				...state,
				hoveredMarkerId: markerId
			}));
		},

		clearMarkers() {
			set(initialState);
		},

		// Getters
		getMarkers(): Marker[] {
			return get({ subscribe }).markers;
		},

		getSelectedMarkerId(): number | null {
			return get({ subscribe }).selectedMarkerId;
		},

		getSelectedMarker(): Marker | null {
			const state = get({ subscribe });
			return state.markers.find(m => m.id === state.selectedMarkerId) || null;
		},

		getHoveredMarkerId(): number | null {
			return get({ subscribe }).hoveredMarkerId;
		},

		getMarkerById(markerId: number): Marker | null {
			return get({ subscribe }).markers.find(m => m.id === markerId) || null;
		},

		findMarkersInArea(x: number, y: number, width: number, height: number): Marker[] {
			return get({ subscribe }).markers.filter(marker => {
				if (marker.geometry.type === 'point') {
					return marker.geometry.x >= x && 
						marker.geometry.x <= x + width && 
						marker.geometry.y >= y && 
						marker.geometry.y <= y + height;
				} else if (marker.geometry.type === 'rectangle') {
					// Check if rectangle intersects with area
					const rectLeft = marker.geometry.x;
					const rectRight = marker.geometry.x + marker.geometry.width;
					const rectTop = marker.geometry.y;
					const rectBottom = marker.geometry.y + marker.geometry.height;
					
					return rectLeft <= x + width &&
						rectRight >= x &&
						rectTop <= y + height &&
						rectBottom >= y;
				}
				return false;
			});
		},

		findNearestMarker(x: number, y: number, maxDistance: number = 50): Marker | null {
			const markers = get({ subscribe }).markers;
			let nearest: Marker | null = null;
			let minDistance = maxDistance;

			for (const marker of markers) {
				let distance: number;
				
				if (marker.geometry.type === 'point') {
					distance = Math.sqrt(
						Math.pow(marker.geometry.x - x, 2) + 
						Math.pow(marker.geometry.y - y, 2)
					);
				} else if (marker.geometry.type === 'rectangle') {
					// Calculate distance to nearest point on rectangle
					const rect = marker.geometry;
					const nearestX = Math.max(rect.x, Math.min(x, rect.x + rect.width));
					const nearestY = Math.max(rect.y, Math.min(y, rect.y + rect.height));
					distance = Math.sqrt(
						Math.pow(nearestX - x, 2) + 
						Math.pow(nearestY - y, 2)
					);
				} else {
					continue;
				}
				
				if (distance < minDistance) {
					minDistance = distance;
					nearest = marker;
				}
			}

			return nearest;
		},

		getMarkerStats() {
			const markers = get({ subscribe }).markers;
			return {
				totalMarkers: markers.length,
				translatedMarkers: markers.filter(m => m.translation && m.translation.trim() !== '').length,
				selectedMarker: get({ subscribe }).selectedMarkerId
			};
		},

		hasMarkers(): boolean {
			return get({ subscribe }).markers.length > 0;
		},

		reset() {
			set(initialState);
		}
	};
}

export const markerStore = createMarkerStore();

// Derived stores
export const selectedMarker = derived(
	markerStore,
	$markerStore => $markerStore.markers.find(marker => marker.id === $markerStore.selectedMarkerId) || null
);

export const hoveredMarker = derived(
	markerStore,
	$markerStore => $markerStore.markers.find(marker => marker.id === $markerStore.hoveredMarkerId) || null
);

export const markerCount = derived(
	markerStore,
	$markerStore => $markerStore.markers.length
);

export const translatedMarkerCount = derived(
	markerStore,
	$markerStore => $markerStore.markers.filter(m => m.translation && m.translation.trim() !== '').length
);

export const hasSelectedMarker = derived(
	markerStore,
	$markerStore => $markerStore.selectedMarkerId !== null
);