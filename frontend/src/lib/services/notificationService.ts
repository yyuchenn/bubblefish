import { notificationStore, type NotificationAction, type NotificationLevel } from '$lib/stores/notificationStore';
import { eventService } from './eventService';
import type { BusinessEvent } from '$lib/core/events';

interface NotificationEventPayload {
	id?: string;
	title?: string;
	message?: string;
	level?: string;
	toast?: boolean;
	sticky?: boolean;
	autoClose?: number;
	auto_close?: number;
	source?: string;
	actions?: Array<Partial<NotificationAction>>;
	extra?: Record<string, unknown>;
}

const LEVELS = new Set<NotificationLevel>(['info', 'success', 'warning', 'error']);

function coerceLevel(value: unknown): NotificationLevel {
	if (typeof value === 'string') {
		const lower = value.toLowerCase() as NotificationLevel;
		if (LEVELS.has(lower)) {
			return lower;
		}
	}
	return 'info';
}

function normalizeActions(actions: unknown): NotificationAction[] | undefined {
	if (!Array.isArray(actions)) return undefined;

	const normalized: NotificationAction[] = [];
	for (const item of actions) {
		if (!item || typeof item !== 'object') continue;
		const label = typeof (item as any).label === 'string' ? (item as any).label : null;
		if (!label) continue;
		const href = typeof (item as any).href === 'string' ? (item as any).href : undefined;
		normalized.push({ label, href });
	}

	return normalized.length > 0 ? normalized : undefined;
}

function coercePayload(data: unknown): NotificationEventPayload | null {
	if (!data || typeof data !== 'object') {
		return null;
	}
	return data as NotificationEventPayload;
}

class NotificationService {
	private unsubscribe: (() => void) | null = null;

	initialize(): void {
		if (this.unsubscribe) {
			return;
		}

		this.unsubscribe = eventService.onBusinessEvent((event: BusinessEvent) => {
			if (event.event_name === 'ui:notification') {
				const payload = coercePayload(event.data);
				if (!payload || typeof payload.message !== 'string') {
					return;
				}

				notificationStore.notify({
					id: typeof payload.id === 'string' ? payload.id : undefined,
					title: typeof payload.title === 'string' ? payload.title : undefined,
					message: payload.message,
					level: coerceLevel(payload.level),
					toast: payload.toast !== undefined ? Boolean(payload.toast) : true,
					sticky: payload.sticky === true,
					autoClose:
						typeof payload.autoClose === 'number'
							? payload.autoClose
							: typeof payload.auto_close === 'number'
								? payload.auto_close
								: undefined,
					source: typeof payload.source === 'string' ? payload.source : undefined,
					actions: normalizeActions(payload.actions),
					extra: typeof payload.extra === 'object' && payload.extra !== null ? payload.extra : undefined,
				});
			} else if (event.event_name === 'ui:notification:clear') {
				notificationStore.clear();
			} else if (event.event_name === 'ui:notification:dismiss') {
				const payload = coercePayload(event.data);
				if (payload?.id) {
					notificationStore.dismiss(payload.id);
				}
			}
		});
	}

	destroy(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}
}

export const notificationService = new NotificationService();
