<script lang="ts">
	import QuillEditor from './QuillEditor.svelte';
	import ResizableBar from './ResizableBar.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { currentProjectId } from '$lib/services/projectService';
	import { currentImageId } from '$lib/services/imageService';
	import { markerService, selectedMarker, markers } from '$lib/services/markerService';
	import { derived, get } from 'svelte/store';
	import { undoRedoService } from '$lib/services/undoRedoService';
	import { onMount } from 'svelte';

	// Derive markers from markerStore and sort by imageIndex
	// markers is already a derived store from markerService, just sort it
	const sortedMarkers = derived(markers, ($markers) => 
		[...$markers].sort((a, b) => a.imageIndex - b.imageIndex)
	);
	import { layoutConfig } from '$lib/services/layoutService';

	let selectedMarkerId = $state<number | null>(null);
	let inputValue = $state(''); // This now primarily tracks the editor's state
	let editorComponent = $state<QuillEditor>(); // Reference to the editor component
	let scrollElement: HTMLElement; // Reference to the scroll container

	// 当前标记的样式属性
	let isOverlayText = $state(false);
	let isHorizontal = $state(false);

	// 记录上一次的图片ID，避免无关的更新导致重复清空
	let prevImageId = $currentImageId;
	// 记录上一次的项目ID
	let prevProjectId = $currentProjectId;
	
	// 拖拽相关状态
	let draggedIndex: number | null = $state(null);
	let draggedElement: HTMLElement | null = null;
	let draggedClone: HTMLElement | null = null;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let elementStartX = 0;
	let elementStartY = 0;
	let originalIndex: number | null = null;
	let originalMarkers: typeof $sortedMarkers | null = null;
	let tempDragOrder = $state<typeof $sortedMarkers | null>(null);
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let isDragging = $state(false);
	let isLongPressing = $state(false);
	let longPressProgress = $state(0); // 长按进度（0-100）
	let progressAnimationFrame: number | null = null;
	let longPressStartTime = 0;
	
	// 显示的markers：拖拽时使用临时顺序，否则使用排序后的markers
	const displayMarkers = $derived(tempDragOrder || $sortedMarkers);
	
	// 自动滚动相关
	let autoScrollInterval: number | null = null;

	// 从布局store获取面板标题栏高度
	const panelTitleBarHeight = $derived($layoutConfig.panelTitleBarHeight);

	// 编辑区域高度状态
	let editorHeight = $state(300);

	// 防抖和节流相关
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastUpdateTime = 0;
	const DEBOUNCE_DELAY = 1000; // 1秒防抖
	const THROTTLE_INTERVAL = 5000; // 5秒节流
	
	// 保存待更新的信息
	let pendingUpdate: { markerId: number; value: string } | null = null;
	
	// 立即保存待处理的更新（用于撤销/重做前）
	async function flushPendingUpdate() {
		if (debounceTimer && pendingUpdate) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
			// 保存到marker
			if ($currentImageId) {
				await markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
			}
			lastUpdateTime = Date.now();
			pendingUpdate = null;
		}
	}
	
	// 滚动到选中的marker
	function scrollToSelectedMarker(markerId: number) {
		if (!scrollElement) return;
		
		// 查找选中marker的元素
		const markerElement = scrollElement.querySelector(`[data-marker-id="${markerId}"]`) as HTMLElement;
		if (!markerElement) return;
		
		// 获取元素和容器的位置信息
		const elementRect = markerElement.getBoundingClientRect();
		const containerRect = scrollElement.getBoundingClientRect();
		
		// 检查元素是否在可视区域内
		const isAboveView = elementRect.top < containerRect.top;
		const isBelowView = elementRect.bottom > containerRect.bottom;
		
		// 如果元素不在可视区域内，则滚动到它
		if (isAboveView || isBelowView) {
			// 计算需要滚动的位置，使元素居中显示
			const elementOffsetTop = markerElement.offsetTop;
			const containerHeight = containerRect.height;
			const elementHeight = elementRect.height;
			
			// 滚动到元素，使其在容器中居中（如果可能）
			const targetScrollTop = elementOffsetTop - (containerHeight - elementHeight) / 2;
			
			scrollElement.scrollTo({
				top: Math.max(0, targetScrollTop),
				behavior: 'smooth'
			});
		}
	}

	// 追踪上一次处理的 marker 数据，避免重复处理相同的内容
	let lastProcessedMarker = $state<{ 
		id: number; 
		translation: string;
	} | null>(null);
	
	// 当全局选中标记变化时，同步本地 UI
	$effect(() => {
		const selected = $selectedMarker;
		
		// 只在 marker 内容真正改变时才处理
		const currentMarkerData = selected ? { 
			id: selected.id, 
			translation: selected.translation ?? ''
		} : null;
		
		// 检查是否是切换到不同的 marker
		const isMarkerSwitch = currentMarkerData && lastProcessedMarker && 
			currentMarkerData.id !== lastProcessedMarker.id;
			
		// 检查内容是否真正改变（只关注 id 和 translation，样式属性不需要检查）
		const hasRealChange = !lastProcessedMarker || !currentMarkerData ||
			lastProcessedMarker.id !== currentMarkerData.id ||
			lastProcessedMarker.translation !== currentMarkerData.translation;
		
		// 如果没有真正的变化，直接返回
		if (!hasRealChange) {
			return;
		}
		
		// 如果是切换 marker，清理防抖定时器并立即保存
		if (isMarkerSwitch && debounceTimer && pendingUpdate) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
			// 保存到原来的marker
			if ($currentImageId) {
				markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
			}
			lastUpdateTime = Date.now();
			pendingUpdate = null;
		}
		
		// 如果正在输入同一个 marker 的内容（有防抖定时器且不是切换marker），不覆盖用户输入
		if (debounceTimer && !isMarkerSwitch) {
			// 但仍需要更新追踪的数据，避免下次触发
			lastProcessedMarker = currentMarkerData;
			return;
		}
		
		lastProcessedMarker = currentMarkerData;
		
		if (!selected) {
			// 无选中
			if (selectedMarkerId !== null) {
				selectedMarkerId = null;
				inputValue = '';
				editorComponent?.setValue('', 'end');
				isOverlayText = false;
				isHorizontal = false;
			}
		} else {
			// 当选中的标记ID改变时，同步UI
			if (selectedMarkerId !== selected.id) {
				selectedMarkerId = selected.id;
				const text = selected.translation ?? '';
				inputValue = text;
				editorComponent?.setValue(text, 'end');
				isOverlayText = selected.style?.overlayText ?? false;
				isHorizontal = selected.style?.horizontal ?? false;
				// 延迟执行滚动和聚焦，确保DOM已更新
				setTimeout(() => {
					scrollToSelectedMarker(selected.id);
					}, 100);
			} else {
				// 即使ID相同，也要检查内容是否变化（比如撤销重做时）
				const text = selected.translation ?? '';
				const overlayText = selected.style?.overlayText ?? false;
				const horizontal = selected.style?.horizontal ?? false;
				
				// 更新文本内容
				// 如果文本不同，需要更新编辑器
				// 但要检查是否是用户输入导致的差异（用户输入的文本会比 marker 中的文本多）
				const isUserTyping = debounceTimer && inputValue.startsWith(text) && inputValue.length > text.length;
				
				if (inputValue !== text && !isUserTyping) {
					// 如果有防抖定时器，说明之前在输入，现在可能是撤销操作，需要清理
					if (debounceTimer) {
						clearTimeout(debounceTimer);
						debounceTimer = null;
						pendingUpdate = null;
					}
					
					inputValue = text;
					editorComponent?.setValue(text, 'preserve'); // 撤销重做时保持光标位置
				}
				
				// 更新样式
				if (isOverlayText !== overlayText) {
					isOverlayText = overlayText;
				}
				if (isHorizontal !== horizontal) {
					isHorizontal = horizontal;
				}
			}
		}
	});

	// 重置当前选中项与编辑器内容（在翻页时触发）
	$effect(() => {
		const imageId = $currentImageId;
		if (imageId !== prevImageId) {
			prevImageId = imageId;
			// 如果有待处理的更新，先执行它
			if (debounceTimer && pendingUpdate) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
				// 保存到原来的marker
				if ($currentImageId) {
					markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
				}
				lastUpdateTime = Date.now();
				pendingUpdate = null;
			}
			// 当图片切换时，清空选择与输入框
			selectedMarkerId = null;
			markerService.setSelectedMarker(null);
			inputValue = '';
			editorComponent?.setValue('', 'end'); // Explicitly clear the editor
			isOverlayText = false;
			isHorizontal = false;
		}
	});

	function handleItemClick(id: number) {
		// 如果有待处理的更新，先执行它
		if (debounceTimer && pendingUpdate) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
			// 保存到原来的marker
			if ($currentImageId) {
				markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
			}
			lastUpdateTime = Date.now();
			pendingUpdate = null;
		}

		if (selectedMarkerId === id) {
			// Deselecting the current item
			selectedMarkerId = null;
			markerService.setSelectedMarker(null);
			inputValue = '';
			editorComponent?.setValue('', 'end'); // Explicitly clear the editor
			isOverlayText = false;
			isHorizontal = false;
		} else {
			// Selecting a new item
			selectedMarkerId = id;
			const marker = $sortedMarkers.find((m) => m.id === id);
			const newText: string = marker?.translation ?? '';
			const currentStyle = marker?.style ?? { overlayText: false, horizontal: false };
			inputValue = newText;
			isOverlayText = currentStyle.overlayText;
			isHorizontal = currentStyle.horizontal;
			editorComponent?.setValue(newText, 'end'); // Set content and move cursor to end

			// 同步选中的标记到全局 store
			markerService.setSelectedMarker(id);
			
			// 延迟执行滚动和聚焦，确保DOM已更新
			setTimeout(() => {
				scrollToSelectedMarker(id);
			}, 100);
		}
	}

	function handleEditorChange(newValue: string) {
		// Update local state for the editor UI to feel responsive
		inputValue = newValue;

		// Only proceed if an item is selected
		if (selectedMarkerId === null) return;

		const currentTime = Date.now();
		const timeSinceLastUpdate = currentTime - lastUpdateTime;

		// 清除之前的防抖定时器
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}

		// 保存当前的更新信息
		pendingUpdate = {
			markerId: selectedMarkerId,
			value: newValue
		};

		// 检查是否需要节流更新（持续输入超过5秒）
		if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
			// 立即执行更新
			if ($currentImageId) {
				markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
			}
			lastUpdateTime = currentTime;
			pendingUpdate = null;
		} else {
			// 设置防抖定时器（停止输入1秒后更新）
			debounceTimer = setTimeout(() => {
				if (pendingUpdate) {
					if ($currentImageId) {
					markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
				}
					lastUpdateTime = Date.now();
					pendingUpdate = null;
				}
				debounceTimer = null;
			}, DEBOUNCE_DELAY);
		}
	}

	function handleOverlayTextToggle() {
		isOverlayText = !isOverlayText;
		if (selectedMarkerId !== null) {
			// 确保参数不是undefined
			const overlayTextValue = Boolean(isOverlayText);
			const horizontalValue = Boolean(isHorizontal);
			if ($currentImageId) {
				markerService.updateMarkerStyle(selectedMarkerId, overlayTextValue, horizontalValue, $currentImageId);
			}
		}
	}

	function handleHorizontalToggle() {
		isHorizontal = !isHorizontal;
		if (selectedMarkerId !== null) {
			// 确保参数不是undefined
			const overlayTextValue = Boolean(isOverlayText);
			const horizontalValue = Boolean(isHorizontal);
			if ($currentImageId) {
				markerService.updateMarkerStyle(selectedMarkerId, overlayTextValue, horizontalValue, $currentImageId);
			}
		}
	}

	// 处理编辑器高度变化
	function handleEditorSizeChange(size: number) {
		editorHeight = size;
	}

	// 处理编辑器失去焦点
	function handleEditorBlur() {
		// 如果有待处理的防抖更新，立即执行
		if (debounceTimer && pendingUpdate) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
			// 使用待处理的更新信息
			if ($currentImageId) {
				markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
			}
			lastUpdateTime = Date.now();
			pendingUpdate = null;
		}
	}

	// 监听项目切换 - 需要在markers被清除之前执行
	$effect(() => {
		const projectId = $currentProjectId;
		if (projectId !== prevProjectId) {
			// 项目即将切换，如果有待处理的更新，立即执行
			if (debounceTimer && pendingUpdate && prevProjectId !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
				// 立即保存，因为markers可能马上会被清除
				if ($currentImageId) {
					markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
				}
				lastUpdateTime = Date.now();
				pendingUpdate = null;
			}
			// 清空编辑器状态
			selectedMarkerId = null;
			inputValue = '';
			editorComponent?.setValue('', 'end');
			isOverlayText = false;
			isHorizontal = false;
			
			prevProjectId = projectId;
		}
	});

	// 处理定位按钮点击
	function handleLocateMarker(event: MouseEvent, marker: { id: number; x: number; y: number }) {
		// 调用全局的 panToMarker 函数
		if (typeof window !== 'undefined') {
			const panToMarker = (window as Window & { __panToMarker?: (marker: { x: number; y: number }) => void }).__panToMarker;
			if (panToMarker) {
				panToMarker(marker);
			}
		}
		// 让按钮失去焦点，避免focus样式持续显示
		(event.currentTarget as HTMLButtonElement).blur();
	}

	// 右键菜单状态
	let contextMenuVisible = $state(false);
	let contextMenuX = $state(0);
	let contextMenuY = $state(0);
	let contextMenuItems = $state<{ label: string; action: () => void }[]>([]);

	// 处理右键点击
	function handleContextMenu(event: MouseEvent, marker: { id: number }) {
		event.preventDefault();
		event.stopPropagation();
		
		// 找到对应的完整marker对象
		const fullMarker = $markers.find(m => m.id === marker.id);
		if (!fullMarker) return;
		
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuItems = [];
		
		// 根据marker类型添加转换选项
		if (fullMarker.geometry.type === 'rectangle') {
			contextMenuItems.push({
				label: '转换为点',
				action: () => {
					markerService.convertRectangleToPoint(marker.id);
					contextMenuVisible = false;
				}
			});
		} else if (fullMarker.geometry.type === 'point') {
			contextMenuItems.push({
				label: '转换为矩形',
				action: () => {
					markerService.convertPointToRectangle(marker.id);
					contextMenuVisible = false;
				}
			});
		}
		
		// 添加删除选项
		contextMenuItems.push({
			label: '删除',
			action: () => {
				// 删除marker
				const currentImageIdValue = get(currentImageId);
				if (currentImageIdValue !== null) {
					markerService.removeMarker(currentImageIdValue, marker.id);
					// 如果删除的是当前选中的marker，清空选择
					if (selectedMarkerId === marker.id) {
						selectedMarkerId = null;
						markerService.setSelectedMarker(null);
						inputValue = '';
						editorComponent?.setValue('', 'end');
						isOverlayText = false;
						isHorizontal = false;
					}
				}
				contextMenuVisible = false;
			}
		});
		
		contextMenuVisible = true;
	}

	// 关闭右键菜单
	function closeContextMenu() {
		contextMenuVisible = false;
	}

	// 处理pointer down事件，开始长按检测
	function handlePointerDown(event: PointerEvent, index: number) {
		// 如果正在拖拽，忽略
		if (isDragging) {
			event.preventDefault();
			return;
		}
		
		const target = event.currentTarget as HTMLElement;
		
		// 清理之前的状态
		cleanupDragState();
		
		// 保存初始位置和索引
		pointerStartX = event.clientX;
		pointerStartY = event.clientY;
		draggedIndex = index; // 保存当前索引，用于显示进度环
		
		// 开始长按计时（1秒）
		isLongPressing = true;
		longPressProgress = 0;
		longPressStartTime = Date.now();
		
		// 开始进度动画
		const updateProgress = () => {
			if (!isLongPressing) return;
			
			const elapsed = Date.now() - longPressStartTime;
			const progress = Math.min((elapsed / 1000) * 100, 100);
			longPressProgress = progress;
			
			if (progress < 100) {
				progressAnimationFrame = requestAnimationFrame(updateProgress);
			} else {
				// 进度完成，开始拖拽
				startDragging(target, index, event);
			}
		};
		progressAnimationFrame = requestAnimationFrame(updateProgress);
		
		// 设置备用定时器（以防动画出问题）
		longPressTimer = setTimeout(() => {
			if (isLongPressing && !isDragging) {
				startDragging(target, index, event);
			}
			longPressTimer = null;
		}, 1000);
		
		// 捕获pointer事件
		target.setPointerCapture(event.pointerId);
		
		// 防止默认行为
		event.preventDefault();
	}
	
	// 开始拖拽
	function startDragging(target: HTMLElement, index: number, _event: PointerEvent) {
		isDragging = true;
		isLongPressing = false;
		longPressProgress = 0;
		draggedIndex = index;
		originalIndex = index;
		originalMarkers = [...$sortedMarkers];
		tempDragOrder = [...$sortedMarkers];
		draggedElement = target.closest('[data-sortable-item]') as HTMLElement;
		
		if (!draggedElement) return;
		
		// 创建拖拽克隆元素
		draggedClone = draggedElement.cloneNode(true) as HTMLElement;
		draggedClone.style.position = 'fixed';
		draggedClone.style.pointerEvents = 'none';
		draggedClone.style.opacity = '0.8';
		draggedClone.style.zIndex = '9999';
		draggedClone.style.transform = 'scale(1.05)';
		draggedClone.style.width = draggedElement.offsetWidth + 'px';
		draggedClone.style.transition = 'none';
		
		// 获取元素位置
		const rect = draggedElement.getBoundingClientRect();
		elementStartX = rect.left;
		elementStartY = rect.top;
		
		// 设置克隆元素位置
		draggedClone.style.left = elementStartX + 'px';
		draggedClone.style.top = elementStartY + 'px';
		
		document.body.appendChild(draggedClone);
		
		// 降低原元素透明度
		draggedElement.style.opacity = '0.3';
		
		// 添加一个震动反馈（如果支持）
		if ('vibrate' in navigator) {
			navigator.vibrate(50);
		}
	}
	
	// 处理pointer move事件
	function handlePointerMove(event: PointerEvent) {
		// 如果正在长按但还没开始拖拽，检查是否移动过远
		if (isLongPressing && !isDragging) {
			const deltaX = Math.abs(event.clientX - pointerStartX);
			const deltaY = Math.abs(event.clientY - pointerStartY);
			
			// 如果移动超过10像素，取消长按
			if (deltaX > 10 || deltaY > 10) {
				cancelLongPress();
			}
			return;
		}
		
		// 如果正在拖拽
		if (isDragging && draggedClone && draggedIndex !== null) {
			const deltaX = event.clientX - pointerStartX;
			const deltaY = event.clientY - pointerStartY;
			
			// 更新克隆元素位置
			draggedClone.style.left = (elementStartX + deltaX) + 'px';
			draggedClone.style.top = (elementStartY + deltaY) + 'px';
			
			// 自动滚动
			handleAutoScroll(event.clientY);
			
			// 查找pointer下的元素
			draggedClone.style.pointerEvents = 'none';
			const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
			
			if (elementBelow) {
				const itemBelow = elementBelow.closest('[data-sortable-item]');
				if (itemBelow && itemBelow !== draggedElement) {
					const itemBelowIndex = parseInt(itemBelow.getAttribute('data-index') || '0');
					
					if (itemBelowIndex !== draggedIndex && tempDragOrder) {
						// 更新临时顺序
						const newTempOrder = [...tempDragOrder];
						const [removed] = newTempOrder.splice(draggedIndex, 1);
						newTempOrder.splice(itemBelowIndex, 0, removed);
						tempDragOrder = newTempOrder;
						
						// 更新拖拽索引
						draggedIndex = itemBelowIndex;
					}
				}
			}
		}
	}
	
	// 处理pointer up事件
	async function handlePointerUp(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;
		
		// 释放pointer捕获
		if (target && typeof target.releasePointerCapture === 'function') {
			try {
				target.releasePointerCapture(event.pointerId);
			} catch (_e) {
				// 忽略错误
			}
		}
		
		// 如果正在长按但没有开始拖拽，当作普通点击处理
		if (isLongPressing && !isDragging) {
			cancelLongPress();
			// 获取marker的id
			const markerId = parseInt(target.closest('[data-marker-id]')?.getAttribute('data-marker-id') || '0');
			if (markerId) {
				handleItemClick(markerId);
			}
		}
		
		// 如果完成了拖拽
		if (isDragging && originalIndex !== null && draggedIndex !== null && originalIndex !== draggedIndex && originalMarkers) {
			// 计算最终的重新排序数组
			const finalMarkers = [...originalMarkers];
			const [movedItem] = finalMarkers.splice(originalIndex, 1);
			finalMarkers.splice(draggedIndex, 0, movedItem);
			
			// 调用API更新顺序
			const movedMarkerId = movedItem.id;
			const newIndex = draggedIndex + 1; // imageIndex是从1开始的
			
			if ($currentImageId) {
				await markerService.moveMarkerOrder(movedMarkerId, newIndex, $currentImageId);
			}
		}
		
		cleanupDragState();
	}
	
	// 处理自动滚动
	function handleAutoScroll(pointerY: number) {
		if (!scrollElement) return;
		
		const rect = scrollElement.getBoundingClientRect();
		const scrollZoneSize = 50;
		const scrollSpeed = 5;
		
		// 清除现有的自动滚动
		if (autoScrollInterval) {
			clearInterval(autoScrollInterval);
			autoScrollInterval = null;
		}
		
		// 检查是否在顶部滚动区域
		if (pointerY < rect.top + scrollZoneSize) {
			const intensity = 1 - (pointerY - rect.top) / scrollZoneSize;
			autoScrollInterval = window.setInterval(() => {
				if (scrollElement) {
					scrollElement.scrollTop -= scrollSpeed * (1 + intensity * 2);
				}
			}, 16);
		}
		// 检查是否在底部滚动区域
		else if (pointerY > rect.bottom - scrollZoneSize) {
			const intensity = 1 - (rect.bottom - pointerY) / scrollZoneSize;
			autoScrollInterval = window.setInterval(() => {
				if (scrollElement) {
					scrollElement.scrollTop += scrollSpeed * (1 + intensity * 2);
				}
			}, 16);
		}
	}
	
	// 停止自动滚动
	function stopAutoScroll() {
		if (autoScrollInterval) {
			clearInterval(autoScrollInterval);
			autoScrollInterval = null;
		}
	}
	
	// 取消长按
	function cancelLongPress() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		if (progressAnimationFrame) {
			cancelAnimationFrame(progressAnimationFrame);
			progressAnimationFrame = null;
		}
		isLongPressing = false;
		longPressProgress = 0;
	}
	
	// 清理拖拽状态
	function cleanupDragState() {
		// 取消长按
		cancelLongPress();
		
		// 移除克隆元素
		if (draggedClone && draggedClone.parentNode) {
			try {
				document.body.removeChild(draggedClone);
			} catch (_e) {
				// 忽略错误
			}
			draggedClone = null;
		}
		
		// 恢复元素透明度
		if (draggedElement) {
			draggedElement.style.opacity = '1';
			draggedElement = null;
		}
		
		// 重置状态
		draggedIndex = null;
		originalIndex = null;
		originalMarkers = null;
		tempDragOrder = null;
		isDragging = false;
		
		// 停止自动滚动
		stopAutoScroll();
	}
	
	// 组件挂载时注册撤销/重做前的回调
	onMount(() => {
		// 注册回调，在撤销/重做前保存待处理的更新
		undoRedoService.setBeforeUndoRedoCallback(flushPendingUpdate);
		
		return () => {
			// 组件销毁时清理回调
			undoRedoService.setBeforeUndoRedoCallback(null);
		};
	});
	
	// 组件销毁时清理定时器和保存待处理的更新
	$effect(() => {
		return () => {
			// 清理拖拽状态
			cleanupDragState();
			
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				// 如果组件销毁时还有待处理的更新，立即保存
				if (pendingUpdate) {
					if ($currentImageId) {
					markerService.updateMarkerTranslation(pendingUpdate.markerId, pendingUpdate.value, $currentImageId);
				}
				}
			}
		};
	});
