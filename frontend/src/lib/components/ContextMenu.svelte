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

	// 点击遮罩层时的处理函数
	function handleOverlayClick(event: MouseEvent) {
		// 阻止事件传播，防止触发下层元素的点击事件
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		
		// 关闭菜单
		handleClickOutside();
	}
	
	// 右键点击遮罩层时的处理函数
	function handleOverlayContextMenu(event: MouseEvent) {
		// 阻止默认的右键菜单
		event.preventDefault();
		event.stopPropagation();
		
		// 关闭当前菜单
		handleClickOutside();
	}

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
	<!-- 透明遮罩层，用于拦截点击事件 -->
	<button
		type="button"
		class="fixed inset-0 z-[999] cursor-default"
		style="background-color: transparent; border: none; padding: 0; margin: 0;"
		aria-label="Close context menu"
		onclick={handleOverlayClick}
		oncontextmenu={handleOverlayContextMenu}
		onmousedown={(e) => {
			e.preventDefault();
			e.stopPropagation();
		}}
	></button>
	
	<!-- Context Menu 本体 -->
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
