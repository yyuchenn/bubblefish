<script lang="ts">
	import Modal from './Modal.svelte';
	import { currentTheme, availableThemes, themeActions } from '$lib/stores/themeStore';
	import { platformService } from '$lib/services/platformService';
	import { 
		updaterService,
		updateInfo,
		updateSettings,
		isCheckingUpdate,
		isDownloadingUpdate,
		downloadProgress
	} from '$lib/services/updaterService';
	import { onMount } from 'svelte';
	
	const {
		visible = false,
		onClose = () => {}
	} = $props<{
		visible?: boolean;
		onClose?: () => void;
	}>();
	
	let activeTab = $state<'appearance' | 'editor' | 'update'>('appearance');

	function handleClose() {
		onClose();
	}

	function selectTheme(themeName: string) {
		themeActions.setThemeByName(themeName);
	}
	
	async function checkForUpdates() {
		await updaterService.checkForUpdates();
	}
	
	async function downloadAndInstall() {
		const message = '将下载更新，更新会在下次启动应用时自动安装。是否继续？';
		if (confirm(message)) {
			await updaterService.downloadAndInstall(false);
		}
	}
	
	async function restartNow() {
		if (confirm('立即重启应用以安装更新？')) {
			await updaterService.restartAndUpdate();
		}
	}
	
	function toggleAutoCheck(value: boolean) {
		updaterService.updateSetting('autoCheck', value);
	}
	
	function toggleAutoDownload(value: boolean) {
		updaterService.updateSetting('autoDownload', value);
	}
	
	onMount(() => {
		if (platformService.isTauri() && visible) {
			// Check for updates when settings modal is opened
			updaterService.checkForUpdates(true);
		}
	});
</script>

