<script lang="ts">
	import Modal from './Modal.svelte';
	import { currentTheme, availableThemes, themeActions } from '$lib/stores/themeStore';
	
	const {
		visible = false,
		onClose = () => {}
	} = $props<{
		visible?: boolean;
		onClose?: () => void;
	}>();

	function handleClose() {
		onClose();
	}

	function selectTheme(themeName: string) {
		themeActions.setThemeByName(themeName);
	}
</script>

<Modal {visible} onClose={handleClose}>
	<div class="h-[80vh] w-[80vw] flex flex-col">
		<div class="border-b border-theme-outline pb-4 mb-6">
			<h2 class="text-2xl font-bold text-theme-on-background">设置</h2>
		</div>
		
		<div class="flex-1 overflow-y-auto">
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

				<div class="border-t border-theme-outline pt-6">
					<h3 class="text-lg font-semibold text-theme-on-background mb-4">其他设置</h3>
					<p class="text-sm text-theme-on-surface-variant">更多设置选项即将推出...</p>
				</div>
			</div>
		</div>
	</div>
</Modal>