import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
	label: string;
	href?: string;
	onClick?: () => void;
}

export interface NotificationOptions {
	id?: string;
	title?: string;
	message: string;
	level?: NotificationLevel;
	actions?: NotificationAction[];
	toast?: boolean;
	/** Milliseconds before the notification auto-dismisses. Set to 0 to disable. */
	autoClose?: number;
	/** Keep the notification until manually dismissed. Overrides autoClose. */
	sticky?: boolean;
	source?: string;
	extra?: Record<string, unknown>;
}

export interface NotificationItem {
	id: string;
	title?: string;
	message: string;
	level: NotificationLevel;
	actions?: NotificationAction[];
	toast: boolean;
	createdAt: number;
	read: boolean;
	dismissed: boolean;
	sticky?: boolean;
	source?: string;
	extra?: Record<string, unknown>;
	autoClose?: number;
}

const DEFAULT_AUTO_CLOSE = 5000;

function generateNotificationId(): string {
	return `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const notificationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string) {
	const timer = notificationTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		notificationTimers.delete(id);
	}
}

const { subscribe, update, set } = writable<NotificationItem[]>([]);

function scheduleAutoClose(item: NotificationItem) {
	if (!browser) return;
	const timeout = item.sticky ? 0 : item.autoClose ?? DEFAULT_AUTO_CLOSE;
	if (!timeout || timeout <= 0) return;

	clearTimer(item.id);

	const timer = setTimeout(() => {
		notificationStore.dismiss(item.id);
	}, timeout);
	notificationTimers.set(item.id, timer);
}

export const notificationStore = {
	subscribe,

		notify(options: NotificationOptions): string {
		const id = options.id ?? generateNotificationId();
		const {
			title,
			message,
			level = 'info',
			actions,
			source,
			extra,
			toast = true,
			autoClose,
			sticky
		} = options;

		const item: NotificationItem = {
			id,
			title,
			message,
			level,
			actions,
			source,
			extra,
			toast,
			createdAt: Date.now(),
			read: false,
			dismissed: false,
			sticky,
			autoClose: sticky ? undefined : autoClose,
		};

		clearTimer(id);
		update((items) => {
			const filtered = items.filter((existing) => existing.id !== id);
			return [item, ...filtered];
		});
		scheduleAutoClose({ ...item, autoClose: sticky ? undefined : autoClose });
		return id;
	},

	markRead(id: string) {
		update((items) =>
			items.map((item) =>
				item.id === id
					? {
						...item,
						read: true,
					}
					: item
			)
		);
	},

	markAllRead() {
		update((items) => items.map((item) => ({ ...item, read: true })));
	},

	dismiss(id: string) {
		clearTimer(id);
		update((items) =>
			items.map((item) =>
				item.id === id
					? {
						...item,
						read: true,
						dismissed: true,
					}
					: item
			)
		);
	},

	remove(id: string) {
		clearTimer(id);
		update((items) => items.filter((item) => item.id !== id));
	},

	clear() {
		notificationTimers.forEach((timer) => clearTimeout(timer));
		notificationTimers.clear();
		set([]);
	},

	getSnapshot(): NotificationItem[] {
		return get({ subscribe });
	},
};

export const unreadNotificationCount = derived(notificationStore, ($notifications) =>
	$notifications.filter((item) => !item.read).length
);

export const hasUnreadNotifications = derived(unreadNotificationCount, ($count) => $count > 0);

export const activeToastNotifications = derived(notificationStore, ($notifications) =>
	$notifications.filter((item) => item.toast && !item.dismissed)
);
