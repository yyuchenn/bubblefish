<script lang="ts">
	import type { Marker } from '$lib/types';
	import { 
		markerService, 
		markers, 
		selectedMarkerId, 
		hoveredMarkerId 
	} from '$lib/services/markerService';
	import { currentImageId } from '$lib/services/imageService';
	import ContextMenu from '../ContextMenu.svelte';
	import PointMarker from './PointMarker.svelte';
	import RectangleMarker from './RectangleMarker.svelte';
	
	interface Props {
		imageWidth?: number;
		imageHeight?: number;
		imageX?: number;
		imageY?: number;
		imageScale?: number;
		isDrawingRectangle?: boolean;
	}
	
	const { 
		imageWidth = 100, 
		imageHeight = 100,
		imageX = 0,
		imageY = 0,
		imageScale = 1,
		isDrawingRectangle = false
	}: Props = $props();
	
	// 只有在图片尺寸合理且markers存在时才显示
	const shouldShowMarkers = $derived(
		imageWidth > 0 && imageHeight > 0 && $markers.length > 0
	);
	
	let draggingMarkerId = $state<number | null>(null);
	let dragOffsetX = $state(0);
	let dragOffsetY = $state(0);
	let containerRef: HTMLElement | undefined;
	let draggedMarkerPosition = $state<{ x: number; y: number } | null>(null);
	let initialDragPosition = $state<{ x: number; y: number } | null>(null);
	let initialDragPixelPosition = $state<{ x: number; y: number } | null>(null);
	
	// 位移阈值（像素）
	const DISPLACEMENT_THRESHOLD_PIXELS = 2; // 2像素的位移才会触发更新
	
	// Touch event handlers for mobile/touchscreen support
	function handleMarkerTouchStart(event: TouchEvent, markerId: number) {
		// 如果是双指或多指触摸，让事件冒泡到 ImageViewer 处理缩放/平移
		if (event.touches.length !== 1) {
			return; // 不阻止事件，让它冒泡
		}
		
		// 单指触摸时才阻止默认行为和冒泡
		event.preventDefault(); // 防止触摸滚动
		event.stopPropagation(); // 阻止事件冒泡到图片容器
		
		const touch = event.touches[0];
		const marker = $markers.find((m: Marker) => m.id === markerId);
		if (!marker) return;

		const container = containerRef;
		if (!container) return;

		const containerRect = container.getBoundingClientRect();
		
		// 获取marker坐标 - 适配新的geometry结构
		let markerX = 0, markerY = 0;
		if (marker.geometry.type === 'point') {
			markerX = marker.geometry.x;
			markerY = marker.geometry.y;
		} else if (marker.geometry.type === 'rectangle') {
			// 矩形使用左上角坐标
			markerX = marker.geometry.x;
			markerY = marker.geometry.y;
		}

		// 计算标记在屏幕上的实际像素位置
		const markerPixelX = imageX + (markerX / 100) * imageWidth * imageScale;
		const markerPixelY = imageY + (markerY / 100) * imageHeight * imageScale;

		// 计算触摸位置相对于标记中心点的偏移
		dragOffsetX = touch.clientX - (containerRect.left + markerPixelX);
		dragOffsetY = touch.clientY - (containerRect.top + markerPixelY);

		draggingMarkerId = markerId;
		
		// 初始化拖拽位置为当前标记位置
		draggedMarkerPosition = { x: markerX, y: markerY };
		initialDragPosition = { x: markerX, y: markerY };
		
		// 记录初始的像素位置
		initialDragPixelPosition = {
			x: touch.clientX,
			y: touch.clientY
		};

		// 选中当前标记
		markerService.setSelectedMarker(markerId);
	}
	
	function handleMarkerMouseDown(event: MouseEvent, markerId: number) {
		event.stopPropagation(); // 阻止事件冒泡到图片容器
		
		const marker = $markers.find((m: Marker) => m.id === markerId);
		if (!marker) return;
		
		const container = containerRef;
		if (!container) return;
		
		const containerRect = container.getBoundingClientRect();
		
		// 获取marker坐标 - 适配新的geometry结构
		let markerX = 0, markerY = 0;
		if (marker.geometry.type === 'point') {
			markerX = marker.geometry.x;
			markerY = marker.geometry.y;
		} else if (marker.geometry.type === 'rectangle') {
			// 矩形使用左上角坐标
			markerX = marker.geometry.x;
			markerY = marker.geometry.y;
		}
		
		// 计算标记在屏幕上的实际像素位置
		const markerPixelX = imageX + (markerX / 100) * imageWidth * imageScale;
		const markerPixelY = imageY + (markerY / 100) * imageHeight * imageScale;
		
		// 计算鼠标点击位置相对于标记中心点的偏移
		dragOffsetX = event.clientX - (containerRect.left + markerPixelX);
		dragOffsetY = event.clientY - (containerRect.top + markerPixelY);
		
		draggingMarkerId = markerId;
		
		// 初始化拖拽位置为当前标记位置
		draggedMarkerPosition = { x: markerX, y: markerY };
		initialDragPosition = { x: markerX, y: markerY };
		
		// 记录初始的像素位置
		initialDragPixelPosition = {
			x: event.clientX,
			y: event.clientY
		};
		
		// 选中当前标记
		markerService.setSelectedMarker(markerId);
	}
	
	function handleMarkerTouchMove(event: TouchEvent) {
		// 如果是双指或多指触摸，让事件冒泡到 ImageViewer 处理
		if (event.touches.length !== 1) {
			// 如果之前在拖拽，取消拖拽状态
			if (draggingMarkerId !== null) {
				// 恢复到原始位置
				if (initialDragPosition) {
					markerService.updateMarkerPositionOptimistic(draggingMarkerId, initialDragPosition.x, initialDragPosition.y);
				}
				draggingMarkerId = null;
				draggedMarkerPosition = null;
				initialDragPosition = null;
				initialDragPixelPosition = null;
			}
			return; // 让事件冒泡
		}
		
		if (draggingMarkerId === null || !containerRef) return;
		
		event.preventDefault(); // 防止触摸滚动
		const touch = event.touches[0];
		const containerRect = containerRef.getBoundingClientRect();

		// 计算触摸在容器中的位置（考虑偏移）
		const touchX = touch.clientX - containerRect.left - dragOffsetX;
		const touchY = touch.clientY - containerRect.top - dragOffsetY;

		// 计算相对于图片的位置
		const relativeToImageX = touchX - imageX;
		const relativeToImageY = touchY - imageY;

		// 转换为图片上的百分比位置（考虑缩放）
		const scaledImageWidth = imageWidth * imageScale;
		const scaledImageHeight = imageHeight * imageScale;
		
		const relativeX = Math.max(0, Math.min(100, (relativeToImageX / scaledImageWidth) * 100));
		const relativeY = Math.max(0, Math.min(100, (relativeToImageY / scaledImageHeight) * 100));

		// 只更新本地拖拽位置，不更新后端
		draggedMarkerPosition = { x: relativeX, y: relativeY };
		
		// 实时更新UI显示（乐观更新）
		markerService.updateMarkerPositionOptimistic(draggingMarkerId, relativeX, relativeY);
	}
	
	function handleMarkerMouseMove(event: MouseEvent) {
		if (draggingMarkerId === null || !containerRef) return;
		
		const marker = $markers.find((m: Marker) => m.id === draggingMarkerId);
		if (!marker) return;
		
		const containerRect = containerRef.getBoundingClientRect();
		
		// 计算鼠标在容器中的位置（考虑偏移）
		const mouseX = event.clientX - containerRect.left - dragOffsetX;
		const mouseY = event.clientY - containerRect.top - dragOffsetY;
		
		// 计算相对于图片的位置
		const relativeToImageX = mouseX - imageX;
		const relativeToImageY = mouseY - imageY;
		
		// 转换为图片上的百分比位置（考虑缩放）
		const scaledImageWidth = imageWidth * imageScale;
		const scaledImageHeight = imageHeight * imageScale;
		
		let relativeX = (relativeToImageX / scaledImageWidth) * 100;
		let relativeY = (relativeToImageY / scaledImageHeight) * 100;
		
		// 根据marker类型应用不同的边界限制
		if (marker.geometry.type === 'point') {
			// 点型marker：直接限制坐标在0-100
			relativeX = Math.max(0, Math.min(100, relativeX));
			relativeY = Math.max(0, Math.min(100, relativeY));
		} else if (marker.geometry.type === 'rectangle') {
			// 矩形marker：确保整个矩形都在图片范围内
			const width = marker.geometry.width;
			const height = marker.geometry.height;
			
			// 限制左上角x坐标，确保右边不超出
			relativeX = Math.max(0, Math.min(100 - width, relativeX));
			// 限制左上角y坐标，确保底边不超出
			relativeY = Math.max(0, Math.min(100 - height, relativeY));
		}
		
		// 只更新本地拖拽位置，不更新后端
		draggedMarkerPosition = { x: relativeX, y: relativeY };
		
		// 实时更新UI显示（乐观更新）
		markerService.updateMarkerPositionOptimistic(draggingMarkerId, relativeX, relativeY);
	}
	
	async function handleMarkerTouchEnd(event: TouchEvent) {
		if (draggingMarkerId !== null && draggedMarkerPosition && initialDragPosition && initialDragPixelPosition && $currentImageId) {
			// 获取最后的触摸位置（如果有的话）
			const touch = event.changedTouches[0];
			if (touch) {
				// 计算实际像素位移量
				const pixelDisplacementX = Math.abs(touch.clientX - initialDragPixelPosition.x);
				const pixelDisplacementY = Math.abs(touch.clientY - initialDragPixelPosition.y);
				const totalPixelDisplacement = Math.sqrt(pixelDisplacementX * pixelDisplacementX + pixelDisplacementY * pixelDisplacementY);
				
				// 只有位移量超过像素阈值才更新后端
				if (totalPixelDisplacement > DISPLACEMENT_THRESHOLD_PIXELS) {
					const markerId = draggingMarkerId;
					const newPosition = { ...draggedMarkerPosition };
					
					// 异步更新后端
					if ($currentImageId) {
						await markerService.updateMarkerPosition(markerId, newPosition.x, newPosition.y, $currentImageId);
					}
				} else {
					// 位移量太小，恢复到原始位置
					markerService.updateMarkerPositionOptimistic(draggingMarkerId, initialDragPosition.x, initialDragPosition.y);
				}
			}
		}
		
		// 清理拖拽状态
		draggingMarkerId = null;
		draggedMarkerPosition = null;
		initialDragPosition = null;
		initialDragPixelPosition = null;
	}
	
	async function handleMarkerMouseUp(event: MouseEvent) {
		if (draggingMarkerId !== null && draggedMarkerPosition && initialDragPosition && initialDragPixelPosition && $currentImageId) {
			// 计算实际像素位移量
			const pixelDisplacementX = Math.abs(event.clientX - initialDragPixelPosition.x);
			const pixelDisplacementY = Math.abs(event.clientY - initialDragPixelPosition.y);
			const totalPixelDisplacement = Math.sqrt(pixelDisplacementX * pixelDisplacementX + pixelDisplacementY * pixelDisplacementY);
			
			// 只有位移量超过像素阈值才更新后端
			if (totalPixelDisplacement > DISPLACEMENT_THRESHOLD_PIXELS) {
				const markerId = draggingMarkerId;
				const newPosition = { ...draggedMarkerPosition };
				
				// 异步更新后端
				if ($currentImageId) {
					await markerService.updateMarkerPosition(markerId, newPosition.x, newPosition.y, $currentImageId);
				}
			} else {
				// 位移量太小，恢复到原始位置
				markerService.updateMarkerPositionOptimistic(draggingMarkerId, initialDragPosition.x, initialDragPosition.y);
			}
		}
		
		// 清理拖拽状态
		draggingMarkerId = null;
		draggedMarkerPosition = null;
		initialDragPosition = null;
		initialDragPixelPosition = null;
	}
	
	// 处理右键菜单
	function handleMarkerContextMenu(event: MouseEvent, _markerId: number) {
		// 阻止事件冒泡和默认行为
		event.preventDefault();
		event.stopPropagation();
		
		// 使用 ContextMenu 的 autoTrigger 功能
		const showMenu = (
			window as Window & { __contextMenuShow?: (event: MouseEvent, target: HTMLElement) => void }
		).__contextMenuShow;
		if (showMenu) {
			showMenu(event, event.currentTarget as HTMLElement);
		}
	}
	
	// 处理标记上的滚轮事件，转发给图片进行缩放
	function handleMarkerWheel(event: WheelEvent) {
		// 阻止默认行为但不阻止冒泡
		event.preventDefault();
		
		// 查找 ImageViewer 中的图片元素并手动触发其 wheel 事件
		const imageElement = document.querySelector('.relative.select-none img')?.parentElement as HTMLElement;
		if (imageElement) {
			// 创建一个新的 wheel 事件并分发到图片元素
			const newWheelEvent = new WheelEvent('wheel', {
				deltaY: event.deltaY,
				deltaX: event.deltaX,
				deltaMode: event.deltaMode,
				clientX: event.clientX,
				clientY: event.clientY,
				screenX: event.screenX,
				screenY: event.screenY,
				bubbles: true,
				cancelable: true,
				view: event.view,
				detail: event.detail,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				metaKey: event.metaKey
			});
			imageElement.dispatchEvent(newWheelEvent);
		}
	}
	
	// 获取菜单项的函数
	function getMenuItems(target: HTMLElement, _event: MouseEvent) {
		// 从 target 的 data 属性或其他方式获取 markerId
		// 这里我们通过遍历找到对应的 marker
		const markerElement = target.closest('.marker') as HTMLElement;
		if (!markerElement) return [];
		
		// 从 data 属性获取真实的 marker ID（全局ID）
		const markerId = parseInt(markerElement.getAttribute('data-marker-id') || '0');
		if (isNaN(markerId) || !$currentImageId) return [];
		
		// 找到对应的marker以判断类型
		const marker = $markers.find((m: Marker) => m.id === markerId);
		if (!marker) return [];
		
		const menuItems = [];
		
		// 根据marker类型添加转换选项
		if (marker.geometry.type === 'rectangle') {
			menuItems.push({
				label: '转换为点',
				action: () => {
					markerService.convertRectangleToPoint(markerId);
				}
			});
		} else if (marker.geometry.type === 'point') {
			menuItems.push({
				label: '转换为矩形',
				action: () => {
					markerService.convertPointToRectangle(markerId);
				}
			});
		}
		
		// 添加删除选项
		menuItems.push({
			label: '删除',
			action: () => {
				if ($currentImageId) {
					markerService.removeMarker($currentImageId, markerId);
				}
			}
		});
		
		return menuItems;
	}
	
	// 监听添加标记事件
	function handleAddMarker(event: CustomEvent) {
		if (!$currentImageId) return;
		
		const { x, y } = event.detail;
		markerService.addPointMarker($currentImageId, x, y, '');
	}
	
	// 监听添加矩形标记事件
	function handleAddRectangleMarker(event: CustomEvent) {
		if (!$currentImageId) return;
		
		const { x, y, width, height } = event.detail;
		markerService.addRectangleMarker($currentImageId, x, y, width, height, '');
	}
	
	// 添加全局事件监听器
	$effect(() => {
		window.addEventListener('addMarker', handleAddMarker as EventListener);
		window.addEventListener('addRectangleMarker', handleAddRectangleMarker as EventListener);
		return () => {
			window.removeEventListener('addMarker', handleAddMarker as EventListener);
			window.removeEventListener('addRectangleMarker', handleAddRectangleMarker as EventListener);
		};
	});
