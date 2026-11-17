<script lang="ts">
	const {
		initialWidth = 300,
		initialHeight = 400,
		minWidth = 250,
		minHeight = 300,
		children
	} = $props();

	let width = $state(initialWidth);
	let height = $state(initialHeight);
	let isResizing = $state(false);
	let resizeDirection = $state('');
	let startX = $state(0);
	let startY = $state(0);
	let startWidth = $state(0);
	let startHeight = $state(0);

	$effect(() => {
		width = initialWidth;
		height = initialHeight;
	});

	function handleResizeStart(event: MouseEvent, direction: string) {
		event.preventDefault();
		event.stopPropagation();
		isResizing = true;
		resizeDirection = direction;
		startX = event.clientX;
		startY = event.clientY;
		startWidth = width;
		startHeight = height;
	}

	function handleResizeMove(event: MouseEvent) {
		if (!isResizing) return;

		const deltaX = event.clientX - startX;
		const deltaY = event.clientY - startY;

		if (resizeDirection.includes('right')) {
			const newWidth = startWidth + deltaX;
			width = Math.max(minWidth, newWidth);
		}

		if (resizeDirection.includes('bottom')) {
			const newHeight = startHeight + deltaY;
			height = Math.max(minHeight, newHeight);
		}
	}

	function handleResizeEnd() {
		isResizing = false;
		resizeDirection = '';
	}
</script>

<svelte:window on:mousemove={handleResizeMove} on:mouseup={handleResizeEnd} />

<div class="relative min-h-[300px] min-w-[250px]" style="width: {width}px; height: {height}px;">
	{@render children?.()}

	<!-- 调整大小的边角 -->
	<button
		type="button"
		class="absolute top-0 right-0 z-10 h-full w-1.5 cursor-ew-resize border-none bg-transparent p-0"
		onmousedown={(e) => handleResizeStart(e, 'right')}
		aria-label="调整宽度"
	></button>
	<button
		type="button"
		class="absolute bottom-0 left-0 z-10 h-1.5 w-full cursor-ns-resize border-none bg-transparent p-0"
		onmousedown={(e) => handleResizeStart(e, 'bottom')}
		aria-label="调整高度"
	></button>
	<button
		type="button"
		class="group absolute right-0 bottom-0 z-10 h-4 w-4 cursor-nw-resize border-none bg-transparent p-0"
		onmousedown={(e) => handleResizeStart(e, 'right bottom')}
		aria-label="同时调整宽度和高度"
	>
		<div
			class="bg-theme-primary absolute right-0 bottom-0 h-full w-full rounded-sm opacity-70 transition-opacity group-hover:opacity-100"
			style="clip-path: polygon(0% 100%, 100% 100%, 100% 0%);"
		></div>
	</button>
</div>
