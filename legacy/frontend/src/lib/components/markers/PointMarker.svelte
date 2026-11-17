<script lang="ts">
	import type { Marker } from '$lib/types';
	import { markerService } from '$lib/services/markerService';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	
	interface Props {
		marker: Marker;
		imageX: number;
		imageY: number;
		imageWidth: number;
		imageHeight: number;
		imageScale: number;
		isSelected: boolean;
		isHovered: boolean;
		isDragging: boolean;
		draggedPosition: { x: number; y: number } | null;
		onMouseDown: (event: MouseEvent) => void;
		onTouchStart: (event: TouchEvent) => void;
		onContextMenu: (event: MouseEvent) => void;
		onWheel: (event: WheelEvent) => void;
		disableInteraction?: boolean;
	}
	
	const {
		marker,
		imageX,
		imageY,
		imageWidth,
		imageHeight,
		imageScale,
		isSelected,
		isHovered,
		isDragging,
		draggedPosition,
		onMouseDown,
		onTouchStart,
		onContextMenu,
		onWheel,
		disableInteraction = false
	}: Props = $props();
	
	// Extract coordinates from geometry - only support point type
	const markerX = $derived(
		marker.geometry.type === 'point' 
			? (isDragging && draggedPosition ? draggedPosition.x : marker.geometry.x)
			: 0
	);
	const markerY = $derived(
		marker.geometry.type === 'point' 
			? (isDragging && draggedPosition ? draggedPosition.y : marker.geometry.y)
			: 0
	);
	
	const pixelX = $derived(imageX + (markerX / 100) * imageWidth * imageScale);
	const pixelY = $derived(imageY + (markerY / 100) * imageHeight * imageScale);
	
	// 计算z-index：选中的marker在最上层(1000+)，其他根据imageIndex排序
	const zIndex = $derived(isSelected ? 1000 + marker.imageIndex : marker.imageIndex);
	
	// 获取 Ctrl/Cmd 键状态
	const ctrlOrCmd = keyboardShortcutService.ctrlOrCmd;
</script>

{#if marker.geometry.type === 'point'}
	<div
		class="marker absolute -translate-x-1/2 -translate-y-full transform cursor-grab transition-opacity duration-200 ease-in-out select-none active:scale-110 active:cursor-grabbing {disableInteraction || $ctrlOrCmd ? 'pointer-events-none' : 'pointer-events-auto'}"
		style="left: {pixelX}px; top: {pixelY}px; opacity: {isSelected || isHovered ? 1 : 0.6}; z-index: {zIndex};"
		data-marker-id={marker.id}
		onmousedown={onMouseDown}
		ontouchstart={onTouchStart}
		oncontextmenu={onContextMenu}
		onmouseenter={() => markerService.setHoveredMarker(marker.id)}
		onmouseleave={() => markerService.setHoveredMarker(null)}
		onwheel={onWheel}
		draggable="false"
		role="button"
		tabindex="0"
		aria-label="Marker {marker.imageIndex}, drag to move, right-click for menu"
	>
		<svg
			width="36"
			height="48"
			viewBox="0 0 36 48"
			xmlns="http://www.w3.org/2000/svg"
			class="drop-shadow-lg"
		>
			<!-- 椭圆形顶部 -->
			<ellipse
				cx="18"
				cy="18"
				rx="16"
				ry="16"
				fill={isSelected ? 'var(--color-primary)' : 'var(--color-secondary)'}
				stroke="var(--color-surface)"
				stroke-width="2"
			/>
			<!-- 尖角底部 -->
			<path
				d="M 6 30 L 18 46 L 30 30 Z"
				fill={isSelected ? 'var(--color-primary)' : 'var(--color-secondary)'}
				stroke="var(--color-surface)"
				stroke-width="2"
				stroke-linejoin="round"
			/>
			<!-- 数字文本 -->
			<text
				x="18"
				y="24"
				text-anchor="middle"
				font-family="ui-sans-serif, system-ui, sans-serif"
				font-size="14"
				font-weight="bold"
				fill={isSelected ? 'var(--color-on-primary)' : 'var(--color-on-secondary)'}
			>
				{marker.imageIndex}
			</text>
		</svg>
	</div>
{/if}