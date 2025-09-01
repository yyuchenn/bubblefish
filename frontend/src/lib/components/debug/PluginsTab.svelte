<script lang="ts">
	import { onMount } from 'svelte';
	import { pluginService, type PluginInfo } from '../../services/pluginService';
	
	let loading = $state(false);
	let selectedPlugin = $state<string>('');
	
	const availablePlugins = [
		{ id: 'marker-logger', name: 'Marker Logger', description: '监听和记录 Marker 事件' },
		{ id: 'md5-calculator', name: 'MD5 Calculator', description: '计算文件的 MD5 哈希值' }
	];
	
	const pluginsStore = pluginService.getPlugins();
	const plugins = $derived($pluginsStore);
	
	onMount(() => {
		if (availablePlugins.length > 0) {
			selectedPlugin = availablePlugins[0].id;
		}
	});
	
	function handleWheel(event: WheelEvent) {
		// Stop propagation to prevent parent elements from handling the wheel event
		event.stopPropagation();
	}
	
	async function loadPlugin() {
		if (!selectedPlugin) return;
		
		loading = true;
		try {
			await pluginService.loadPlugin(selectedPlugin);
			console.log(`Plugin ${selectedPlugin} loaded`);
		} catch (error) {
			console.log(`Could not load ${selectedPlugin} plugin:`, error);
		} finally {
			loading = false;
		}
	}
	
	async function togglePlugin(plugin: PluginInfo) {
		if (plugin.enabled) {
			await pluginService.disablePlugin(plugin.metadata.id);
		} else {
			await pluginService.enablePlugin(plugin.metadata.id);
		}
	}
	
	async function unloadPlugin(plugin: PluginInfo) {
		if (confirm(`确定要卸载插件 "${plugin.metadata.name}" 吗？`)) {
			await pluginService.unloadPlugin(plugin.metadata.id);
		}
	}
	
	
	function getStatusBadgeClass(enabled: boolean): string {
		return enabled
			? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
			: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
	}
</script>

<div class="flex h-full flex-col p-4">
	<!-- Header -->
	<div class="mb-4">
		<h3 class="text-theme-on-surface mb-3 text-lg font-semibold">插件管理</h3>
		
		<!-- Available Plugins -->
		<div class="bg-theme-surface-variant/30 rounded-lg p-3">
			<p class="text-theme-on-surface-variant mb-2 text-sm font-medium">可用插件</p>
			<div class="flex items-center gap-2">
				<select
					class="bg-theme-surface border-theme-outline text-theme-on-surface flex-1 rounded border px-3 py-1.5 text-sm"
					bind:value={selectedPlugin}
					disabled={loading}
				>
					{#each availablePlugins as plugin (plugin.id)}
						<option value={plugin.id}>
							{plugin.name} - {plugin.description}
						</option>
					{/each}
				</select>
				<button
					class="bg-theme-primary text-theme-on-primary hover-theme rounded px-4 py-1.5 text-sm font-medium transition-colors"
					onclick={loadPlugin}
					disabled={loading || !selectedPlugin || plugins.some(p => p.metadata.id === selectedPlugin)}
				>
					{loading ? '加载中...' : '加载插件'}
				</button>
			</div>
		</div>
	</div>
	
	<!-- Plugin List -->
	<div 
		class="flex-1 overflow-y-auto"
		onwheel={handleWheel}
	>
		{#if plugins.length === 0}
			<div class="text-theme-on-surface-variant flex h-full items-center justify-center text-center">
				<div>
					<p class="mb-2 text-lg">暂无已加载的插件</p>
					<p class="text-sm">从上方列表中选择并加载插件</p>
				</div>
			</div>
		{:else}
			<div class="space-y-3">
				{#each plugins as plugin (plugin.metadata.id)}
					<div class="bg-theme-surface border-theme-outline rounded-lg border p-4">
						<div class="mb-2 flex items-start justify-between">
							<div>
								<h4 class="text-theme-on-surface font-semibold">
									{plugin.metadata.name}
								</h4>
								<p class="text-theme-on-surface-variant text-sm">
									v{plugin.metadata.version} by {plugin.metadata.author}
								</p>
							</div>
							<span class={`rounded-full px-2 py-1 text-xs font-medium ${getStatusBadgeClass(plugin.enabled)}`}>
								{plugin.enabled ? '已启用' : '已禁用'}
							</span>
						</div>
						
						<p class="text-theme-on-surface-variant mb-3 text-sm">
							{plugin.metadata.description}
						</p>
						
						{#if plugin.metadata.subscribed_events.length > 0}
							<div class="mb-3">
								<p class="text-theme-on-surface-variant mb-1 text-xs font-medium">监听事件：</p>
								<div class="flex flex-wrap gap-1">
									{#each plugin.metadata.subscribed_events as event (event)}
										<span class="bg-theme-surface-variant text-theme-on-surface-variant rounded px-2 py-0.5 text-xs">
											{event}
										</span>
									{/each}
								</div>
							</div>
						{/if}
						
						<div class="flex gap-2">
							<button
								class="text-theme-primary hover:bg-theme-primary/10 rounded px-3 py-1 text-sm transition-colors"
								onclick={() => togglePlugin(plugin)}
							>
								{plugin.enabled ? '禁用' : '启用'}
							</button>
							<button
								class="text-theme-error hover:bg-theme-error/10 rounded px-3 py-1 text-sm transition-colors"
								onclick={() => unloadPlugin(plugin)}
							>
								卸载
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
	
</div>