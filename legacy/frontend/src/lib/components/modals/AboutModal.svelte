<script lang="ts">
	import Modal from './Modal.svelte';
	import { open } from '@tauri-apps/plugin-shell';
	import { platformService } from '$lib/services/platformService';
	
	const {
		visible = false,
		onClose = () => {}
	} = $props<{
		visible?: boolean;
		onClose?: () => void;
	}>();
	
	async function openGitHub() {
		const url = 'https://github.com/yyuchenn/bubblefish';
		
		if (platformService.isTauri()) {
			// Use Tauri's shell API to open URL in default browser
			await open(url);
		} else {
			// Fallback for web version
			window.open(url, '_blank');
		}
	}
	
	async function openRelease() {
		const url = 'https://github.com/yyuchenn/bubblefish/releases';
		
		if (platformService.isTauri()) {
			// Use Tauri's shell API to open URL in default browser
			await open(url);
		} else {
			// Fallback for web version
			window.open(url, '_blank');
		}
	}
	
	function close() {
		onClose();
	}
</script>

<Modal {visible} onClose={close}>
	<div class="flex flex-col w-[600px]">
		<!-- Main content area with logo on left and info on right -->
		<div class="flex gap-8 mb-6">
			<!-- Logo on the left -->
			<img src="/logo.png" alt="Bubblefish Logo" class="w-32 h-32 flex-shrink-0" />
			
			<!-- Info on the right -->
			<div class="flex flex-col justify-center">
				<!-- Software name -->
				<h3 class="text-theme-on-surface text-2xl font-bold mb-2">
					Bubblefish
				</h3>
				
				<!-- Version -->
				<p class="text-theme-on-surface-variant text-md">
					版本: {__APP_VERSION__}
				</p>
				
				<!-- Author info -->
				<p class="text-theme-on-surface-variant text-sm mb-4">
					联系邮箱: bubblefish-dev@proton.me
				</p>

				<!-- Description -->
				<p class="text-theme-on-surface-variant text-sm">
					交流&反馈QQ群: 1060743685
				</p>
			</div>
		</div>
		
		<!-- Buttons -->
		<div class="flex gap-4 justify-end w-full">
			{#if !platformService.isTauri()}
				<button
					class="bg-theme-primary text-theme-on-primary hover:bg-theme-primary-container hover:text-theme-on-primary-container hover:shadow-md rounded px-6 py-2 text-sm font-medium transition-all"
					onclick={openRelease}
				>
					下载桌面端
				</button>
			{/if}
			<button
				class="bg-theme-primary text-theme-on-primary hover:bg-theme-primary-container hover:text-theme-on-primary-container hover:shadow-md rounded px-6 py-2 text-sm font-medium transition-all"
				onclick={openGitHub}
			>
				GitHub
			</button>
			<button
				class="bg-theme-surface-variant text-theme-on-surface-variant hover:bg-theme-surface-container hover:text-theme-on-surface hover:shadow-md rounded px-6 py-2 text-sm font-medium transition-all"
				onclick={close}
			>
				关闭
			</button>
		</div>
	</div>
</Modal>