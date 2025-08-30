<script lang="ts">
	import { fade } from 'svelte/transition';
	import { snapshotService } from '$lib/services/snapshotService';
	import { snapshotStorage } from '$lib/utils/snapshotStorage';
	import type { SnapshotMetadata } from '$lib/utils/snapshotStorage';
	
	interface Props {
		onClose?: () => void;
	}

	let { onClose }: Props = $props();
	
	let snapshots = $state<SnapshotMetadata[]>([]);
	let storageStats = $state<{
		totalSize: number;
		usedSize: number;
		availableSize: number;
		snapshotCount: number;
	} | null>(null);
	let loading = $state(false);
	let downloading = $state(false);
	
	$effect(() => {
		loadData();
	});
	
	async function loadData() {
		loading = true;
		try {
			// Get all snapshots
			snapshots = await snapshotService.getAllSnapshots();
			// Sort by date (newest first)
			snapshots.sort((a, b) => 
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
			storageStats = await snapshotService.getStorageStats();
		} catch (error) {
			console.error('Failed to load snapshot data:', error);
		} finally {
			loading = false;
		}
	}
	
	async function downloadSnapshot(snapshot: SnapshotMetadata) {
		downloading = true;
		try {
			// Get the full snapshot data
			const fullSnapshot = await snapshotStorage.getSnapshot(snapshot.id);
			if (!fullSnapshot) {
				throw new Error('快照未找到');
			}
			
			// Create a blob from the data
			const blob = new Blob([fullSnapshot.data], { type: 'application/octet-stream' });
			
			// Create download link
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = snapshot.fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			
			console.log(`Downloaded snapshot: ${snapshot.fileName}`);
		} catch (error) {
			console.error('Failed to download snapshot:', error);
			alert('下载快照失败');
		} finally {
			downloading = false;
		}
	}
	
	async function deleteSnapshot(snapshot: SnapshotMetadata) {
		if (!confirm(`删除快照 "${snapshot.fileName}"？`)) {
			return;
		}
		
		try {
			await snapshotService.deleteSnapshot(snapshot.id);
			await loadData();
		} catch (error) {
			console.error('Failed to delete snapshot:', error);
			alert('删除快照失败');
		}
	}
	
	async function clearAllSnapshots() {
		if (!confirm(`清空所有快照？\n\n这将释放 ${formatSize(storageStats?.usedSize || 0)} 的存储空间。\n\n此操作无法撤销。`)) {
			return;
		}
		
		try {
			await snapshotStorage.clearAllSnapshots();
			await loadData();
		} catch (error) {
			console.error('Failed to clear all snapshots:', error);
			alert('清空所有快照失败');
		}
	}
	
	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}
	
	function formatDate(date: Date | string): string {
		const d = new Date(date);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		
		// Less than 1 minute
		if (diff < 60000) {
			return '刚刚';
		}
		
		// Less than 1 hour
		if (diff < 3600000) {
			const minutes = Math.floor(diff / 60000);
			return `${minutes} 分钟前`;
		}
		
		// Less than 24 hours
		if (diff < 86400000) {
			const hours = Math.floor(diff / 3600000);
			return `${hours} 小时前`;
		}
		
		// Less than 7 days
		if (diff < 604800000) {
			const days = Math.floor(diff / 86400000);
			return `${days} 天前`;
		}
		
		// Default to full date
		return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN');
	}
	
	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			onClose?.();
		}
	}
	
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			onClose?.();
		}
	}
	
	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent global wheel blocking
		event.stopPropagation();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div 
	class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
	onclick={handleBackdropClick}
	transition:fade={{ duration: 200 }}
