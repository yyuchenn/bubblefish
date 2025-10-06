<script lang="ts">
	import { bunnySettings, selectedMarkerIds } from '$lib/stores/bunnyStore';
	import { bunnyService } from '$lib/services/bunnyService';
	import { coreAPI, type OCRServiceInfo, type TranslationServiceInfo } from '$lib/core/adapter';
	import { pluginService, type PluginInfo } from '$lib/services/pluginService';
	import { eventService } from '$lib/services/eventService';
	import { get } from 'svelte/store';
	import { onDestroy, onMount } from 'svelte';

	// Dynamic service lists from plugins - start empty
	let ocrServices: { value: string; label: string }[] = [];
	let translationServices: { value: string; label: string }[] = [];
	let pluginEventsUnsubscribe: (() => void) | undefined;
	let pluginStoreUnsubscribe: (() => void) | undefined;
	let enabledPluginIds: Set<string> = new Set();

	// Load available services from plugins
	async function loadAvailableServices() {
		try {
			// Get OCR services from plugins only
			const ocrServiceList = await coreAPI.getAvailableOCRServices();
			const filteredOCR = (ocrServiceList || []).filter((service: OCRServiceInfo) => {
				return !service.plugin_id || enabledPluginIds.has(service.plugin_id);
			});

			if (filteredOCR.length > 0) {
				ocrServices = filteredOCR.map((service: OCRServiceInfo) => ({
					value: service.id,
					label: service.name
				}));
			} else {
				ocrServices = [];
			}

			// Get translation services from plugins only
			const translationServiceList = await coreAPI.getAvailableTranslationServices();
			const filteredTranslation = (translationServiceList || []).filter((service: TranslationServiceInfo) => {
				return !service.plugin_id || enabledPluginIds.has(service.plugin_id);
			});

			if (filteredTranslation.length > 0) {
				translationServices = filteredTranslation.map((service: TranslationServiceInfo) => ({
					value: service.id,
					label: service.name
				}));
			} else {
				translationServices = [];
			}
		} catch {
			// Keep services empty on error
			// This is expected during initial load when plugins are not yet loaded
		}
	}

	onMount(() => {
		const pluginsStore = pluginService.getPlugins();
		const initialPlugins = get(pluginsStore) as PluginInfo[];
		enabledPluginIds = new Set(
			initialPlugins
				.filter(plugin => plugin.enabled)
				.map(plugin => plugin.metadata.id)
		);

		pluginStoreUnsubscribe = pluginsStore.subscribe((pluginList: PluginInfo[]) => {
			enabledPluginIds = new Set(
				pluginList
					.filter(plugin => plugin.enabled)
					.map(plugin => plugin.metadata.id)
			);
			loadAvailableServices();
		});

		pluginEventsUnsubscribe = eventService.onBusinessEvent(event => {
			if (
				event.event_name === 'plugins:bunny_services_updated' ||
				event.event_name === 'plugins:changed'
			) {
				loadAvailableServices();
			}
		});

		loadAvailableServices();
	});

	onDestroy(() => {
		if (pluginEventsUnsubscribe) {
			pluginEventsUnsubscribe();
			pluginEventsUnsubscribe = undefined;
		}

		if (pluginStoreUnsubscribe) {
			pluginStoreUnsubscribe();
			pluginStoreUnsubscribe = undefined;
		}
	});
	
	async function runOCR() {
		const markerIds = Array.from($selectedMarkerIds);
		if (markerIds.length === 0) {
			alert('请先选择要进行OCR的标记');
			return;
		}

		if (ocrServices.length === 0) {
			alert('没有可用的OCR服务，请先加载OCR插件');
			return;
		}

		if (markerIds.length === 1) {
			await bunnyService.requestOCR(markerIds[0]);
		} else {
			await bunnyService.requestBatchOCR(markerIds);
		}
	}

	async function runTranslation() {
		const markerIds = Array.from($selectedMarkerIds);
		if (markerIds.length === 0) {
			alert('请先选择要翻译的标记');
			return;
		}

		if (translationServices.length === 0) {
			alert('没有可用的翻译服务，请先加载翻译插件');
			return;
		}

		if (markerIds.length === 1) {
			await bunnyService.requestTranslation(markerIds[0]);
		} else {
			await bunnyService.requestBatchTranslation(markerIds);
		}
	}
	
	async function updateOCRModel(event: Event) {
		const target = event.target as HTMLSelectElement;
		const { bunnyStore } = await import('$lib/stores/bunnyStore');
		// Use the value directly as string since we're now using dynamic services
		bunnyStore.updateSettings({ ocrModel: target.value });
	}

	async function updateTranslationService(event: Event) {
		const target = event.target as HTMLSelectElement;
		const { bunnyStore } = await import('$lib/stores/bunnyStore');
		// Use the value directly as string since we're now using dynamic services
		bunnyStore.updateSettings({ translationService: target.value });
	}
</script>

<div class="flex items-center gap-4 px-3 py-2 bg-theme-surface-variant border-b border-theme-outline">
	<div class="flex items-center gap-2">
		<label for="ocr-model-select" class="text-xs text-theme-on-surface">OCR模型:</label>
		<select
			id="ocr-model-select"
			class="px-2 py-1 text-xs bg-theme-surface border border-theme-outline rounded focus:outline-none focus:border-theme-primary"
			value={$bunnySettings.ocrModel}
			on:change={updateOCRModel}
			disabled={ocrServices.length === 0}
		>
			{#if ocrServices.length === 0}
				<option value="">无可用服务</option>
			{:else}
				{#each ocrServices as model (model.value)}
					<option value={model.value}>{model.label}</option>
				{/each}
			{/if}
		</select>
	</div>
	
	<div class="flex items-center gap-2">
		<label for="translation-service-select" class="text-xs text-theme-on-surface">翻译服务:</label>
		<select
			id="translation-service-select"
			class="px-2 py-1 text-xs bg-theme-surface border border-theme-outline rounded focus:outline-none focus:border-theme-primary"
			value={$bunnySettings.translationService}
			on:change={updateTranslationService}
			disabled={translationServices.length === 0}
		>
			{#if translationServices.length === 0}
				<option value="">无可用服务</option>
			{:else}
				{#each translationServices as service (service.value)}
					<option value={service.value}>{service.label}</option>
				{/each}
			{/if}
		</select>
	</div>
	
	<div class="flex-1"></div>
	
	<button
		class="px-3 py-1 text-xs bg-theme-primary text-theme-on-primary rounded hover:opacity-90 disabled:opacity-50"
		on:click={runOCR}
		disabled={$selectedMarkerIds.size === 0 || ocrServices.length === 0}
		title={ocrServices.length === 0 ? '没有可用的OCR服务' : ''}
	>
		{$selectedMarkerIds.size > 1 ? '批量OCR' : 'OCR'}
	</button>

	<button
		class="px-3 py-1 text-xs bg-theme-secondary text-theme-on-secondary rounded hover:opacity-90 disabled:opacity-50"
		on:click={runTranslation}
		disabled={$selectedMarkerIds.size === 0 || translationServices.length === 0}
		title={translationServices.length === 0 ? '没有可用的翻译服务' : ''}
	>
		{$selectedMarkerIds.size > 1 ? '批量翻译' : '翻译'}
	</button>
</div>