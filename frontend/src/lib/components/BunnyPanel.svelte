<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { bunnyService } from '$lib/services/bunnyService';
	import BunnyToolbar from './bunny/BunnyToolbar.svelte';
	import MarkerSelector from './bunny/MarkerSelector.svelte';
	import OCRPanel from './bunny/OCRPanel.svelte';
	import TranslationPanel from './bunny/TranslationPanel.svelte';
	import TaskQueue from './bunny/TaskQueue.svelte';
	import { queueStatus } from '$lib/stores/bunnyStore';
	
	let showTaskQueue = false;
	
	onMount(async () => {
		// Initialize bunny service
		await bunnyService.initialize();
	});
	
	onDestroy(() => {
		// Clean up
		bunnyService.destroy();
	});
	
	$: hasActiveTasks = $queueStatus.queuedTasks > 0 || $queueStatus.processingTasks > 0;
</script>

<div class="bg-theme-surface border-theme-outline flex h-full w-full flex-col border-t">
	<!-- Header -->
	<div class="bg-theme-surface-variant border-theme-outline flex h-8 items-center border-b px-3">
		<span class="text-theme-on-surface text-sm font-medium select-none flex items-center gap-2">
			<img src="/slug.png" alt="海兔" class="w-5 h-5" />
			海兔
		</span>
		<div class="flex-1"></div>
		<button
			class="px-2 py-1 text-xs rounded hover:bg-theme-surface flex items-center gap-1
				{hasActiveTasks ? 'text-theme-primary' : 'text-theme-on-surface-variant'}"
			on:click={() => showTaskQueue = !showTaskQueue}
			title="任务队列"
		>
			{#if $queueStatus.processingTasks > 0}
				<span class="inline-block w-2 h-2 bg-blue-600 rounded-full animate-pulse"></span>
			{:else if $queueStatus.queuedTasks > 0}
				<span class="inline-block w-2 h-2 bg-yellow-600 rounded-full"></span>
			{/if}
			队列 ({$queueStatus.queuedTasks}/{$queueStatus.processingTasks})
		</button>
	</div>
	
	<!-- Toolbar -->
	<BunnyToolbar />
	
	<!-- Main content area -->
	<div class="flex-1 flex overflow-hidden">
		<!-- Left: Marker selector -->
		<div class="w-64 border-r border-theme-outline">
			<MarkerSelector />
		</div>
		
		<!-- Center: OCR text -->
		<div class="flex-1 border-r border-theme-outline">
			<OCRPanel />
		</div>
		
		<!-- Right: Translation text -->
		<div class="flex-1">
			<TranslationPanel />
		</div>
	</div>
	
	<!-- Task queue overlay -->
	{#if showTaskQueue}
		<div class="absolute bottom-10 right-4 w-96 bg-theme-surface border border-theme-outline rounded-lg shadow-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<h3 class="text-sm font-medium text-theme-on-surface">任务队列状态</h3>
				<button
					class="text-theme-on-surface-variant hover:text-theme-on-surface"
					on:click={() => showTaskQueue = false}
				>
					✕
				</button>
			</div>
			<TaskQueue />
		</div>
	{/if}
</div>

<style>
	@keyframes pulse {
		0%, 100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}
	
	.animate-pulse {
		animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}
</style>