</script>

<!-- 固定布局的翻译面板 -->
<div class="bg-theme-background relative h-full w-full overflow-hidden">
	<!-- 标题栏 -->
	<div
		class="bg-theme-surface-variant border-theme-outline absolute top-0 right-0 left-0 z-10 flex items-center border-b px-3"
		style="height: {panelTitleBarHeight}px;"
	>
		<span class="text-theme-on-surface text-sm font-medium select-none">翻译</span>
	</div>

	<!-- 标记列表 -->
	<div
		class="absolute right-0 left-0 overflow-hidden"
		style="top: {panelTitleBarHeight}px; bottom: {selectedMarkerId !== null ? editorHeight : 0}px;"
	>
		<div bind:this={scrollElement} class="h-full overflow-y-auto" onwheel={(e) => e.stopPropagation()}>
			<div class="p-2">
				{#each displayMarkers as marker, index (marker.id)}
					<div
						class="hover-theme mb-1 flex w-full items-center rounded transition-colors {selectedMarkerId ===
						marker.id
							? 'bg-theme-primary-container border-theme-primary border'
							: 'border border-transparent'} group relative"
						onmouseenter={() => markerService.setHoveredMarker(marker.id)}
						onmouseleave={() => markerService.setHoveredMarker(null)}
						oncontextmenu={(e) => handleContextMenu(e, marker)}
						data-marker-id={marker.id}
						data-sortable-item
						data-index={index}
						role="listitem"
					>
						<button
							type="button"
							class="flex flex-1 items-center min-w-0 p-2 text-left touch-none"
							onpointerdown={(e) => handlePointerDown(e, index)}
							onpointermove={handlePointerMove}
							onpointerup={handlePointerUp}
							onpointercancel={handlePointerUp}
						>
							<span 
								class="{selectedMarkerId === marker.id 
								? 'bg-theme-primary text-theme-on-primary' 
								: 'bg-theme-secondary text-theme-on-secondary'} mr-3 flex h-6 w-6 flex-shrink-0 items-center justify-center {marker.geometry.type === 'point' ? 'rounded-full' : 'rounded-md'} text-xs font-medium relative"
							>
								{marker.imageIndex}
								{#if isLongPressing && !isDragging && index === draggedIndex}
									<!-- 进度环 -->
									<svg 
										class="absolute inset-0 w-full h-full pointer-events-none"
										viewBox="0 0 24 24"
										style="transform: rotate(-90deg);"
									>
										{#if marker.geometry.type === 'point'}
											<!-- 圆形进度环 -->
											<!-- 背景圆环 -->
											<circle
												cx="12"
												cy="12"
												r="10"
												stroke="currentColor"
												stroke-width="2"
												fill="none"
												opacity="0.2"
											/>
											<!-- 进度圆环 -->
											<circle
												cx="12"
												cy="12"
												r="10"
												stroke="currentColor"
												stroke-width="2"
												fill="none"
												stroke-linecap="round"
												stroke-dasharray={`${longPressProgress * 0.628} 62.8`}
												style="transition: stroke-dasharray 0.1s linear;"
											/>
										{:else}
											<!-- 圆角矩形进度环 -->
											<!-- 背景矩形 -->
											<rect
												x="3"
												y="3"
												width="18"
												height="18"
												rx="4"
												ry="4"
												stroke="currentColor"
												stroke-width="2"
												fill="none"
												opacity="0.2"
											/>
											<!-- 进度矩形 -->
											<rect
												x="3"
												y="3"
												width="18"
												height="18"
												rx="4"
												ry="4"
												stroke="currentColor"
												stroke-width="2"
												fill="none"
												stroke-linecap="round"
												stroke-dasharray={`${longPressProgress * 0.72} 72`}
												style="transition: stroke-dasharray 0.1s linear;"
											/>
										{/if}
									</svg>
								{/if}
							</span>
							<span class="text-theme-on-surface flex-1 truncate text-left text-sm min-w-0 select-none">
								{(marker.translation || '（未翻译）').replace(/\n/g, ' ')}
							</span>
						</button>
						<!-- 定位按钮 -->
						<button
							type="button"
							class="text-theme-on-surface-variant hover:text-theme-primary mr-2 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 p-2"
							onclick={(e) => {
								// Extract coordinates based on marker geometry type
								if (marker.geometry.type === 'point') {
									handleLocateMarker(e, { 
										id: marker.id, 
										x: marker.geometry.x, 
										y: marker.geometry.y 
									});
								} else if (marker.geometry.type === 'rectangle') {
									// For rectangle, use center point
									handleLocateMarker(e, { 
										id: marker.id, 
										x: marker.geometry.x + marker.geometry.width / 2, 
										y: marker.geometry.y + marker.geometry.height / 2 
									});
								}
							}}
							title="定位到标记"
							aria-label="定位到标记 {marker.imageIndex}"
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 16 16"
								fill="none"
								xmlns="http://www.w3.org/2000/svg"
							>
								<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
								<circle cx="8" cy="8" r="2" fill="currentColor" />
								<path d="M8 2V4M8 12V14M2 8H4M12 8H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
							</svg>
						</button>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- 编辑区域（可拖拽高度） - 仅在选中标记时显示 -->
	{#if selectedMarkerId !== null}
		<div class="absolute right-0 bottom-0 left-0 overflow-hidden" style="height: {editorHeight}px;">
			<ResizableBar
				direction="vertical"
				initialSize={editorHeight}
				barPosition="start"
				onSizeChange={handleEditorSizeChange}
			>
				<div class="border-theme-outline bg-theme-surface-variant flex h-full flex-col overflow-hidden border-t rounded-lg"
				>
					<!-- 样式控制 -->
					<div class="bg-theme-background border-theme-outline flex flex-shrink-0 gap-2 border-b p-2"
					>
						<button
							type="button"
							onclick={handleOverlayTextToggle}
							class="flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors {isOverlayText 
								? 'bg-theme-primary text-theme-on-primary' 
								: 'bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}"
							title="复杂背景"
							aria-label="复杂背景"
							aria-pressed={isOverlayText}
						>
							<svg 
								viewBox="0 0 24 24" 
								class="h-4 w-4"
								fill="none" 
								xmlns="http://www.w3.org/2000/svg"
							>
								<g clip-path="url(#clip0_525_172)">
									<path 
										fill-rule="evenodd" 
										clip-rule="evenodd" 
										d="M16 0C14.8954 0 14 0.895432 14 2V22C14 23.1046 14.8954 24 16 24H22C23.1046 24 24 23.1046 24 22V2C24 0.895431 23.1046 0 22 0H16ZM16 2L22 2V22H16V2Z" 
										fill="currentColor"
									/>
									<path 
										d="M2 1H12V3L2 3V21H12V23H2C0.89543 23 0 22.1046 0 21V3C0 1.89543 0.89543 1 2 1Z" 
										fill="currentColor"
									/>
									<path 
										d="M5 5H12V7H6V11H12V13H5C4.44771 13 4 12.5523 4 12V6C4 5.44772 4.44772 5 5 5Z" 
										fill="currentColor"
									/>
									<path 
										d="M5 16H12V18H5C4.44772 18 4 17.5523 4 17C4 16.4477 4.44772 16 5 16Z" 
										fill="currentColor"
									/>
								</g>
								<defs>
									<clipPath id="clip0_525_172">
										<rect width="24" height="24" fill="white"/>
									</clipPath>
								</defs>
							</svg>
							<span class="text-xs font-medium">框外</span>
						</button>
						<button
							type="button"
							onclick={handleHorizontalToggle}
							class="flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors {isHorizontal 
								? 'bg-theme-primary text-theme-on-primary' 
								: 'bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}"
							title="横排文字"
							aria-label="横排文字"
							aria-pressed={isHorizontal}
						>
							<svg 
								viewBox="0 0 24 24" 
								class="h-4 w-4"
								fill="none" 
								xmlns="http://www.w3.org/2000/svg"
							>
								<g>
									<path 
										d="M4 6H20M4 10H20M4 14H16M4 18H12" 
										stroke="currentColor" 
										stroke-width="2" 
										stroke-linecap="round"
									/>
									<path 
										d="M19 17L21 19M21 19L19 21M21 19H16" 
										stroke="currentColor" 
										stroke-width="2" 
										stroke-linecap="round" 
										stroke-linejoin="round"
									/>
								</g>
							</svg>
							<span class="text-xs font-medium">横排</span>
						</button>
					</div>
					<!-- 编辑器 -->
					<div class="min-h-0 flex-1 overflow-hidden">
						<QuillEditor
							bind:this={editorComponent}
							value={inputValue}
							onchange={handleEditorChange}
							onblur={handleEditorBlur}
						/>
					</div>
				</div>
			</ResizableBar>
		</div>
	{/if}
	
	<!-- 右键菜单 -->
	<ContextMenu
		visible={contextMenuVisible}
		x={contextMenuX}
		y={contextMenuY}
		items={contextMenuItems}
		onclose={closeContextMenu}
	/>
</div>
