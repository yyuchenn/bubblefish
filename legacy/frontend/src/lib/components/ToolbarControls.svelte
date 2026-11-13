<script lang="ts">
	import { isImageOutOfBounds } from '$lib/services/imageViewerService';
	
	// 处理图片归位
	function handleResetPosition() {
		if (typeof window !== 'undefined' && (window as any).__resetImagePosition) {
			(window as any).__resetImagePosition();
		}
	}
</script>

<div class="flex items-center gap-6">
	<!-- 复位图片按钮 (仅在图片超出可视区域时显示) -->
	{#if $isImageOutOfBounds}
		<button
			class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-theme-error-container text-theme-on-error-container hover:bg-theme-error hover:text-theme-on-error transition-colors"
			title="将图片恢复到中心位置"
			onclick={handleResetPosition}
		>
			<!-- 复位图标 -->
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
				<path d="M3 3v5h5"/>
			</svg>
			<span class="text-sm font-medium">复位图片</span>
		</button>
	{/if}
</div>