<script lang="ts">
	import { activeTasks, queueStatus } from '$lib/stores/bunnyStore';
	import { bunnyService } from '$lib/services/bunnyService';
	import { markers } from '$lib/services/markerService';
	import { images } from '$lib/services/imageService';
	import type { Marker } from '$lib/types';
	import type { BunnyTask } from '$lib/types/bunny';

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}
	
	let markerMap: Map<number, Marker> = new Map();
	$: markerMap = new Map($markers.map((marker) => [marker.id, marker]));

	let imageIndexMap: Map<number, number> = new Map();
	$: imageIndexMap = new Map($images.map((image, index) => [image.id, index + 1]));

	function getTaskTypeLabel(type: 'ocr' | 'translation') {
		return type === 'ocr' ? 'OCR' : '翻译';
	}
	
	function getTaskStatusLabel(status: BunnyTask['status']) {
		switch (status) {
			case 'queued': return '排队中';
			case 'processing': return '处理中';
			case 'completed': return '已完成';
			case 'failed': return '失败';
			case 'cancelled': return '已取消';
			default: return status;
		}
	}

	function getStatusClass(status: BunnyTask['status']) {
		switch (status) {
			case 'queued':
				return 'text-theme-secondary';
			case 'processing':
				return 'text-theme-primary';
			case 'failed':
				return 'text-theme-error';
			case 'cancelled':
				return 'text-theme-on-surface-variant';
			default:
				return 'text-theme-on-surface';
		}
	}

	function getMarkerLabel(task: BunnyTask) {
		const marker = markerMap.get(task.markerId);
		const markerNumber = marker?.imageIndex;
		const imageId = marker?.imageId ?? task.imageId;
		const pageNumber = imageId !== undefined ? imageIndexMap.get(imageId) : undefined;

		if (pageNumber !== undefined && markerNumber !== undefined) {
			return `标记 ${pageNumber}-${markerNumber}`;
		}

		if (pageNumber !== undefined) {
			return `标记 ${pageNumber}-${markerNumber ?? task.markerId}`;
		}

		if (markerNumber !== undefined) {
			return `标记 ${markerNumber}`;
		}

		return `标记 ${task.markerId}`;
	}
	
	async function cancelTask(taskId: string) {
		await bunnyService.cancelTask(taskId);
	}
	
	async function clearQueue() {
		await bunnyService.clearQueue();
	}
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center justify-between">
		<span class="text-xs font-medium text-theme-on-surface">任务队列</span>
		{#if $activeTasks.length > 0}
			<button
				class="px-2 py-1 text-xs rounded bg-theme-error text-theme-on-error hover:opacity-90"
				on:click={clearQueue}
			>
				清空队列
			</button>
		{/if}
	</div>
	
	<div class="flex gap-4 text-xs text-theme-on-surface-variant">
		<span>总计: {$queueStatus.totalTasks}</span>
		<span>排队: {$queueStatus.queuedTasks}</span>
		<span>处理中: {$queueStatus.processingTasks}</span>
		<span>完成: {$queueStatus.completedTasks}</span>
		{#if $queueStatus.failedTasks > 0}
			<span class="text-theme-error">失败: {$queueStatus.failedTasks}</span>
		{/if}
	</div>
	
	{#if $activeTasks.length > 0}
		<div class="max-h-32 overflow-y-auto space-y-1" on:wheel={handleWheel}>
			{#each $activeTasks as task (task.id)}
				<div class="flex items-center gap-2 p-2 bg-theme-surface-variant rounded text-xs text-theme-on-surface">
					<span class="font-medium text-theme-on-surface">{getMarkerLabel(task)}</span>
					<span class="text-theme-on-surface-variant">
						{getTaskTypeLabel(task.type)}
					</span>
					<span class={`flex-1 ${getStatusClass(task.status)}`}>
						{getTaskStatusLabel(task.status)}
					</span>
					<button
						class="px-2 py-0.5 rounded bg-theme-surface text-theme-on-surface border border-theme-outline hover:bg-theme-surface-variant focus:outline-none focus:ring-1 focus:ring-theme-primary/60"
						on:click={() => cancelTask(task.id)}
						title="取消任务"
					>
						✕
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>