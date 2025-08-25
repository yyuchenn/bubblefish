import { isTauri } from './tauri';

export interface LogLevel {
	level: 'Debug' | 'Info' | 'Warn' | 'Error';
}

export interface LogEvent {
	level: LogLevel['level'];
	message: string;
	data?: unknown;
	timestamp: number;
	id?: string; // 可选的唯一标识符
}

export interface BusinessEvent {
	event_name: string;
	data: unknown;
	timestamp: number;
}

export interface Event {
	event_type: 'Log' | 'Business';
	event_name: string;
	data: {
		level?: LogLevel['level'];
		message?: string;
		data?: unknown;
		id?: string;
	} | unknown;
	timestamp: number;
}

export type LogEventHandler = (event: LogEvent) => void;
export type BusinessEventHandler = (event: BusinessEvent) => void;

class EventSystem {
	private logEventHandlers: LogEventHandler[] = [];
	private businessEventHandlers: BusinessEventHandler[] = [];
	private isInitialized = false;

	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		if (isTauri()) {
			// Tauri 环境中监听事件
			try {
				const { listen } = await import('@tauri-apps/api/event');
				
				// 监听日志事件
				await listen<Event>('core-log', (event) => {
					this.handleEvent(event.payload);
				});

				// 监听业务事件
				await listen<Event>('core-business', (event) => {
					this.handleEvent(event.payload);
				});

				console.log('Event system initialized for Tauri environment');
				
				// 发送测试日志以验证连接
				this.emitLogEvent('Info', 'Frontend event system initialized successfully');
			} catch (error) {
				console.error('Failed to initialize event system:', error);
			}
		} else {
			// Web 环境中监听DOM事件
			try {
				// 监听日志事件
				window.addEventListener('core-log', ((event: CustomEvent) => {
					const eventData = JSON.parse(event.detail);
					this.handleEvent(eventData);
				}) as EventListener);

				// 监听业务事件
				window.addEventListener('core-business', ((event: CustomEvent) => {
					const eventData = JSON.parse(event.detail);
					this.handleEvent(eventData);
				}) as EventListener);

				console.log('Event system initialized for web environment (DOM events)');
			} catch (error) {
				console.error('Failed to initialize web event system:', error);
			}
		}

		this.isInitialized = true;
	}

	private handleEvent(event: Event): void {
		if (event.event_type === 'Log') {
			const eventData = event.data as { level?: LogLevel['level']; message?: string; data?: unknown; id?: string };
			const logEvent: LogEvent = {
				level: eventData?.level || 'Info',
				message: eventData?.message || event.event_name,
				data: eventData?.data,
				timestamp: event.timestamp,
				id: eventData?.id
			};
			this.handleLogEvent(logEvent);
		} else if (event.event_type === 'Business') {
			const businessEvent: BusinessEvent = {
				event_name: event.event_name,
				data: event.data,
				timestamp: event.timestamp
			};
			this.handleBusinessEvent(businessEvent);
		}
	}

	handleLogEvent(event: LogEvent): void {
		this.logEventHandlers.forEach((handler) => {
			try {
				handler(event);
			} catch (error) {
				console.error('Error in log event handler:', error);
			}
		});
	}

	handleBusinessEvent(event: BusinessEvent): void {
		this.businessEventHandlers.forEach((handler) => {
			try {
				handler(event);
			} catch (error) {
				console.error('Error in business event handler:', error);
			}
		});
	}

	addLogEventHandler(handler: LogEventHandler): void {
		this.logEventHandlers.push(handler);
	}

	removeLogEventHandler(handler: LogEventHandler): void {
		const index = this.logEventHandlers.indexOf(handler);
		if (index > -1) {
			this.logEventHandlers.splice(index, 1);
		}
	}

	// Convenience method that returns an unsubscribe function
	onLog(handler: LogEventHandler): () => void {
		this.addLogEventHandler(handler);
		return () => this.removeLogEventHandler(handler);
	}

	addBusinessEventHandler(handler: BusinessEventHandler): () => void {
		this.businessEventHandlers.push(handler);
		return () => this.removeBusinessEventHandler(handler);
	}

	removeBusinessEventHandler(handler: BusinessEventHandler): void {
		const index = this.businessEventHandlers.indexOf(handler);
		if (index > -1) {
			this.businessEventHandlers.splice(index, 1);
		}
	}

	// 发送自定义日志事件（主要用于 WASM 环境）
	emitLogEvent(level: LogLevel['level'], message: string, data?: unknown): void {
		const logEvent: LogEvent = {
			level,
			message,
			data,
			timestamp: Date.now(),
			id: this.generateEventId()
		};
		this.handleLogEvent(logEvent);
	}

	// 发送自定义业务事件
	emitBusinessEvent(eventName: string, data: unknown): void {
		const businessEvent: BusinessEvent = {
			event_name: eventName,
			data,
			timestamp: Date.now()
		};
		this.handleBusinessEvent(businessEvent);
	}

	// 生成事件ID
	private generateEventId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
	}

	// 获取统计信息
	getStats(): { logHandlers: number; businessHandlers: number; isInitialized: boolean } {
		return {
			logHandlers: this.logEventHandlers.length,
			businessHandlers: this.businessEventHandlers.length,
			isInitialized: this.isInitialized
		};
	}

	// 清理所有事件处理器
	clear(): void {
		this.logEventHandlers.length = 0;
		this.businessEventHandlers.length = 0;
	}

	// 销毁事件系统
	destroy(): void {
		this.clear();
		this.isInitialized = false;
	}
}

// 创建单例实例
export const eventSystem = new EventSystem();