<script lang="ts">
	import { bunnySettings, selectedMarkerIds } from '$lib/stores/bunnyStore';
	import { bunnyService } from '$lib/services/bunnyService';
	import type { OCRModel, TranslationService } from '$lib/types/bunny';
	
	const ocrModels: { value: OCRModel; label: string }[] = [
		{ value: 'default', label: '默认' },
		{ value: 'tesseract', label: 'Tesseract' },
		{ value: 'paddleocr', label: 'PaddleOCR' },
		{ value: 'easyocr', label: 'EasyOCR' }
	];
	
	const translationServices: { value: TranslationService; label: string }[] = [
		{ value: 'default', label: '默认' },
		{ value: 'google', label: 'Google翻译' },
		{ value: 'deepl', label: 'DeepL' },
		{ value: 'chatgpt', label: 'ChatGPT' },
		{ value: 'baidu', label: '百度翻译' }
	];
	
	async function runOCR() {
		const markerIds = Array.from($selectedMarkerIds);
		if (markerIds.length === 0) {
			alert('请先选择要进行OCR的标记');
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
		
		if (markerIds.length === 1) {
			await bunnyService.requestTranslation(markerIds[0]);
		} else {
			await bunnyService.requestBatchTranslation(markerIds);
		}
	}
	
	function updateOCRModel(event: Event) {
		const target = event.target as HTMLSelectElement;
		const { bunnyStore } = import('$lib/stores/bunnyStore').then(m => {
			m.bunnyStore.updateSettings({ ocrModel: target.value as OCRModel });
		});
	}
	
	function updateTranslationService(event: Event) {
		const target = event.target as HTMLSelectElement;
		const { bunnyStore } = import('$lib/stores/bunnyStore').then(m => {
			m.bunnyStore.updateSettings({ translationService: target.value as TranslationService });
		});
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
		>
			{#each ocrModels as model}
				<option value={model.value}>{model.label}</option>
			{/each}
		</select>
	</div>
	
	<div class="flex items-center gap-2">
		<label for="translation-service-select" class="text-xs text-theme-on-surface">翻译服务:</label>
		<select
			id="translation-service-select"
			class="px-2 py-1 text-xs bg-theme-surface border border-theme-outline rounded focus:outline-none focus:border-theme-primary"
			value={$bunnySettings.translationService}
			on:change={updateTranslationService}
		>
			{#each translationServices as service}
				<option value={service.value}>{service.label}</option>
			{/each}
		</select>
	</div>
	
	<div class="flex-1"></div>
	
	<button
		class="px-3 py-1 text-xs bg-theme-primary text-theme-on-primary rounded hover:opacity-90 disabled:opacity-50"
		on:click={runOCR}
		disabled={$selectedMarkerIds.size === 0}
	>
		{$selectedMarkerIds.size > 1 ? '批量OCR' : 'OCR'}
	</button>
	
	<button
		class="px-3 py-1 text-xs bg-theme-secondary text-theme-on-secondary rounded hover:opacity-90 disabled:opacity-50"
		on:click={runTranslation}
		disabled={$selectedMarkerIds.size === 0}
	>
		{$selectedMarkerIds.size > 1 ? '批量翻译' : '翻译'}
	</button>
</div>