</script>

<svelte:window 
	on:mousemove={handleMarkerMouseMove} 
	on:mouseup={(e) => handleMarkerMouseUp(e)}
	on:touchmove={handleMarkerTouchMove}
	on:touchend={(e) => handleMarkerTouchEnd(e)}
/>

<div
	class="pointer-events-none absolute inset-0 z-10 cursor-pointer"
	bind:this={containerRef}
>
	<!-- 数字标记 - 只有在图片尺寸确定且markers存在时才显示 -->
	{#if shouldShowMarkers}
		{#each $markers as marker (marker.id)}
			{@const isDragging = draggingMarkerId === marker.id}
			{@const isHovered = $hoveredMarkerId === marker.id}
			{@const isSelected = $selectedMarkerId === marker.id}
			
			<!-- 根据geometry类型渲染不同的marker组件 -->
			{#if marker.geometry.type === 'point'}
				<PointMarker
					{marker}
					{imageX}
					{imageY}
					{imageWidth}
					{imageHeight}
					{imageScale}
					{isSelected}
					{isHovered}
					{isDragging}
					draggedPosition={isDragging ? draggedMarkerPosition : null}
					onMouseDown={(e) => !isDrawingRectangle && handleMarkerMouseDown(e, marker.id)}
					onTouchStart={(e) => !isDrawingRectangle && handleMarkerTouchStart(e, marker.id)}
					onContextMenu={(e) => !isDrawingRectangle && handleMarkerContextMenu(e, marker.id)}
					onWheel={handleMarkerWheel}
					disableInteraction={isDrawingRectangle}
				/>
			{:else if marker.geometry.type === 'rectangle'}
				<RectangleMarker
					{marker}
					{imageX}
					{imageY}
					{imageWidth}
					{imageHeight}
					{imageScale}
					{isSelected}
					{isHovered}
					{isDragging}
					draggedPosition={isDragging ? draggedMarkerPosition : null}
					onMouseDown={(e) => !isDrawingRectangle && handleMarkerMouseDown(e, marker.id)}
					onTouchStart={(e) => !isDrawingRectangle && handleMarkerTouchStart(e, marker.id)}
					onContextMenu={(e) => !isDrawingRectangle && handleMarkerContextMenu(e, marker.id)}
					onWheel={handleMarkerWheel}
					disableInteraction={isDrawingRectangle}
				/>
			{/if}
		{/each}
	{/if}
</div>

<!-- 使用自管理的右键菜单组件 -->
<ContextMenu autoTrigger={true} {getMenuItems} />