<script lang="ts">
	import { fly } from 'svelte/transition';
	import { activeToastNotifications, notificationStore } from '$lib/stores/notificationStore';
	import type { NotificationLevel } from '$lib/stores/notificationStore';

	const toasts = activeToastNotifications;

	interface ToastStyle {
		icon: string;
		borderClass: string;
		accentClass: string;
		iconClass: string;
	}

	const levelStyles: Record<NotificationLevel, ToastStyle> = {
		info: {
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm2 12h-4v-2h1v-4h-1V9h3v6h1v2z',
			borderClass: 'border-theme-primary',
			accentClass: 'bg-theme-primary-container text-theme-on-primary-container',
			iconClass: 'text-theme-primary'
		},
		success: {
			icon: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
			borderClass: 'border-theme-outline',
			accentClass: 'bg-theme-secondary-container text-theme-on-secondary-container',
			iconClass: 'text-theme-secondary'
		},
		warning: {
			icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
			borderClass: 'border-theme-outline',
			accentClass: 'bg-theme-surface-variant text-theme-on-surface',
			iconClass: 'text-theme-on-surface'
		},
		error: {
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
			borderClass: 'border-theme-error',
			accentClass: 'bg-theme-error-container text-theme-on-error-container',
			iconClass: 'text-theme-error'
		}
	};

	function dismiss(id: string) {
		notificationStore.dismiss(id);
	}
</script>

{#if $toasts.length > 0}
	<div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-3">
		{#each $toasts as toast (toast.id)}
			{@const style = levelStyles[toast.level] ?? levelStyles.info}
			<div
				class={`pointer-events-auto overflow-hidden rounded-lg border bg-theme-surface shadow-2xl backdrop-blur-md ${style.borderClass}`}
				transition:fly={{ y: 16, duration: 180, easing: (t) => t * t }}
			>
				<div class="flex items-start gap-3 p-3">
					<div class={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border ${style.accentClass}`}>
						<svg viewBox="0 0 24 24" class={`h-4 w-4 ${style.iconClass}`} fill="currentColor">
							<path d={style.icon} />
						</svg>
					</div>
					<div class="flex-1 text-xs text-theme-on-surface">
						<div class="font-medium">
							{toast.title ?? '通知'}
						</div>
						<div class="mt-1 leading-relaxed text-theme-on-surface-variant">
							{toast.message}
						</div>
					</div>
					<button
						onclick={() => dismiss(toast.id)}
						class="rounded p-1 text-theme-on-surface-variant transition-colors hover:bg-theme-secondary-container/50"
						title="关闭通知"
						aria-label="关闭通知"
					>
						<svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
							<path d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L12 13.41l-6.29 6.3-1.42-1.42L10.59 12 4.29 5.71 5.71 4.29 12 10.59l6.29-6.3z" />
						</svg>
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}
