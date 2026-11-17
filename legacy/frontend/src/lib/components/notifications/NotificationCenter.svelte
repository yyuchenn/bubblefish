<script lang="ts">
	import { browser } from '$app/environment';
	import { notificationStore, unreadNotificationCount } from '$lib/stores/notificationStore';
	import type { NotificationLevel } from '$lib/stores/notificationStore';

	const notifications = notificationStore;
	const unreadCount = unreadNotificationCount;

	let isOpen = $state(false);
	let triggerElement = $state<HTMLButtonElement>();
	let panelElement = $state<HTMLDivElement>();

	interface LevelStyle {
		icon: string;
		avatarClass: string;
		iconClass: string;
	}

	const levelStyles: Record<NotificationLevel, LevelStyle> = {
		info: {
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm2 12h-4v-2h1v-4h-1V9h3v6h1v2z',
			avatarClass: 'bg-theme-primary-container text-theme-on-primary-container border border-theme-primary',
			iconClass: 'text-theme-primary'
		},
		success: {
			icon: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
			avatarClass: 'bg-theme-secondary-container text-theme-on-secondary-container border border-theme-outline',
			iconClass: 'text-theme-secondary'
		},
		warning: {
			icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
			avatarClass: 'bg-theme-surface-variant text-theme-on-surface border border-theme-outline',
			iconClass: 'text-theme-on-surface'
		},
		error: {
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
			avatarClass: 'bg-theme-error-container text-theme-on-error-container border border-theme-error',
			iconClass: 'text-theme-error'
		}
	};

	const getLevelStyle = (level: NotificationLevel): LevelStyle => levelStyles[level] ?? levelStyles.info;

	const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

	function togglePanel() {
		isOpen = !isOpen;
	}

	function closePanel() {
		isOpen = false;
	}

	function formatRelativeTime(timestamp: number): string {
		const diff = Date.now() - timestamp;
		const minutes = Math.round(diff / 60000);

		if (Math.abs(minutes) < 1) {
			return '刚刚';
		}

		if (Math.abs(minutes) < 60) {
			return relativeFormatter.format(-minutes, 'minute');
		}

		const hours = Math.round(minutes / 60);
		if (Math.abs(hours) < 24) {
			return relativeFormatter.format(-hours, 'hour');
		}

		const days = Math.round(hours / 24);
		return relativeFormatter.format(-days, 'day');
	}

	function handleAction(action: { href?: string; onClick?: () => void }) {
		if (action.onClick) {
			action.onClick();
		}

		if (action.href && browser) {
			window.open(action.href, '_blank');
		}
	}

	function handleOutsideClick(event: MouseEvent) {
		if (!isOpen) return;
		const target = event.target as Node;
		if (!panelElement) return;

		if (panelElement.contains(target)) return;
		if (triggerElement && triggerElement.contains(target)) return;

		closePanel();
	}

	function stopWheelPropagation(event: WheelEvent) {
		event.stopPropagation();
	}

	$effect(() => {
		if (!browser) {
			return undefined;
		}

		if (!isOpen) {
			document.removeEventListener('mousedown', handleOutsideClick);
			return undefined;
		}

		document.addEventListener('mousedown', handleOutsideClick);
		notificationStore.markAllRead();

		return () => {
			document.removeEventListener('mousedown', handleOutsideClick);
		};
	});
</script>

<div class="relative flex items-center">
	<button
		bind:this={triggerElement}
		onclick={togglePanel}
		class="relative flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-theme-surface/60"
		title="通知中心"
		aria-label="通知中心"
	>
		<svg viewBox="0 0 24 24" class="h-4 w-4">
			<path
				fill="currentColor"
				d="M12 22c1.1 0 1.99-.9 1.99-2H10c0 1.1.89 2 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 10-3 0v.68C7.63 5.36 6 7.92 6 11v5l-1.8 1.8a.5.5 0 00.35.85h14.9a.5.5 0 00.35-.85L18 16z"
			/>
		</svg>

		{#if $unreadCount > 0}
			<span
				class="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-theme-error px-1 text-[10px] font-semibold text-white"
			>
				{$unreadCount > 99 ? '99+' : $unreadCount}
			</span>
		{/if}
	</button>

	{#if isOpen}
		<div
			bind:this={panelElement}
			class="absolute right-0 bottom-full z-50 mb-2 w-80 origin-bottom-right rounded-lg border border-theme-outline bg-theme-surface shadow-xl"
			onwheel={stopWheelPropagation}
		>
			<div class="flex items-center justify-between border-b border-theme-outline/60 px-3 py-2">
				<div class="text-sm font-semibold text-theme-on-surface">通知</div>
				<div class="flex items-center gap-2 text-xs text-theme-on-surface-variant">
					{#if $notifications.length > 0}
						<button class="transition-colors hover:text-theme-primary" onclick={() => notificationStore.markAllRead()}>
							全部已读
						</button>
						<button class="transition-colors hover:text-theme-primary" onclick={() => notificationStore.clear()}>
							清除
						</button>
					{/if}
				</div>
			</div>

			<div class="max-h-80 overflow-y-auto p-2" onwheel={stopWheelPropagation}>
				{#if $notifications.length === 0}
					<p class="py-6 text-center text-xs text-theme-on-surface-variant">暂无通知</p>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each $notifications as notification (notification.id)}
							{@const style = getLevelStyle(notification.level)}
							<li
								class={`rounded-md border border-theme-outline bg-theme-surface p-3 text-xs shadow-sm transition-opacity ${
									notification.read ? 'opacity-80' : 'opacity-100'
								}`}
							>
								<div class="flex items-start gap-3">
									<div class={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${style.avatarClass}`}>
										<svg viewBox="0 0 24 24" class={`h-4 w-4 ${style.iconClass}`} fill="currentColor">
											<path d={style.icon} />
										</svg>
									</div>

									<div class="flex-1 flex flex-col gap-2">
										<div class="space-y-1">
											<div class={`font-medium ${notification.read ? 'text-theme-on-surface-variant' : 'text-theme-on-surface'}`}>
												{notification.title ?? '通知'}
											</div>
											<div class="text-theme-on-surface-variant">
												{notification.message}
											</div>
										</div>

										{#if notification.actions?.length}
											<div class="flex flex-wrap gap-2">
												{#each notification.actions as action, index (index)}
													<button
														onclick={() => handleAction(action)}
														class="rounded border border-theme-outline px-2 py-1 text-[11px] text-theme-on-surface transition-colors hover:bg-theme-secondary-container/50"
													>
														{action.label}
													</button>
												{/each}
											</div>
										{/if}

										<div class="flex items-center justify-between gap-3 text-[11px]">
											<div class="text-[10px] text-theme-on-surface-variant">
												{formatRelativeTime(notification.createdAt)}
											</div>
											<button
												onclick={() => notificationStore.remove(notification.id)}
												class="rounded px-2 py-1 text-theme-on-surface-variant transition-colors hover:bg-theme-secondary-container/50"
											>
												删除
											</button>
										</div>
									</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</div>
