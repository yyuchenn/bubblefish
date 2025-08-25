<script lang="ts">
	import { onMount } from 'svelte';
	import { logViewerVisible, toggleLogViewer } from '../../services/logViewerService';
	import Draggable from '../Draggable.svelte';
	import Resizable from '../Resizable.svelte';
	import LogsTab from './LogsTab.svelte';
	import StoreTab from './StoreTab.svelte';

	let activeTab = $state<'logs' | 'stores'>('logs');

	const tabs = [
		{ id: 'logs', label: '日志', icon: '📄' },
		{ id: 'stores', label: 'Store 数据', icon: '🗂️' }
	] as const;

	onMount(() => {
		// 监听菜单事件来切换调试窗口
		if (
			typeof window !== 'undefined' &&
			(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
		) {
			import('@tauri-apps/api/event').then(({ listen }) => {
				listen('menu:window:debug', () => {
					toggleLogViewer();
				});
			});
		}
	});

	function switchTab(tabId: 'logs' | 'stores') {
		activeTab = tabId;
	}

	function getTabButtonClass(tabId: string): string {
		const baseClass = 'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors rounded-t-lg border-b-2';
		if (activeTab === tabId) {
			return `${baseClass} bg-theme-primary-container text-theme-on-primary-container border-theme-primary`;
		}
		return `${baseClass} text-theme-on-surface-variant hover:text-theme-on-surface hover:bg-theme-surface-variant border-transparent`;
	}
</script>

{#if $logViewerVisible}
	<Draggable initialX={100} initialY={100} zIndex="1000">
		<Resizable initialWidth={700} initialHeight={500} minWidth={500} minHeight={400}>
			<div class="bg-theme-background border-theme-outline flex h-full flex-col rounded-lg border shadow-lg"
			>
			<!-- 标题栏和标签页 -->
			<div
				class="border-theme-outline bg-theme-surface-variant flex items-center justify-between rounded-t-lg border-b"
				data-inherit-draggable
			>
				<div class="flex">
					<div class="flex items-center gap-1 p-3">
						<h3 class="text-theme-on-surface text-sm font-semibold">调试窗口</h3>
					</div>
					<div class="flex">
						{#each tabs as tab (tab.id)}
							<button
								class={getTabButtonClass(tab.id)}
								onclick={() => switchTab(tab.id)}
							>
								<span class="text-xs">{tab.icon}</span>
								<span>{tab.label}</span>
							</button>
						{/each}
					</div>
				</div>
				
				<div class="flex items-center gap-2 p-3">
					<button
						class="text-theme-on-surface-variant hover:text-theme-on-surface hover-theme rounded p-1 transition-colors"
						onclick={toggleLogViewer}
						title="关闭调试窗口"
						aria-label="关闭调试窗口"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</div>

			<!-- 标签页内容 -->
			<div class="flex-1 overflow-hidden">
				{#if activeTab === 'logs'}
					<LogsTab />
				{:else if activeTab === 'stores'}
					<StoreTab />
				{/if}
			</div>
			</div>
		</Resizable>
	</Draggable>
{/if}