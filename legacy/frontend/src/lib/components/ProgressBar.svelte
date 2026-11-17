<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { fly, fade } from 'svelte/transition';

	export let visible = false;
	export let progress = 0; // 0-100
	export let title = '处理中...';
	export let subtitle = '';
	export let canCancel = false;
	export let showPercentage = true;

	const dispatch = createEventDispatcher();

	function handleCancel() {
		if (canCancel) {
			dispatch('cancel');
		}
	}

	// 确保progress在有效范围内
	$: clampedProgress = Math.max(0, Math.min(100, progress));
</script>

{#if visible}
	<div
		class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
		transition:fade={{ duration: 200 }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="progress-title"
	>
		<div
			class="bg-theme-surface border-theme-outline-variant w-[90vw] max-w-[480px] min-w-80 rounded-xl border p-6 shadow-xl"
			transition:fly={{ y: 20, duration: 300 }}
		>
			<!-- 标题区域 -->
			<div class="mb-3 flex items-center justify-between">
				<h3 id="progress-title" class="text-theme-on-surface m-0 text-lg font-semibold">{title}</h3>
				{#if canCancel}
					<button
						class="hover:bg-theme-surface-variant text-theme-on-surface-variant hover:text-theme-on-surface focus-visible:outline-theme-primary flex items-center justify-center rounded-md p-1.5 transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
						on:click={handleCancel}
						aria-label="取消操作"
						title="取消操作"
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				{/if}
			</div>

			<!-- 副标题 -->
			{#if subtitle}
				<p class="text-theme-on-surface-variant m-0 mb-4 text-sm leading-relaxed">{subtitle}</p>
			{/if}

			<!-- 进度条容器 -->
			<div class="mb-4">
				<div class="bg-theme-surface-variant mb-2 h-2 w-full overflow-hidden rounded">
					<div
						class="progress-bar-fill bg-theme-primary relative h-full overflow-hidden rounded transition-all duration-300 ease-out will-change-[width]"
						style="width: {clampedProgress}%"
						role="progressbar"
						aria-valuenow={clampedProgress}
						aria-valuemin="0"
						aria-valuemax="100"
					></div>
				</div>

				<!-- 进度信息 -->
				<div class="text-theme-on-surface-variant flex items-center justify-between text-xs">
					{#if showPercentage}
						<span class="text-theme-on-surface font-semibold">{Math.round(clampedProgress)}%</span>
					{/if}
				</div>
			</div>

			<!-- 进度条下方的详细信息 -->
			<slot />
		</div>
	</div>
{/if}

<style>
	.progress-bar-fill::after {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 20px;
		background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3));
		animation: shimmer 1.5s infinite;
	}

	@keyframes shimmer {
		0% {
			transform: translateX(-20px);
		}
		100% {
			transform: translateX(20px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress-bar-fill::after {
			animation: none;
		}
	}
</style>