>
	<div class="bg-theme-background rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl" onwheel={handleWheel}>
		<!-- Header -->
		<div class="px-6 py-4 border-b border-theme-outline flex items-center justify-between">
			<h2 class="text-xl font-semibold text-theme-on-surface">快照</h2>
			<button
				class="p-1 rounded-lg hover:bg-theme-surface-variant transition-colors text-theme-on-surface-variant"
				onclick={onClose}
				aria-label="关闭"
			>
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
			</button>
		</div>
		
		<!-- Content -->
		<div class="flex-1 p-6 overflow-y-auto min-h-[200px]" onwheel={handleWheel}>
			<!-- Storage Info -->
			{#if storageStats}
				<div class="mb-6 p-4 bg-theme-surface-variant/30 rounded-lg">
					<div class="flex justify-between mb-3 text-sm text-theme-on-surface-variant">
						<span>存储空间：{formatSize(storageStats.usedSize)} / {formatSize(storageStats.totalSize)}</span>
						<span>共 {storageStats.snapshotCount} 个快照</span>
					</div>
					<div class="h-2 bg-theme-outline-variant rounded-full overflow-hidden">
						<div 
							class="h-full bg-gradient-to-r from-green-500 to-green-600 rounded-full transition-all duration-300"
							style="width: {(storageStats.usedSize / storageStats.totalSize * 100)}%"
						></div>
					</div>
				</div>
			{/if}
			
			<!-- Loading State -->
			{#if loading}
				<div class="text-center py-8 text-theme-on-surface-variant">
					加载快照中...
				</div>
			
			<!-- Empty State -->
			{:else if snapshots.length === 0}
				<div class="flex flex-col items-center justify-center py-12 text-theme-on-surface-variant">
					<svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-4 opacity-30">
						<path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" 
							stroke="currentColor" 
							stroke-width="1.5" 
							stroke-linecap="round" 
							stroke-linejoin="round"
						/>
					</svg>
					<p class="text-base mb-2">暂无快照</p>
					<p class="text-sm opacity-70">快照会在每 20 次操作后自动创建</p>
					<p class="text-sm opacity-70">为未保存的项目提供安全保障</p>
				</div>
			
			<!-- Snapshots List -->
			{:else}
				<div class="space-y-2">
					{#each snapshots as snapshot (snapshot.id)}
						<div class="flex items-center justify-between p-4 bg-theme-surface-variant/10 hover:bg-theme-surface-variant/20 rounded-lg transition-colors">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-3">
									<div class="text-sm font-medium text-theme-on-surface truncate">
										{snapshot.fileName}
									</div>
									<span class="text-xs px-2 py-0.5 bg-theme-surface-variant/50 text-theme-on-surface-variant rounded">
										{snapshot.projectName}
									</span>
								</div>
								<div class="flex gap-3 text-xs text-theme-on-surface-variant mt-2">
									<span>{formatSize(snapshot.size)}</span>
									<span>•</span>
									<span>{formatDate(snapshot.createdAt)}</span>
								</div>
							</div>
							<div class="flex gap-2 ml-4">
								<button
									class="p-2 rounded-lg hover:bg-theme-surface-variant transition-colors text-theme-on-surface-variant hover:text-theme-on-surface"
									onclick={() => downloadSnapshot(snapshot)}
									disabled={downloading}
									title="下载快照"
									aria-label="下载快照"
								>
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-5l5 5m0 0l5-5m-5 5V3" 
											stroke="currentColor" 
											stroke-width="2" 
											stroke-linecap="round" 
											stroke-linejoin="round"
										/>
									</svg>
								</button>
								<button
									class="p-2 rounded-lg hover:bg-red-50 transition-colors text-theme-on-surface-variant hover:text-red-600"
									onclick={() => deleteSnapshot(snapshot)}
									title="删除快照"
									aria-label="删除快照"
								>
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" 
											stroke="currentColor" 
											stroke-width="2" 
											stroke-linecap="round" 
											stroke-linejoin="round"
										/>
									</svg>
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		
		<!-- Footer -->
		<div class="px-6 py-4 border-t border-theme-outline flex justify-between gap-4">
			<button
				class="px-4 py-2 text-sm font-medium bg-theme-surface-variant text-theme-on-surface rounded-lg hover:bg-theme-surface-variant/80 transition-colors"
				onclick={onClose}
			>
				关闭
			</button>
			{#if snapshots.length > 0}
				<button
					class="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
					onclick={clearAllSnapshots}
				>
					清空所有快照
				</button>
			{/if}
		</div>
	</div>
</div>