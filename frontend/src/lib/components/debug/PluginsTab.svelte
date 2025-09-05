<script lang="ts">
	import { onMount } from 'svelte';
	import { pluginService, type PluginInfo } from '../../services/pluginService';
	import { platformService } from '../../services/platformService';
	
	let loading = $state(false);
	let selectedPlugin = $state<string>('');
	let uploadInput: HTMLInputElement;
	let uploading = $state(false);
	let dragOver = $state(false);
	
	const availablePlugins = [
		{ id: 'marker-logger', name: 'Marker Logger', description: '监听和记录 Marker 事件' },
		{ id: 'md5-calculator', name: 'MD5 Calculator', description: '计算文件的 MD5 哈希值' }
	];
	
	// Get expected file extension for current platform
	const getExpectedExtension = () => {
		if (!platformService.isTauri()) return '.zip';
		const platform = platformService.getPlatform();
		if (platform === 'linux') return '.so';
		if (platform === 'windows') return '.dll';
		return '.dylib';
	};
	
	const expectedExtension = getExpectedExtension();
	const acceptedFileTypes = expectedExtension === '.zip' ? '.zip' : `${expectedExtension}`;
	
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
		if (plugin.isUploaded) {
			if (confirm(`确定要删除上传的插件 "${plugin.metadata.name}" 吗？这将从本地存储中永久删除该插件。`)) {
				await pluginService.deleteUploadedPlugin(plugin.metadata.id);
			}
		} else {
			await pluginService.unloadPlugin(plugin.metadata.id);
		}
	}
	
	async function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			await uploadPlugin(file);
			input.value = ''; // Reset input
		}
	}
	
	async function uploadPlugin(file: File) {
		if (!file.name.endsWith(expectedExtension)) {
			alert(`请选择 ${expectedExtension} 文件`);
			return;
		}
		
		uploading = true;
		try {
			await pluginService.uploadPlugin(file);
			console.log(`Plugin uploaded: ${file.name}`);
		} catch (error) {
			console.error('Failed to upload plugin:', error);
			alert(`上传插件失败: ${error}`);
		} finally {
			uploading = false;
		}
	}
	
	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		dragOver = true;
	}
	
	function handleDragLeave(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
	}
	
	async function handleDrop(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
		
		const file = event.dataTransfer?.files[0];
		if (file) {
			await uploadPlugin(file);
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
		
		<!-- Upload Plugin -->
		<div class="bg-theme-surface-variant/30 rounded-lg p-3 mb-3">
			<p class="text-theme-on-surface-variant mb-2 text-sm font-medium">上传插件</p>
			<div 
				class="border-2 border-dashed rounded-lg p-4 text-center transition-colors {dragOver ? 'border-theme-primary bg-theme-primary/10' : 'border-theme-outline'}"
				ondragover={handleDragOver}
				ondragleave={handleDragLeave}
				ondrop={handleDrop}
			>
				<input
					type="file"
					accept={acceptedFileTypes}
					class="hidden"
					bind:this={uploadInput}
					onchange={handleFileUpload}
				/>
				{#if uploading}
					<p class="text-theme-on-surface-variant text-sm">上传中...</p>
				{:else}
					<button
						class="text-theme-primary hover:text-theme-primary/80 text-sm font-medium transition-colors"
						onclick={() => uploadInput.click()}
					>
						点击选择或拖拽 {expectedExtension} 文件到此处
					</button>
					<p class="text-theme-on-surface-variant text-xs mt-1">
						{platformService.isTauri() ? '上传原生插件库文件' : '上传包含完整 pkg 目录内容的 ZIP 压缩包（包括 snippets 文件夹）'}
					</p>
				{/if}
			</div>
		</div>
		
		<!-- Available Plugins -->
		<div class="bg-theme-surface-variant/30 rounded-lg p-3">
			<p class="text-theme-on-surface-variant mb-2 text-sm font-medium">内置插件</p>
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
									{#if plugin.isUploaded}
										<span class="text-theme-primary text-xs font-normal ml-2">[已上传]</span>
									{/if}
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
								{plugin.isUploaded ? '删除' : '卸载'}
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
	
</div>