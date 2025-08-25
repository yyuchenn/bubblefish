<script lang="ts">
	interface MenuItem {
		label: string;
		action: () => void;
		disabled?: boolean;
	}

	const {
		visible = false,
		x = 0,
		y = 0,
		items = [],
		autoTrigger = false,
		getMenuItems = () => [],
		onclose = () => {},
		onshow = () => {}
	} = $props<{
		visible?: boolean;
		x?: number;
		y?: number;
		items?: MenuItem[];
		autoTrigger?: boolean;
		getMenuItems?: (target: HTMLElement, event: MouseEvent) => MenuItem[];
		onclose?: () => void;
		onshow?: (data: { x: number; y: number; target: HTMLElement }) => void;
	}>();

	// 自管理状态
	let selfVisible = $state(false);
	let selfX = $state(0);
	let selfY = $state(0);
	let selfItems = $state<MenuItem[]>([]);

	// 计算实际使用的状态
	let actualVisible = $derived(autoTrigger ? selfVisible : visible);
	let actualX = $derived(autoTrigger ? selfX : x);
	let actualY = $derived(autoTrigger ? selfY : y);
	let actualItems = $derived(autoTrigger ? selfItems : items);

	function handleItemClick(item: MenuItem) {
		if (!item.disabled) {
			item.action();
		}
		if (autoTrigger) {
			hideMenu();
		}
	}

	function handleClickOutside() {
		if (autoTrigger) {
			hideMenu();
		} else {
			onclose();
		}
	}

	function showMenu(event: MouseEvent, target: HTMLElement) {
		if (!autoTrigger) return;

		event.preventDefault();
		event.stopPropagation();

		selfX = event.clientX;
		selfY = event.clientY;
		selfItems = getMenuItems(target, event);
		selfVisible = true;

		onshow({ x: selfX, y: selfY, target });
	}

	function hideMenu() {
		if (!autoTrigger) return;

		selfVisible = false;
		selfItems = [];
	}

	// 点击其他地方时隐藏菜单
	$effect(() => {
		if (actualVisible) {
			const handleDocumentMouseDown = (event: MouseEvent) => {
				// 检查点击是否在菜单外部
				const target = event.target as HTMLElement;
				if (!target.closest('.context-menu')) {
					// 阻止事件传播和默认行为，防止其他事件处理器执行
					event.preventDefault();
					event.stopPropagation();
					event.stopImmediatePropagation();
					
					handleClickOutside();
					
					// 设置一个短暂的标志来阻止后续的鼠标事件处理
					// 这个标志会阻止图片上的点击事件创建新marker
					(window as Window & { __contextMenuClosing?: boolean }).__contextMenuClosing = true;
					setTimeout(() => {
						(window as Window & { __contextMenuClosing?: boolean }).__contextMenuClosing = false;
					}, 50); // 50ms的延迟足够阻止同一个点击事件的其他处理器
				}
			};

			const handleDocumentContextMenu = (event: MouseEvent) => {
				// 检查右键点击是否在菜单外部
				const target = event.target as HTMLElement;
				if (!target.closest('.context-menu')) {
					// 关闭当前菜单
					handleClickOutside();
				}
			};

			// 使用捕获阶段来确保我们的事件处理器优先执行
			// 延迟添加事件监听器，避免立即触发
			const timeoutId = setTimeout(() => {
				// 监听所有鼠标按键（左键、中键、右键）
				document.addEventListener('mousedown', handleDocumentMouseDown, true);
				// 单独监听右键菜单事件
				document.addEventListener('contextmenu', handleDocumentContextMenu, true);
			}, 0);

			return () => {
				clearTimeout(timeoutId);
				document.removeEventListener('mousedown', handleDocumentMouseDown, true);
				document.removeEventListener('contextmenu', handleDocumentContextMenu, true);
			};
		}
		return () => {}; // 确保总是返回清理函数
	});

	// 暴露方法给父组件
	$effect(() => {
		if (autoTrigger) {
			// 将 showMenu 方法暴露到全局，供父组件调用
			(window as Window & { __contextMenuShow?: typeof showMenu }).__contextMenuShow = showMenu;
			return () => {
				delete (window as Window & { __contextMenuShow?: typeof showMenu }).__contextMenuShow;
			};
		}
		return () => {}; // 确保总是返回清理函数
	});
</script>

{#if actualVisible}
	<div
		class="context-menu bg-theme-background border-theme-outline fixed z-[1000] min-w-[120px] rounded border py-1 shadow-lg"
		role="menu"
		tabindex="0"
		style="left: {actualX}px; top: {actualY}px;"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		{#each actualItems as item, index (index)}
			<button
				class="text-theme-on-background hover:bg-theme-secondary-container active:bg-theme-secondary disabled:text-theme-on-surface-variant block w-full cursor-pointer border-none bg-transparent px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
				onclick={() => handleItemClick(item)}
				disabled={item.disabled}
			>
				{item.label}
			</button>
		{/each}
	</div>
{/if}
