<script lang="ts">
	import { projectService, currentProject } from '$lib/services/projectService';
	import type { Language } from '$lib/types';
	import ImageManagement from './ImageManagement.svelte';
	
	let isEditingName = $state(false);
	let isHoveringName = $state(false);
	let editingProjectName = $state('');
	let inputElement = $state<HTMLInputElement | null>(null);
	
	// Language states
	let sourceLanguage = $state<Language>('japanese');
	let targetLanguage = $state<Language>('simplifiedChinese');
	
	// Language options
	const languageOptions: { value: Language; label: string }[] = [
		{ value: 'japanese', label: '日语' },
		{ value: 'english', label: '英语' },
		{ value: 'simplifiedChinese', label: '大陆简体' },
		{ value: 'traditionalChinese', label: '台湾繁体' }
	];
	
	$effect(() => {
		if ($currentProject) {
			editingProjectName = $currentProject.name;
			sourceLanguage = $currentProject.sourceLanguage || 'japanese';
			targetLanguage = $currentProject.targetLanguage || 'simplifiedChinese';
		}
	});
	
	function startEditingName() {
		if (!$currentProject) return;
		isEditingName = true;
		editingProjectName = $currentProject.name;
		
		// Focus input after DOM update
		setTimeout(() => {
			if (inputElement) {
				inputElement.focus();
				inputElement.select();
			}
		}, 0);
	}
	
	function cancelEditingName() {
		isEditingName = false;
		if ($currentProject) {
			editingProjectName = $currentProject.name;
		}
	}
	
	async function confirmEditingName() {
		if (!$currentProject || !editingProjectName.trim()) {
			cancelEditingName();
			return;
		}
		
		const trimmedName = editingProjectName.trim();
		if (trimmedName === $currentProject.name) {
			isEditingName = false;
			return;
		}
		
		const success = await projectService.updateProjectName($currentProject.id, trimmedName);
		if (success) {
			isEditingName = false;
		} else {
			// Revert on failure
			editingProjectName = $currentProject.name;
		}
	}
	
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			confirmEditingName();
		} else if (event.key === 'Escape') {
			cancelEditingName();
		}
	}
	
	function handleBlur(event: FocusEvent) {
		// Check if the blur is caused by clicking on the confirm/cancel buttons
		const relatedTarget = event.relatedTarget as HTMLElement;
		if (relatedTarget?.dataset.action === 'confirm' || relatedTarget?.dataset.action === 'cancel') {
			// Let the button click handler handle it
			return;
		}
		cancelEditingName();
	}
	
	async function handleLanguageChange() {
		if (!$currentProject) return;
		
		await projectService.updateProjectLanguages(
			$currentProject.id,
			sourceLanguage,
			targetLanguage
		);
	}
</script>

