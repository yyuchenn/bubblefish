<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { projectStore } from '../../services/projectService';
	import { modalStore } from '../../services/modalService';
	import { errorStore } from '../../services/errorService';
	import { loadingStore } from '../../services/loadingService';
	import { layoutConfig, currentPlatform } from '../../services/layoutService';
	import { currentTheme } from '../../services/themeService';
	import { logViewerVisible } from '../../services/logViewerService';
	import { imageViewerStoreRaw as imageViewerStore } from '../../services/imageViewerService';
	import { imageStoreRaw as imageStore } from '../../services/imageService';
	import { markerStoreRaw as markerStore } from '../../services/markerService';

	// 实时存储数据
	const storeData = $state({
		projectStore: {},
		modalStore: {},
		errorStore: null as unknown,
		loadingStore: {},
		layoutConfig: {},
		currentPlatform: 'unknown',
		currentTheme: {},
		logViewerVisible: false,
		imageStore: {},
		markerStore: {},
		imageViewerStore: {}
	});

	// 订阅所有 store 的变化
	const unsubscribers: (() => void)[] = [];

	// 过滤器状态
	let searchFilter = $state('');
	const expandedStores = new SvelteSet<string>();
	let storeContainer = $state<HTMLElement>();

	onMount(() => {
		// 订阅所有 store
		unsubscribers.push(
			projectStore.subscribe((value) => {
				storeData.projectStore = value;
			}),
			modalStore.subscribe((value) => {
				storeData.modalStore = value;
			}),
			errorStore.subscribe((value) => {
				storeData.errorStore = value;
			}),
			loadingStore.subscribe((value) => {
				storeData.loadingStore = value;
			}),
			layoutConfig.subscribe((value) => {
				storeData.layoutConfig = value;
			}),
			currentPlatform.subscribe((value) => {
				storeData.currentPlatform = value;
			}),
			currentTheme.subscribe((value) => {
				storeData.currentTheme = value;
			}),
			logViewerVisible.subscribe((value) => {
				storeData.logViewerVisible = value;
			}),
			imageStore.subscribe((value) => {
				storeData.imageStore = value;
			}),
			markerStore.subscribe((value) => {
				storeData.markerStore = value;
			}),
			imageViewerStore.subscribe((value) => {
				storeData.imageViewerStore = value;
			})
		);

		// 默认展开一些常用的 store
		expandedStores.add('projectStore');
		expandedStores.add('imageStore');
	});

	onDestroy(() => {
		// 清理所有订阅
		unsubscribers.forEach((unsubscribe) => unsubscribe());
	});

	function toggleStore(storeName: string) {
		if (expandedStores.has(storeName)) {
			expandedStores.delete(storeName);
		} else {
			expandedStores.add(storeName);
		}
		// Trigger reactivity
	}

	function formatValue(value: unknown): string {
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		if (typeof value === 'string') return `"${value}"`;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) return `Array(${value.length})`;
		if (typeof value === 'object') return 'Object';
		return String(value);
	}

	function formatData(data: unknown, depth = 0): string {
		if (depth > 3) return '...'; // 防止无限递归
		
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return String(data);
		}
	}

	function getStoreItems() {
		const items = Object.entries(storeData).map(([key, value]) => ({
			name: key,
			value: value,
			matchesFilter: searchFilter === '' || 
				key.toLowerCase().includes(searchFilter.toLowerCase()) ||
				JSON.stringify(value).toLowerCase().includes(searchFilter.toLowerCase())
		}));
		
		return items.filter(item => item.matchesFilter);
	}

	function getStoreColor(storeName: string): string {
		const colors = {
			appStore: 'text-blue-600',
			layoutConfig: 'text-green-600',
			currentPlatform: 'text-purple-600',
			currentTheme: 'text-orange-600',
			logViewerVisible: 'text-gray-600',
			imageStore: 'text-cyan-600',
			cacheStore: 'text-teal-600',
			markerStore: 'text-pink-600',
			imageViewerStore: 'text-indigo-600',
		};
		return colors[storeName as keyof typeof colors] || 'text-theme-on-surface';
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text).then(() => {
			console.log('Copied to clipboard');
		});
	}
</script>

<div class="flex h-full flex-col">
	<!-- 搜索栏 -->
	<div class="border-theme-outline bg-theme-surface-variant border-b p-3">
		<input
			type="text"
			placeholder="搜索 Store 数据..."
			bind:value={searchFilter}
			class="border-theme-outline focus:border-theme-primary bg-theme-background text-theme-on-background w-full rounded border px-3 py-2 text-sm focus:outline-none"
		/>
		<div class="text-theme-on-surface-variant mt-2 text-xs">
			实时显示 {Object.keys(storeData).length} 个 Store 的数据
		</div>
	</div>

	<!-- Store 数据内容 -->
	<div 
		class="bg-theme-background flex-1 overflow-y-auto p-2"
		bind:this={storeContainer}
		onwheel={(e) => {
			e.stopPropagation();
			if (storeContainer) {
				storeContainer.scrollTop += e.deltaY;
			}
		}}
	>
		{#each getStoreItems() as { name, value } (name)}
			<div class="bg-theme-surface mb-3 rounded-lg border border-theme-outline">
				<!-- Store 标题 -->
				<div class="flex items-center justify-between p-3">
					<button
						class="hover-theme flex flex-1 items-center gap-2 text-left transition-colors"
						onclick={() => toggleStore(name)}
					>
						<span class="font-mono text-sm font-semibold {getStoreColor(name)}">{name}</span>
						<span class="text-theme-on-surface-variant text-xs">{formatValue(value)}</span>
						<svg 
							width="16" 
							height="16" 
							viewBox="0 0 24 24" 
							fill="none" 
							stroke="currentColor" 
							stroke-width="2"
							class="text-theme-on-surface-variant transition-transform ml-auto {expandedStores.has(name) ? 'rotate-180' : ''}"
						>
							<polyline points="6,9 12,15 18,9"/>
						</svg>
					</button>
					<button
						class="text-theme-on-surface-variant hover:text-theme-on-surface rounded p-1 transition-colors ml-2"
						onclick={() => copyToClipboard(formatData(value))}
						title="复制到剪贴板"
						aria-label="复制到剪贴板"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
							<path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
						</svg>
					</button>
				</div>

				<!-- Store 详细数据 -->
				{#if expandedStores.has(name)}
					<div class="border-theme-outline border-t p-3">
						<pre class="bg-theme-surface-variant text-theme-on-surface overflow-x-auto rounded p-3 text-xs font-mono whitespace-pre-wrap">{formatData(value)}</pre>
					</div>
				{/if}
			</div>
		{/each}

		{#if getStoreItems().length === 0}
			<div class="text-theme-on-surface-variant py-8 text-center">
				没有找到匹配的 Store 数据
			</div>
		{/if}
	</div>
</div>