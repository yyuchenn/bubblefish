<script lang="ts">
	import { bunnySettings, selectedMarkerIds } from '$lib/stores/bunnyStore';
	import { bunnyService } from '$lib/services/bunnyService';
	import { coreAPI, type OCRServiceInfo, type TranslationServiceInfo } from '$lib/core/adapter';
	import { onMount } from 'svelte';

	// Dynamic service lists from plugins - start empty
	let ocrServices: { value: string; label: string }[] = [];
	let translationServices: { value: string; label: string }[] = [];

	// Load available services from plugins
	async function loadAvailableServices() {
		try {
			// Get OCR services from plugins only
			const ocrServiceList = await coreAPI.getAvailableOCRServices();
			if (ocrServiceList && ocrServiceList.length > 0) {
				ocrServices = ocrServiceList.map((service: OCRServiceInfo) => ({
					value: service.id,
					label: service.name
				}));
			} else {
				ocrServices = [];
			}

			// Get translation services from plugins only
			const translationServiceList = await coreAPI.getAvailableTranslationServices();
			if (translationServiceList && translationServiceList.length > 0) {
				translationServices = translationServiceList.map((service: TranslationServiceInfo) => ({
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
		// Try to load plugin services after a short delay to ensure initialization
		setTimeout(() => {
			loadAvailableServices();
		}, 500);

		// Reload services periodically when plugins are loaded/unloaded
		const reloadInterval = setInterval(loadAvailableServices, 1000);

		return () => {
			clearInterval(reloadInterval);
		};
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