<script lang="ts">
	import { onMount } from 'svelte';
	import { pluginService, type PluginInfo } from '$lib/services/pluginService';
	import { pluginConfigService, type ConfigField, type ConfigSchema, type PluginConfig } from '$lib/services/pluginConfigService';
	import { platformService } from '$lib/services/platformService';

	let plugins = $state<PluginInfo[]>([]);
	let selectedPluginId = $state<string>('');
	let selectedPlugin = $state<PluginInfo | null>(null);
	let configSchema = $state<ConfigSchema | null>(null);
	let configValues = $state<PluginConfig>({});
	let configErrors = $state<string[]>([]);
	let isSaving = $state(false);
	let isProcessingAction = $state(false);
	let uploading = $state(false);
	let uploadInput = $state<HTMLInputElement | null>(null);

	const isTauri = platformService.isTauri();

	const getExpectedExtension = () => {
		if (!isTauri) return '.zip';
		const platform = platformService.getPlatform();
		if (platform === 'linux') return '.so';
		if (platform === 'windows') return '.dll';
		return '.dylib';
	};

	const expectedExtension = getExpectedExtension();
	const acceptedFileTypes = expectedExtension === '.zip' ? '.zip' : `${expectedExtension}`;

	onMount(() => {
		// Load plugins
		const unsubscribe = pluginService.getPlugins().subscribe(pluginList => {
			plugins = pluginList;

			if (selectedPluginId) {
				const updatedPlugin = pluginList.find(p => p.metadata.id === selectedPluginId);
				if (updatedPlugin) {
					selectedPlugin = updatedPlugin;
				} else {
					selectedPluginId = '';
					selectedPlugin = null;
					configSchema = null;
					configValues = {};
					configErrors = [];
				}
			}

			if (!selectedPluginId && pluginList.length > 0) {
				const pluginWithConfig = pluginList.find(p => p.metadata?.config_schema);
				const pluginToSelect = pluginWithConfig ?? pluginList[0];
				selectPlugin(pluginToSelect.metadata.id);
			}
		});

		return () => {
			unsubscribe();
		};
	});

	function selectPlugin(pluginId: string) {
		selectedPluginId = pluginId;
		selectedPlugin = plugins.find(p => p.metadata.id === pluginId) || null;

		if (selectedPlugin?.metadata?.config_schema) {
			configSchema = selectedPlugin.metadata.config_schema;

			// Load existing config values
			let existingConfig = pluginConfigService.getConfig(pluginId);

			// Apply defaults from schema
			if (configSchema) {
				existingConfig = pluginConfigService.applyDefaults(existingConfig, configSchema);
				configValues = existingConfig;
			} else {
				configValues = existingConfig;
			}

			// Clear errors
			configErrors = [];
		} else {
			configSchema = null;
			configValues = {};
			configErrors = [];
		}
	}

	async function toggleSelectedPlugin() {
		if (!selectedPlugin) return;
		isProcessingAction = true;
		try {
			if (selectedPlugin.enabled) {
				await pluginService.disablePlugin(selectedPlugin.metadata.id);
			} else {
				await pluginService.enablePlugin(selectedPlugin.metadata.id);
			}
		} catch (error) {
			console.error('Failed to toggle plugin:', error);
			alert(`切换插件状态失败: ${error}`);
		} finally {
			isProcessingAction = false;
		}
	}

	async function deleteSelectedPlugin() {
		if (!selectedPlugin || selectedPlugin.source !== 'uploaded') return;
		const confirmMessage = `确定要删除上传的插件 "${selectedPlugin.metadata.name}" 吗？这将从本地存储中永久删除该插件。`;
		const confirmed = typeof window !== 'undefined'
			? await Promise.resolve(window.confirm(confirmMessage))
			: false;
		if (!confirmed) {
			return;
		}
		isProcessingAction = true;
		try {
			await pluginService.deleteUploadedPlugin(selectedPlugin.metadata.id);
		} catch (error) {
			console.error('Failed to delete plugin:', error);
			alert(`删除插件失败: ${error}`);
		} finally {
			isProcessingAction = false;
		}
	}

	async function handleNonTauriUpload(file: File) {
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

	async function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			await handleNonTauriUpload(file);
			input.value = '';
		}
	}

	async function addPlugin() {
		if (uploading || isProcessingAction) return;
		if (isTauri) {
			uploading = true;
			try {
				await pluginService.uploadPluginWithDialog();
				console.log('Plugin uploaded via dialog');
			} catch (error) {
				console.error('Failed to upload plugin:', error);
				if ((error as Error).message !== 'No file selected') {
					alert(`上传插件失败: ${error}`);
				}
			} finally {
				uploading = false;
			}
		} else {
			uploadInput?.click();
		}
	}

	function handleInputChange(key: string, event: Event) {
		const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
		let value: string | number | boolean = target.value;

		// Handle different input types
		if (target instanceof HTMLInputElement) {
			if (target.type === 'checkbox') {
				value = (target as HTMLInputElement).checked ? 'true' : 'false';
			} else if (target.type === 'number') {
				value = parseFloat(value) || 0;
			}
		}

		configValues = { ...configValues, [key]: value };
	}

	async function saveConfig() {
		if (!selectedPluginId || !configSchema) return;

		isSaving = true;
		configErrors = [];

		try {
			// Validate configuration
			const validation = pluginConfigService.validateConfig(configValues, configSchema);

			if (!validation.valid) {
				configErrors = validation.errors;
				return;
			}

			// Save configuration
			await pluginConfigService.setConfig(selectedPluginId, configValues);

			// Notify plugin about config update
			const plugin = plugins.find(p => p.metadata.id === selectedPluginId);
			if (plugin?.worker) {
				plugin.worker.postMessage({
					type: 'config_updated',
					config: configValues
				});
			}

			// Show success feedback
			alert('配置已保存');
		} catch (error) {
			console.error('Failed to save config:', error);
			configErrors = ['保存配置失败'];
		} finally {
			isSaving = false;
		}
	}

	function resetConfig() {
		if (!selectedPluginId || !configSchema) return;

		// Reset to defaults
		const defaultConfig = pluginConfigService.applyDefaults({}, configSchema);
		configValues = defaultConfig;
	}

	function getFieldValue(field: ConfigField): string | number | boolean {
		const value = configValues[field.key];
		if (value !== undefined) return value;
		return field.default_value || '';
	}

	function formatPluginName(name: string): string {
		return name.replace(/-plugin$/i, '');
	}
