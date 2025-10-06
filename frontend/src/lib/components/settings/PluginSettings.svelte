<script lang="ts">
	import { onMount } from 'svelte';
	import { pluginService, type PluginInfo } from '$lib/services/pluginService';
	import { pluginConfigService, type ConfigField, type ConfigSchema, type PluginConfig } from '$lib/services/pluginConfigService';

	let plugins = $state<PluginInfo[]>([]);
	let selectedPluginId = $state<string>('');
	let selectedPlugin = $state<PluginInfo | null>(null);
	let configSchema = $state<ConfigSchema | null>(null);
	let configValues = $state<PluginConfig>({});
	let configErrors = $state<string[]>([]);
	let isSaving = $state(false);

	onMount(() => {
		// Load plugins
		const unsubscribe = pluginService.getPlugins().subscribe(pluginList => {
			plugins = pluginList.filter(plugin => plugin.enabled);

			// Auto-select first plugin with config schema if none selected
			if (!selectedPluginId && plugins.length > 0) {
				const pluginWithConfig = plugins.find(p => p.metadata?.config_schema);
				if (pluginWithConfig) {
					selectPlugin(pluginWithConfig.metadata.id);
				}
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
</script>

<div class="plugin-settings">
	<div class="plugin-list">
		<h3 class="text-lg font-semibold mb-4">已安装插件</h3>
		<div class="space-y-2">
			{#each plugins as plugin (plugin.metadata.id)}
				{@const hasConfig = !!plugin.metadata?.config_schema}
				<button
					class="w-full text-left p-3 rounded-lg transition-colors {selectedPluginId === plugin.metadata.id ? 'bg-theme-primary text-theme-on-primary' : 'bg-theme-surface hover:bg-theme-surface-variant'}"
					onclick={() => selectPlugin(plugin.metadata.id)}
					disabled={!hasConfig}
				>
					<div class="font-medium">{plugin.metadata.name}</div>
					<div class="text-sm opacity-75">
						v{plugin.metadata.version}
						{#if !hasConfig}
							<span class="ml-2">(无配置项)</span>
						{/if}
					</div>
				</button>
			{/each}

			{#if plugins.length === 0}
				<div class="text-theme-on-surface-variant text-center py-8">
					没有已启用的插件
				</div>
			{/if}
		</div>
	</div>

	<div class="plugin-config">
		{#if selectedPlugin && configSchema}
			<div class="mb-6">
				<h3 class="text-xl font-semibold">{selectedPlugin.metadata.name} 配置</h3>
				<p class="text-sm text-theme-on-surface-variant mt-1">
					{selectedPlugin.metadata.description}
				</p>
			</div>

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
							<h4 class="text-lg font-medium mb-3">{section.title}</h4>
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
									<label for={fieldId} class="block mb-2">
										<span class="font-medium">
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
											class="w-full px-3 py-2 bg-theme-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
											placeholder={field.placeholder || ''}
											value={getFieldValue(field)}
											disabled={field.disabled}
											onchange={e => handleInputChange(field.key, e)}
										/>
									{:else if field.field_type === 'number'}
										<input
											id={fieldId}
											type="number"
											class="w-full px-3 py-2 bg-theme-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
											placeholder={field.placeholder || ''}
											value={getFieldValue(field)}
											disabled={field.disabled}
											onchange={e => handleInputChange(field.key, e)}
										/>
									{:else if field.field_type === 'textarea'}
										<textarea
											id={fieldId}
											class="w-full px-3 py-2 bg-theme-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
											placeholder={field.placeholder || ''}
											rows="4"
											disabled={field.disabled}
											onchange={e => handleInputChange(field.key, e)}
										>{getFieldValue(field)}</textarea>
									{:else if field.field_type === 'select' && field.options}
										<select
											id={fieldId}
											class="w-full px-3 py-2 bg-theme-surface border border-theme-outline rounded-md focus:outline-none focus:ring-2 focus:ring-theme-primary"
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
											<span class="ml-3 text-sm">
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
		{:else if selectedPluginId}
			<div class="text-center py-12 text-theme-on-surface-variant">
				该插件没有配置选项
			</div>
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
		overflow-y: auto;
		padding-right: 1rem;
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
	}
</style>