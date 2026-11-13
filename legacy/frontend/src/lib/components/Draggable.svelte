<script lang="ts">
	const {
		initialX = 0,
		initialY = 0,
		zIndex = 'auto',
		onPositionChange = () => {},
		children
	} = $props();

	let x = $state(initialX);
	let y = $state(initialY);
	let isDragging = $state(false);
	let offsetX = $state(0);
	let offsetY = $state(0);
	let isMouseDown = $state(false);
	let startX = $state(0);
	let startY = $state(0);
	let hasBeenDragged = $state(false);

	$effect(() => {
		// 只有在从未拖拽过的情况下，才同步初始位置
		// 一旦拖拽过，就保持用户设置的位置
		if (!hasBeenDragged && !isDragging && !isMouseDown) {
			x = initialX;
			y = initialY;
		}
	});

	function handleMouseDown(event: MouseEvent) {
		// 检查点击的元素是否有 draggable 属性，或者是容器本身
		const target = event.target as HTMLElement;
		if (target === event.currentTarget || target.hasAttribute('data-inherit-draggable')) {
			event.preventDefault();
			isMouseDown = true;
			startX = event.clientX;
			startY = event.clientY;
			offsetX = event.clientX - x;
			offsetY = event.clientY - y;
		}
	}

	function handleMouseMove(event: MouseEvent) {
		if (isMouseDown) {
			const deltaX = Math.abs(event.clientX - startX);
			const deltaY = Math.abs(event.clientY - startY);

			// 只有在移动距离超过阈值时才开始拖拽
			if (!isDragging && (deltaX > 5 || deltaY > 5)) {
				isDragging = true;
				hasBeenDragged = true; // 标记已被拖拽过
			}

			if (isDragging) {
				const newX = event.clientX - offsetX;
				const newY = event.clientY - offsetY;
				x = newX;
				y = newY;
				onPositionChange(newX, newY);
			}
		}
	}

	function handleMouseUp() {
		if (isMouseDown) {
			if (isDragging) {
				isDragging = false;
			}
			// 稍微延迟重置 isMouseDown，确保位置更新完成
			setTimeout(() => {
				isMouseDown = false;
			}, 0);
		}
	}
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={handleMouseUp} />

<div
	class="absolute select-none"
	style="left: {x}px; top: {y}px; z-index: {zIndex};"
	onmousedown={handleMouseDown}
	ondragstart={(e) => e.preventDefault()}
	role="button"
	tabindex="0"
>
	{@render children?.()}
</div>
