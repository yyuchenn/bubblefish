<script lang="ts">
	import { activeTasks, queueStatus } from '$lib/stores/bunnyStore';
	import { bunnyService } from '$lib/services/bunnyService';
	import type { BunnyTask } from '$lib/types/bunny';

	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent the global wheel event handler from blocking scrolling
		event.stopPropagation();
	}
	
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
				<div class="flex items-center gap-2 p-2 bg-theme-surface-variant rounded text-xs">
					<span class="font-medium">标记 {task.markerId}</span>
					<span class="text-theme-on-surface-variant">
						{getTaskTypeLabel(task.type)}
					</span>
					<span class="flex-1 text-theme-on-surface-variant">
						{#if task.status === 'queued'}
							<span class="text-yellow-600">排队中</span>
						{:else if task.status === 'processing'}
							<span class="text-blue-600">处理中</span>
						{:else}
							{getTaskStatusLabel(task.status)}
						{/if}
					</span>
					{#if task.progress !== undefined && task.status === 'processing'}
						<div class="w-16 h-1 bg-theme-surface rounded-full overflow-hidden">
							<div
								class="h-full bg-theme-primary transition-all duration-300"
								style="width: {task.progress}%"
							></div>
						</div>
					{:else if task.status === 'queued'}
						<span class="text-xs text-theme-on-surface-variant opacity-50">等待...</span>
					{/if}
					<button
						class="px-2 py-0.5 rounded hover:bg-theme-surface"
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