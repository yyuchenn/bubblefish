<script lang="ts">
	interface Props {
		direction: 'horizontal' | 'vertical'; // horizontal: 左右伸缩, vertical: 上下伸缩
		initialSize: number;
		minSize?: number;
		maxSize?: number;
		barPosition?: 'start' | 'end'; // 伸缩条位置：start=左/上，end=右/下
		onSizeChange?: (size: number) => void; // 大小变化回调
		children?: import('svelte').Snippet;
		useAvailableSpace?: boolean; // 是否使用可用空间作为最大限制
	}

	const {
		direction,
		initialSize,
		minSize = 50,
		maxSize = 9999,
		barPosition = 'end',
		onSizeChange,
		children,
		useAvailableSpace = false
	}: Props = $props();

	let size = $state(initialSize);
	let isDragging = $state(false);
	let startPos = $state(0);
	let startSize = $state(0);
	let containerRef: HTMLDivElement;
	let availableSpace = $state(0);
	let dragBarElement: HTMLButtonElement | null = null;
	
	// 监听 initialSize 的变化并同步更新 size
	$effect(() => {
		// 只有在不拖动时才同步外部的尺寸变化
		if (!isDragging) {
			// 确保新尺寸在限制范围内
			const newSize = Math.min(Math.max(initialSize, minSize), maxSize);
			// 只有当尺寸有实际变化时才更新（避免浮点数精度问题）
			if (Math.abs(newSize - size) > 0.5) {
				size = newSize;
			}
		}
	});

	// 计算可用空间
	function calculateAvailableSpace() {
		if (!useAvailableSpace || !containerRef) return;
		
		const parent = containerRef.parentElement;
		if (!parent) return;
		
		// 获取视窗尺寸
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		
		// 根据方向计算最大可用空间
		if (direction === 'horizontal') {
			// 水平方向：计算除了必要元素外的可用宽度
			// 保留空间：ButtonBar(48px) + 主内容区最小宽度(300px) + 边距(40px)
			const reservedSpace = 48 + 300 + 40;
			
			// 如果两个侧边栏都打开，需要为另一个侧边栏保留空间
			const otherSidebarSpace = barPosition === 'start' ? 200 : 200; // 为另一侧边栏预留最小空间
			
			availableSpace = viewportWidth - reservedSpace - otherSidebarSpace;
		} else {
			// 垂直方向：使用视窗高度减去必要的顶部和底部空间
			availableSpace = viewportHeight - 200; // 预留200px给其他元素
		}
		
		// 确保可用空间不小于最小值
		availableSpace = Math.max(minSize, availableSpace);
		
		// 如果当前尺寸超过了可用空间，自动调整
		if (size > availableSpace) {
			size = availableSpace;
		}
	}

	// 监听窗口大小变化
	$effect(() => {
		if (useAvailableSpace) {
			// 初始计算和延迟计算（等待DOM渲染）
			calculateAvailableSpace();
			setTimeout(calculateAvailableSpace, 0);
			
			window.addEventListener('resize', calculateAvailableSpace);
			
			return () => {
				window.removeEventListener('resize', calculateAvailableSpace);
			};
		}
		return undefined;
	});

	// 当size变化时调用回调
	let previousSize = initialSize;
	$effect(() => {
		// 只有当尺寸真正变化时才调用回调
		if (Math.abs(size - previousSize) > 0.5) {
			previousSize = size;
			onSizeChange?.(size);
		}
	});

	function handlePointerDown(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		
		const target = event.currentTarget as HTMLButtonElement;
		dragBarElement = target;
		
		// Capture pointer to ensure we get all events
		target.setPointerCapture(event.pointerId);
		
		isDragging = true;
		startPos = direction === 'horizontal' ? event.clientX : event.clientY;
		startSize = size;
		document.body.style.cursor = direction === 'horizontal' ? 'ew-resize' : 'ns-resize';
		document.body.style.userSelect = 'none';
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isDragging) return;

		const currentPos = direction === 'horizontal' ? event.clientX : event.clientY;
		let delta = currentPos - startPos;

		// 根据伸缩条位置调整delta方向
		if (barPosition === 'start') {
			delta = -delta; // 反转方向
		}

		const newSize = startSize + delta;
		
		// 动态计算最大尺寸以防止布局破坏
		let dynamicMaxSize = maxSize;
		if (direction === 'horizontal' && containerRef) {
			const parent = containerRef.parentElement;
			if (parent) {
				const parentWidth = parent.offsetWidth;
				// 保留至少300px给其他内容
				dynamicMaxSize = Math.min(maxSize, parentWidth - 300);
			}
		}
		
		size = Math.max(minSize, Math.min(dynamicMaxSize, newSize));
	}

	function handlePointerUp(event: PointerEvent) {
		// Release pointer capture
		if (dragBarElement && typeof dragBarElement.releasePointerCapture === 'function') {
			try {
				dragBarElement.releasePointerCapture(event.pointerId);
			} catch (_e) {
				// Ignore if capture was already released
			}
		}
		
		isDragging = false;
		dragBarElement = null;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	// 根据方向确定样式
	const containerStyle = $derived(
		direction === 'horizontal'
			? `width: ${size}px; height: 100%;`
			: `height: ${size}px; width: 100%;`
	);

	const barStyle = $derived(
		direction === 'horizontal'
			? 'width: 4px; height: 100%; cursor: ew-resize;'
			: 'height: 4px; width: 100%; cursor: ns-resize;'
	);
</script>


<div
	bind:this={containerRef}
	class="relative flex bg-transparent {direction === 'vertical' ? 'flex-col' : ''}"
	style={containerStyle}
>
	{#if barPosition === 'start'}
		<!-- 拖拽条在前面 -->
		<button
			type="button"
			class="bg-theme-outline-variant hover:bg-theme-outline relative m-0 flex items-center justify-center border-none p-0 transition-colors outline-none select-none {direction ===
			'horizontal'
				? 'border-theme-outline-variant flex-col border-r border-l'
				: 'border-theme-outline-variant flex-row border-t border-b'} {isDragging
				? 'bg-theme-primary'
				: ''}"
			style={barStyle}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerUp}
			onpointercancel={handlePointerUp}
			aria-label={direction === 'horizontal' ? '左右调整' : '上下调整'}
		>
			<div
				class="bg-theme-on-surface-variant rounded-sm transition-colors {direction === 'horizontal'
					? 'h-5 w-0.5'
					: 'h-0.5 w-5'}"
			></div>
		</button>

		<!-- 内容区域 -->
		<div class="flex-1 overflow-hidden {direction === 'horizontal' ? 'h-full' : 'w-full'}">
			{@render children?.()}
		</div>
	{:else}
		<!-- 内容区域 -->
		<div class="flex-1 overflow-hidden {direction === 'horizontal' ? 'h-full' : 'w-full'}">
			{@render children?.()}
		</div>

		<!-- 拖拽条在后面 -->
		<button
			type="button"
			class="bg-theme-outline-variant hover:bg-theme-outline relative m-0 flex items-center justify-center border-none p-0 transition-colors outline-none select-none {direction ===
			'horizontal'
				? 'border-theme-outline-variant flex-col border-r border-l'
				: 'border-theme-outline-variant flex-row border-t border-b'} {isDragging
				? 'bg-theme-primary'
				: ''}"
			style={barStyle}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerUp}
			onpointercancel={handlePointerUp}
			aria-label={direction === 'horizontal' ? '左右调整' : '上下调整'}
		>
			<div
				class="bg-theme-on-surface-variant hover:bg-theme-on-surface rounded-sm transition-colors {direction ===
				'horizontal'
					? 'h-5 w-0.5'
					: 'h-0.5 w-5'} {isDragging ? 'bg-theme-on-primary' : ''}"
			></div>
		</button>
	{/if}
</div>
