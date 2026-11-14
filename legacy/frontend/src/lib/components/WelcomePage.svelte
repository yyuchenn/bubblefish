<script lang="ts">
	import { onMount } from 'svelte';
	import { keyboardShortcutService } from '$lib/services/keyboardShortcutService';
	import { platformService } from '$lib/services/platformService';

	let tips: string[] = [];
	let currentTip = '';

	function initializeTips() {
		const { modifierKey, shiftKey, altKey, keySeparator } = keyboardShortcutService.getModifierSymbols();

		tips = [
			`使用 ` + (platformService.isTauri() ? 
				`${modifierKey}${keySeparator}` : 
				`${modifierKey}${keySeparator}${altKey}${keySeparator}`) + `N 快速创建新项目`,
			`使用 ${modifierKey}${keySeparator}O 快速打开项目`,
			`使用 ${modifierKey}${keySeparator}←/${modifierKey}${keySeparator}→ 切换图片`,
			`使用 ${modifierKey}${keySeparator}Z/${modifierKey}${keySeparator}${shiftKey}${keySeparator}Z 撤销重做任何操作`,
			`选中标记时，使用 Tab/${shiftKey}${keySeparator}Tab 切换到下一个/上一个标记`,
			`使用 ${modifierKey}${keySeparator}S 及时保存`,
			`按住 ${modifierKey} 滑动滚轮可以缩放图片`,
			`按住 ${modifierKey} 可以拖拽图片`,
			`按住 ${shiftKey} 滑动滚轮可以横向滚动`,
			`点击状态栏上的缩放百分比可以选择缩放模式`,
			`点击状态栏上的页码可以键入数字以跳转到指定页面`,
			`当图片完全被移动出可视区域时，可以点击弹出的"图片归位"按钮将图片恢复到可视区域`,
			`点击菜单栏中央的项目名称可以切换项目`,
			`在使用触摸屏或拥有缩放手势的触控板时，可以使用双指进行缩放`,
			`在使用触摸屏时，可以通过双指滑动来滚动页面`,
			`按住右侧翻译列表里的翻译项可以通过拖拽来调整编号顺序`,
			`意外退出忘记保存？从“更多”菜单里的“快照”恢复`,
			`交流&反馈QQ群: 1060743685`
		];
	}

	function getRandomTip() {
		const randomIndex = Math.floor(Math.random() * tips.length);
		currentTip = tips[randomIndex];
	}

	function handleTipClick() {
		let newTip = currentTip;
		// 确保新的tip与当前的不同
		while (newTip === currentTip && tips.length > 1) {
			newTip = tips[Math.floor(Math.random() * tips.length)];
		}
		currentTip = newTip;
	}

	onMount(() => {
		initializeTips();
		getRandomTip();
	});
</script>

<div class="text-center flex flex-col items-center gap-4">
	<img src="/icon-192.png" alt="logo" class="mx-auto mb-2 w-20 h-20" />
	<p class="text-theme-on-surface text-lg select-none">请新建或打开项目以开始使用</p>
	{#if currentTip}
		<button 
			class="text-theme-on-surface text-sm transition-colors select-none px-4 py-2 rounded-lg"
			on:click={handleTipClick}
		>
			💡 {currentTip}
		</button>
	{/if}
</div>