</script>

<div class="plugin-settings">
	<div class="plugin-list">
		<h3 class="text-lg font-semibold mb-4 text-theme-on-surface">已安装插件</h3>
		<div class="space-y-2 plugin-list-items">
			{#each plugins as plugin (plugin.metadata.id)}
				{@const isSelected = selectedPluginId === plugin.metadata.id}
				<button
					class={`w-full text-left p-3 rounded-lg transition-colors border border-theme-outline focus:outline-none focus:ring-2 focus:ring-theme-primary/40
						${isSelected ? ' bg-theme-primary text-theme-on-primary border-theme-primary shadow-md' : ' bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}`}
					onclick={() => selectPlugin(plugin.metadata.id)}
				>
					<div class="flex items-center justify-between gap-2">
						<div class="min-w-0">
							<div class={`font-medium truncate ${isSelected ? 'text-theme-on-primary' : 'text-theme-on-surface'}`}>
								{formatPluginName(plugin.metadata.name)}
							</div>
							<div class={`text-xs ${isSelected ? 'text-theme-on-primary/80' : 'text-theme-on-surface-variant'}`}>
								v{plugin.metadata.version}
								{#if plugin.source === 'builtin'}
									<span class="ml-2">[内置]</span>
								{:else if plugin.source === 'uploaded'}
									<span class="ml-2">[已上传]</span>
								{/if}
							</div>
						</div>
						<span
							class={`rounded-full px-2 py-0.5 text-[11px] font-medium flex-shrink-0 whitespace-nowrap
								${plugin.enabled ? (isSelected ? 'bg-theme-on-primary/20 text-theme-on-primary' : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200') : (isSelected ? 'bg-theme-on-primary/20 text-theme-on-primary' : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300')}`}
						>
							{plugin.enabled ? '已启用' : '已禁用'}
						</span>
					</div>
				</button>
			{/each}

			{#if plugins.length === 0}
				<div class="text-theme-on-surface-variant text-center py-8">
					暂无插件
				</div>
			{/if}
		</div>

		<div class="plugin-actions mt-5 space-y-3">
			{#if !isTauri}
				<input
					type="file"
					class="hidden"
					accept={acceptedFileTypes}
					bind:this={uploadInput}
					onchange={handleFileUpload}
				/>
			{/if}
			<button
				class="w-full px-4 py-2 rounded-md border border-theme-outline bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant disabled:opacity-50"
				onclick={addPlugin}
				disabled={uploading || isProcessingAction}
			>
				{uploading ? '上传中...' : isTauri ? `添加 ${expectedExtension} 插件` : '添加插件'}
			</button>
			<button
				class="w-full px-4 py-2 rounded-md border border-theme-outline bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant disabled:opacity-50"
				onclick={toggleSelectedPlugin}
				disabled={!selectedPlugin || isProcessingAction}
			>
				{selectedPlugin?.enabled ? '禁用插件' : '启用插件'}
			</button>
			<button
				class="w-full px-4 py-2 rounded-md border border-theme-outline bg-theme-surface text-theme-error hover:bg-theme-error/10 disabled:opacity-50"
				onclick={deleteSelectedPlugin}
				disabled={!selectedPlugin || selectedPlugin.source !== 'uploaded' || isProcessingAction}
			>
				删除插件
			</button>
			{#if !isTauri}
				<p class="text-xs text-theme-on-surface-variant">
					仅支持上传包含 pkg 目录的压缩包（{expectedExtension}）
				</p>
			{:else}
				<p class="text-xs text-theme-on-surface-variant">
					支持原生插件库文件（{expectedExtension}）
				</p>
			{/if}
		</div>
	</div>

	<div class="plugin-config">
		{#if selectedPlugin}
			<div class="mb-6 space-y-2">
				<div class="flex items-center justify-between gap-3">
					<h3 class="flex-1 min-w-0 truncate text-xl font-semibold text-theme-on-surface">{formatPluginName(selectedPlugin.metadata.name)}</h3>
					<span class={`rounded-full px-3 py-1 text-xs font-medium flex-shrink-0 whitespace-nowrap ${selectedPlugin.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'}`}>
						{selectedPlugin.enabled ? '已启用' : '已禁用'}
					</span>
				</div>
				<div class="text-sm text-theme-on-surface-variant">
					v{selectedPlugin.metadata.version}
					{#if selectedPlugin.metadata.author}
						· {selectedPlugin.metadata.author}
					{/if}
				</div>
				{#if selectedPlugin.metadata.description}
					<p class="text-sm text-theme-on-surface-variant">
						{selectedPlugin.metadata.description}
					</p>
				{/if}
			</div>

			{#if configSchema}
				{#if configErrors.length > 0}
					<div class="bg-theme-error-container text-theme-on-error-container p-4 rounded-lg mb-4">
						<div class="font-semibold mb-2">配置错误：</div>
						<ul class="list-disc list-inside space-y-1">
							{#each configErrors as error, index (index)}
								<li>{error}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="space-y-6">
					{#each configSchema.sections as section, sectionIndex (sectionIndex)}
						<div class="config-section">
							{#if section.title !== '配置' || configSchema.sections.length > 1}
								<h4 class="text-lg font-medium mb-3 text-theme-on-surface">{section.title}</h4>
							{/if}

							{#if section.description}
								<p class="text-sm text-theme-on-surface-variant mb-4">
									{section.description}
								</p>
							{/if}

							<div class="space-y-4">
								{#each section.fields as field (field.key)}
									{@const fieldId = `${selectedPluginId}-${field.key}`}
									<div class="form-field">
										<label for={fieldId} class="block mb-2 text-theme-on-surface">
											<span class="font-medium text-theme-on-surface">
												{field.label}
												{#if field.required}
													<span class="text-theme-error">*</span>
												{/if}
											</span>
										</label>

										{#if field.field_type === 'text' || field.field_type === 'password'}
											<input
												id={fieldId}
												type={field.field_type}
												class="w-full px-3 py-2 bg-theme-surface text-theme-on-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
												placeholder={field.placeholder || ''}
												value={getFieldValue(field)}
												disabled={field.disabled}
												onchange={e => handleInputChange(field.key, e)}
											/>
										{:else if field.field_type === 'number'}
											<input
												id={fieldId}
												type="number"
												class="w-full px-3 py-2 bg-theme-surface text-theme-on-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
												placeholder={field.placeholder || ''}
												value={getFieldValue(field)}
												disabled={field.disabled}
												onchange={e => handleInputChange(field.key, e)}
											/>
										{:else if field.field_type === 'textarea'}
											<textarea
												id={fieldId}
												class="w-full px-3 py-2 bg-theme-surface text-theme-on-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
												placeholder={field.placeholder || ''}
												rows="4"
												disabled={field.disabled}
												onchange={e => handleInputChange(field.key, e)}
											>{getFieldValue(field)}</textarea>
										{:else if field.field_type === 'select' && field.options}
											<select
												id={fieldId}
												class="w-full px-3 py-2 bg-theme-surface text-theme-on-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
												disabled={field.disabled}
												onchange={e => handleInputChange(field.key, e)}
											>
												{#each field.options as option (option.value)}
													<option value={option.value} selected={getFieldValue(field) === option.value}>
														{option.label}
													</option>
												{/each}
											</select>
										{:else if field.field_type === 'switch'}
											<label class="inline-flex items-center cursor-pointer">
												<input
													type="checkbox"
													class="sr-only peer"
													checked={getFieldValue(field) === 'true'}
													disabled={field.disabled}
													onchange={e => handleInputChange(field.key, e)}
												/>
												<div class="relative w-11 h-6 bg-theme-surface-variant rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-primary peer-checked:bg-theme-primary">
													<div class="absolute top-[2px] left-[2px] bg-white w-5 h-5 rounded-full transition-transform peer-checked:translate-x-5"></div>
												</div>
												<span class="ml-3 text-sm text-theme-on-surface">
													{getFieldValue(field) === 'true' ? '已启用' : '已禁用'}
												</span>
											</label>
										{/if}

										{#if field.help_text}
											<p class="text-sm text-theme-on-surface-variant mt-1">
												{field.help_text}
											</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>

				<div class="mt-6 flex gap-3">
					<button
						class="px-4 py-2 bg-theme-primary text-theme-on-primary rounded-md hover:opacity-90 disabled:opacity-50"
						onclick={saveConfig}
						disabled={isSaving}
					>
						{isSaving ? '保存中...' : '保存配置'}
					</button>
					<button
						class="px-4 py-2 bg-theme-surface text-theme-on-surface border border-theme-outline rounded-md hover:bg-theme-surface-variant"
						onclick={resetConfig}
					>
						重置为默认
					</button>
				</div>
			{:else}
				<div class="text-center py-12 text-theme-on-surface-variant">
					该插件没有配置选项
				</div>
			{/if}
		{:else}
			<div class="text-center py-12 text-theme-on-surface-variant">
				请选择一个插件进行配置
			</div>
		{/if}
	</div>
</div>

<style>
	.plugin-settings {
		display: grid;
		grid-template-columns: 300px 1fr;
		gap: 2rem;
		height: 100%;
	}

	.plugin-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding-right: 1rem;
	}

	.plugin-list-items {
		flex: 1;
		overflow-y: auto;
		padding-right: 0.25rem;
	}

	.plugin-config {
		overflow-y: auto;
		padding-right: 1rem;
	}

	.config-section {
		background: var(--color-surface);
		padding: 1.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--color-outline-variant);
		color: var(--color-on-surface);
	}
</style>