<!-- 项目配置面板组件 -->
<div class="relative h-full w-full overflow-hidden bg-theme-surface">
	<!-- 面板标题栏 -->
	<div class="absolute top-0 right-0 left-0 z-10 flex h-8 items-center justify-between border-b border-theme-outline bg-theme-surface-variant px-3">
		<span class="text-sm font-medium text-theme-on-surface select-none">项目配置</span>
		<!-- 可以在这里添加工具按钮 -->
		<div class="flex items-center gap-1">
			<!-- 占位符，以后可以添加设置、导出等功能 -->
		</div>
	</div>
	
	<!-- 面板内容区域 -->
	<div class="absolute top-8 right-0 left-0 bottom-0 overflow-y-auto p-4" onwheel={(e) => e.stopPropagation()}>
		{#if $currentProject}
			<div class="space-y-4">
				<!-- 项目名称 -->
				<div class="border-b border-theme-outline pb-4">
					<div class="text-xs text-theme-on-surface-variant uppercase tracking-wide mb-2 select-none">项目名称</div>
					<div>
						{#if isEditingName}
							<div class="flex items-center gap-1">
								<input
									bind:this={inputElement}
									type="text"
									bind:value={editingProjectName}
									onkeydown={handleKeydown}
									onblur={handleBlur}
									aria-label="项目名称"
									class="flex-1 min-w-0 px-2 py-1 text-sm bg-theme-surface-variant border border-theme-outline rounded focus:outline-none focus:border-theme-primary text-theme-on-surface"
								/>
								<div class="flex items-center gap-1 flex-shrink-0">
									<button
										data-action="confirm"
										onclick={confirmEditingName}
										class="p-1 hover:bg-theme-surface-variant rounded transition-colors"
										aria-label="确认修改"
										title="确认"
									>
										<svg class="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M20 6L9 17l-5-5"/>
										</svg>
									</button>
									<button
										data-action="cancel"
										onclick={cancelEditingName}
										class="p-1 hover:bg-theme-surface-variant rounded transition-colors"
										aria-label="取消修改"
										title="取消"
									>
										<svg class="w-4 h-4 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M18 6L6 18M6 6l12 12"/>
										</svg>
									</button>
								</div>
							</div>
						{:else}
							<button 
								class="flex items-center gap-2 group cursor-pointer hover:bg-theme-surface-variant px-2 py-1 -ml-2 rounded transition-colors"
								onmouseenter={() => isHoveringName = true}
								onmouseleave={() => isHoveringName = false}
								onclick={startEditingName}
								aria-label="点击编辑项目名称"
							>
								<span class="text-sm text-theme-on-surface font-medium">{$currentProject.name}</span>
								{#if isHoveringName}
									<svg class="w-4 h-4 text-theme-on-surface-variant opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
										<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
									</svg>
								{/if}
							</button>
						{/if}
					</div>
				</div>
				
				<!-- 语言设置 -->
				<div class="border-b border-theme-outline pb-4">
					<div class="text-xs text-theme-on-surface-variant uppercase tracking-wide mb-2 select-none">语言设置</div>
					<div class="space-y-3">
						<!-- 源语言 -->
						<div class="flex items-center justify-between">
							<label for="source-language" class="text-sm text-theme-on-surface select-none">源语言</label>
							<select
								id="source-language"
								bind:value={sourceLanguage}
								onchange={handleLanguageChange}
								class="px-3 py-1 text-sm bg-theme-surface-variant border border-theme-outline rounded focus:outline-none focus:border-theme-primary text-theme-on-surface"
							>
								{#each languageOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
						
						<!-- 目标语言 -->
						<div class="flex items-center justify-between">
							<label for="target-language" class="text-sm text-theme-on-surface select-none">目标语言</label>
							<select
								id="target-language"
								bind:value={targetLanguage}
								onchange={handleLanguageChange}
								class="px-3 py-1 text-sm bg-theme-surface-variant border border-theme-outline rounded focus:outline-none focus:border-theme-primary text-theme-on-surface"
							>
								{#each languageOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
					</div>
				</div>
				
				<!-- 图片管理 -->
				<ImageManagement />
			</div>
		{:else}
			<div class="flex flex-col items-center justify-center h-full text-center">
				<svg class="w-16 h-16 mb-4 text-theme-on-surface-variant opacity-50" viewBox="0 0 476.968 476.968" fill="currentColor">
					<polygon points="398.912,186.565 345.204,240.669 399.542,240.669 399.542,186.525"/>
					<path d="M94.963,240.669h26.059l-10.794-25.949c-0.256-0.622-0.364-1.258-0.566-1.88c-3.922-12.074,1.934-25.359,13.844-30.321 l0.054-0.024l-0.078-0.032c-6.063-2.516-10.793-7.235-13.331-13.331c-2.509-6.049-2.524-12.727-0.024-18.83l12.082-29.288 c3.836-9.233,12.773-15.196,22.773-15.196c3.23,0,6.39,0.63,9.387,1.864l0.062,0.024l-0.03-0.07 c-0.986-2.384-1.452-4.829-1.67-7.275c-5.451-2.959-11.601-4.799-18.24-4.799H38.443C17.214,95.561,0,112.775,0,134.005v19.202 v59.633v163.641l48.576-106.042C56.861,252.355,75.069,240.669,94.963,240.669z"/>
					<path d="M148.307,122.38c-1.088-0.45-2.214-0.66-3.324-0.66c-3.432,0-6.693,2.034-8.091,5.397l-12.067,29.249 c-0.878,2.144-0.87,4.543,0.016,6.679c0.892,2.142,2.594,3.844,4.728,4.728l16.61,6.841c-0.49,5.187-0.512,10.435,0,15.692 l-16.562,6.895c-4.441,1.848-6.553,6.965-4.705,11.415l12.159,29.219c0.498,1.204,1.452,2.004,2.354,2.834h13.549l12.051-5.016 c1.538,1.84,3.378,3.324,5.055,5.016h45.641l3.13-3.152c-18.41-3.464-34.11-15.81-41.503-33.576 c-5.768-13.875-5.792-29.164-0.062-43.055c5.723-13.891,16.516-24.715,30.392-30.484c6.903-2.88,14.178-4.34,21.602-4.34 c22.797,0,43.187,13.611,51.946,34.668c1.452,3.479,2.532,7.051,3.26,10.669l39.151-39.452l-2.128-5.117 c-1.398-3.354-4.659-5.381-8.075-5.381c-1.12,0-2.245,0.218-3.339,0.668l-16.562,6.887c-3.378-4.068-7.127-7.757-11.143-11.065 l6.849-16.608c0.884-2.144,0.878-4.543-0.008-6.677c-0.894-2.136-2.586-3.836-4.745-4.729L255.25,77.873 c-1.088-0.45-2.221-0.66-3.331-0.66c-3.432,0-6.685,2.034-8.067,5.396l-6.857,16.626c-2.624-0.242-5.264-0.374-7.911-0.374 c-2.586,0-5.187,0.124-7.797,0.38l-6.887-16.562c-1.398-3.354-4.643-5.38-8.051-5.38c-1.118,0-2.252,0.216-3.347,0.674 L173.79,90.118c-4.441,1.856-6.553,6.965-4.705,11.415l6.895,16.562c-4.084,3.37-7.773,7.113-11.081,11.135L148.307,122.38z"/>
					<path d="M229.277,141.964c-5.319,0-10.529,1.048-15.498,3.114c-9.947,4.138-17.688,11.911-21.796,21.873 c-4.107,9.961-4.093,20.934,0.046,30.887c6.895,16.578,24.675,26.199,42.077,24.305l35.12-35.376 c0.752-6.709-0.016-13.526-2.68-19.933C260.258,151.731,245.629,141.964,229.277,141.964z"/>
					<path d="M459.26,95.227l-25.173,25.351c-4.427,4.457-11.609,4.473-16.066,0.048c-30.818-30.57-30.291-22.719,6.545-59.835 c9.459-9.521-18.426-26.261-38.256-12.113c-37.862,26.943-34.624,31.283-37.062,80.039L238.128,240.669h84.666l69.122-69.634 l30.344-1.74c15.934-0.908,30.592-9.061,39.763-22.145l9.651-13.758C485.544,113.591,468.858,85.569,459.26,95.227z"/>
					<path d="M434.739,264.522H94.963c-10.631,0-20.274,6.195-24.699,15.856L10.257,411.361c-2.244,4.892-1.84,10.591,1.064,15.118 c2.912,4.526,7.921,7.267,13.309,7.267h364.764c6.189,0,11.803-3.603,14.372-9.225l55.673-121.518 c3.852-8.409,3.16-18.2-1.84-25.989C452.605,269.227,443.987,264.522,434.739,264.522z"/>
				</svg>
				<h3 class="text-lg font-semibold text-theme-on-surface mb-2 select-none">请先打开一个项目</h3>
			</div>
		{/if}
	</div>
</div>