<Modal {visible} onClose={handleClose}>
	<div class="h-[80vh] w-[80vw] flex flex-col">
		<div class="border-b border-theme-outline pb-4 mb-6">
			<h2 class="text-2xl font-bold text-theme-on-background">设置</h2>
			<div class="flex gap-2 mt-4">
				<button
					class="px-4 py-2 rounded-md transition-colors {activeTab === 'appearance' ? 'bg-theme-primary text-theme-on-primary' : 'bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}"
					onclick={() => activeTab = 'appearance'}
				>
					外观
				</button>
				<button
					class="px-4 py-2 rounded-md transition-colors {activeTab === 'editor' ? 'bg-theme-primary text-theme-on-primary' : 'bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}"
					onclick={() => activeTab = 'editor'}
				>
					编辑器
				</button>
				{#if platformService.isTauri()}
					<button
						class="px-4 py-2 rounded-md transition-colors {activeTab === 'update' ? 'bg-theme-primary text-theme-on-primary' : 'bg-theme-surface text-theme-on-surface hover:bg-theme-surface-variant'}"
						onclick={() => activeTab = 'update'}
					>
						更新
					</button>
				{/if}
			</div>
		</div>
		
		<div class="flex-1 overflow-y-auto">
			{#if activeTab === 'appearance'}
				<div class="space-y-6">
					<div>
						<h3 class="text-lg font-semibold text-theme-on-background mb-4">主题</h3>
						<div class="grid grid-cols-3 gap-4">
							{#each availableThemes as theme (theme.name)}
								<button
									class="group relative rounded-lg border-2 p-4 transition-all hover:shadow-lg {$currentTheme.name === theme.name ? 'border-theme-primary' : 'border-theme-outline'}"
									onclick={() => selectTheme(theme.name)}
								>
									<div class="mb-3 h-32 rounded-md shadow-inner" style="background: linear-gradient(135deg, {theme.colorScheme.primary} 0%, {theme.colorScheme.secondary} 50%, {theme.colorScheme.background} 100%)"></div>
									<div class="flex items-center justify-between">
										<span class="text-sm font-medium text-theme-on-surface capitalize">{theme.name}</span>
										{#if $currentTheme.name === theme.name}
											<svg class="h-5 w-5 text-theme-primary" fill="currentColor" viewBox="0 0 20 20">
												<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
											</svg>
										{/if}
									</div>
									<div class="mt-2 grid grid-cols-4 gap-1">
										<div class="h-4 rounded" style="background-color: {theme.colorScheme.background}"></div>
										<div class="h-4 rounded" style="background-color: {theme.colorScheme.primary}"></div>
										<div class="h-4 rounded" style="background-color: {theme.colorScheme.secondary}"></div>
										<div class="h-4 rounded" style="background-color: {theme.colorScheme.surface}"></div>
									</div>
								</button>
							{/each}
						</div>
					</div>
				</div>
			{:else if activeTab === 'editor'}
				<div class="space-y-6">
					<h3 class="text-lg font-semibold text-theme-on-background mb-4">编辑器设置</h3>
					<p class="text-sm text-theme-on-surface-variant">更多设置选项即将推出...</p>
				</div>
			{:else if activeTab === 'update'}
				<div class="space-y-6">
					<div>
						<h3 class="text-lg font-semibold text-theme-on-background mb-4">软件更新</h3>
						
						<!-- Current Version Info -->
						<div class="bg-theme-surface rounded-lg p-4 mb-4">
							<div class="flex items-center justify-between mb-2">
								<span class="text-sm text-theme-on-surface-variant">当前版本</span>
								<span class="text-sm font-medium text-theme-on-surface">{$updateInfo.currentVersion}</span>
							</div>
							{#if $updateInfo.available}
								<div class="flex items-center justify-between mb-2">
									<span class="text-sm text-theme-on-surface-variant">可用版本</span>
									<span class="text-sm font-medium text-theme-primary">{$updateInfo.version}</span>
								</div>
							{/if}
							{#if $updateSettings.lastCheck}
								<div class="flex items-center justify-between">
									<span class="text-sm text-theme-on-surface-variant">上次检查</span>
									<span class="text-sm text-theme-on-surface-variant">
										{new Date($updateSettings.lastCheck).toLocaleString('zh-CN')}
									</span>
								</div>
							{/if}
						</div>
						
						<!-- Update Status -->
					{#if $updateInfo.pendingInstall}
					<div class="bg-theme-primary/10 text-theme-primary p-4 rounded-lg mb-4">
						<div class="flex items-center gap-2">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
							</svg>
							<span class="font-medium">更新已下载，将在下次启动时安装</span>
						</div>
					</div>
					{/if}
						{#if $updateInfo.available}
							<div class="bg-theme-primary/10 border border-theme-primary rounded-lg p-4 mb-4">
								<div class="flex items-start gap-3">
									<svg class="h-5 w-5 text-theme-primary mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
									</svg>
									<div class="flex-1">
										<p class="text-sm font-medium text-theme-on-surface mb-1">有新版本可用！</p>
										{#if $updateInfo.notes}
											<p class="text-sm text-theme-on-surface-variant">{$updateInfo.notes}</p>
										{/if}
									</div>
								</div>
							</div>
						{:else if $updateInfo.error}
							<div class="bg-theme-error/10 border border-theme-error rounded-lg p-4 mb-4">
								<p class="text-sm text-theme-error">检查更新失败：{$updateInfo.error}</p>
							</div>
						{:else}
							<div class="bg-theme-surface rounded-lg p-4 mb-4">
								<p class="text-sm text-theme-on-surface-variant">您的软件已是最新版本</p>
							</div>
						{/if}
						
						<!-- Download Progress -->
						{#if $isDownloadingUpdate}
							<div class="mb-4">
								<div class="flex items-center justify-between mb-2">
									<span class="text-sm text-theme-on-surface">正在下载更新...</span>
									<span class="text-sm text-theme-on-surface-variant">{Math.round($downloadProgress)}%</span>
								</div>
								<div class="w-full bg-theme-outline rounded-full h-2">
									<div 
										class="bg-theme-primary h-2 rounded-full transition-all duration-300"
										style="width: {$downloadProgress}%"
									></div>
								</div>
							</div>
						{/if}
						
						<!-- Action Buttons -->
						<div class="flex gap-3">
							<button
								class="px-4 py-2 bg-theme-primary text-theme-on-primary rounded-md hover:bg-theme-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={checkForUpdates}
								disabled={$isCheckingUpdate || $isDownloadingUpdate}
							>
								{$isCheckingUpdate ? '检查中...' : '检查更新'}
							</button>
							{#if $updateInfo.pendingInstall}
								<button
									class="px-4 py-2 bg-theme-secondary text-theme-on-secondary rounded-md hover:bg-theme-secondary/90 transition-colors"
									onclick={restartNow}
								>
									立即重启并安装
								</button>
							{:else if $updateInfo.available && !$isDownloadingUpdate}
								<button
									class="px-4 py-2 bg-theme-secondary text-theme-on-secondary rounded-md hover:bg-theme-secondary/90 transition-colors"
									onclick={downloadAndInstall}
								>
									下载更新
								</button>
							{/if}
						</div>
					</div>
					
					<!-- Update Settings -->
					<div class="border-t border-theme-outline pt-6">
						<h3 class="text-lg font-semibold text-theme-on-background mb-4">更新设置</h3>
						
						<div class="space-y-4">
							<label class="flex items-center justify-between cursor-pointer">
								<div>
									<span class="text-sm font-medium text-theme-on-surface">自动检查更新</span>
									<p class="text-xs text-theme-on-surface-variant mt-1">定期检查是否有新版本可用</p>
								</div>
								<input
									type="checkbox"
									checked={$updateSettings.autoCheck}
									onchange={(e) => toggleAutoCheck(e.currentTarget.checked)}
									class="w-10 h-5 bg-theme-outline rounded-full relative cursor-pointer transition-colors checked:bg-theme-primary"
								/>
							</label>
							
							<label class="flex items-center justify-between cursor-pointer">
								<div>
									<span class="text-sm font-medium text-theme-on-surface">自动下载更新</span>
									<p class="text-xs text-theme-on-surface-variant mt-1">发现新版本时自动下载，在下次启动时安装（需要自动检查）</p>
								</div>
								<input
									type="checkbox"
									checked={$updateSettings.autoDownload}
									onchange={(e) => toggleAutoDownload(e.currentTarget.checked)}
									disabled={!$updateSettings.autoCheck}
									class="w-10 h-5 bg-theme-outline rounded-full relative cursor-pointer transition-colors checked:bg-theme-primary disabled:opacity-50 disabled:cursor-not-allowed"
								/>
							</label>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
</Modal>