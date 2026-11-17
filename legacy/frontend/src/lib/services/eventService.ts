import { eventSystem, type LogEvent, type BusinessEvent, type LogEventHandler, type BusinessEventHandler, type LogLevel } from '../core/events';

/**
 * Event Service - 封装事件系统
 * 为组件提供统一的事件订阅和发布接口，隔离对core层事件系统的直接访问
 */
class EventService {
	private initialized = false;

	/**
	 * 初始化事件系统
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}
		await eventSystem.initialize();
		this.initialized = true;
	}

	/**
	 * 订阅日志事件
	 * @returns 取消订阅的函数
	 */
	onLog(handler: LogEventHandler): () => void {
		return eventSystem.onLog(handler);
	}

	/**
	 * 订阅业务事件
	 * @returns 取消订阅的函数
	 */
	onBusinessEvent(handler: BusinessEventHandler): () => void {
		return eventSystem.addBusinessEventHandler(handler);
	}

	/**
	 * 发送日志事件
	 */
	log(level: LogLevel['level'], message: string, data?: unknown): void {
		eventSystem.emitLogEvent(level, message, data);
	}

	/**
	 * 便捷日志方法
	 */
	debug(message: string, data?: unknown): void {
		this.log('Debug', message, data);
	}

	info(message: string, data?: unknown): void {
		this.log('Info', message, data);
	}

	warn(message: string, data?: unknown): void {
		this.log('Warn', message, data);
	}

	error(message: string, data?: unknown): void {
		this.log('Error', message, data);
	}

	/**
	 * 发送业务事件
	 */
	emitBusinessEvent(eventName: string, data: unknown): void {
		eventSystem.emitBusinessEvent(eventName, data);
	}

	/**
	 * 获取事件系统统计信息
	 */
	getStats(): { logHandlers: number; businessHandlers: number; isInitialized: boolean } {
		return eventSystem.getStats();
	}

	/**
	 * 清理所有事件处理器
	 */
	clear(): void {
		eventSystem.clear();
	}

	/**
	 * 销毁事件系统
	 */
	destroy(): void {
		eventSystem.destroy();
		this.initialized = false;
	}
}

// 创建单例实例
export const eventService = new EventService();

// 导出类型
export type { LogEvent, BusinessEvent, LogEventHandler, BusinessEventHandler, LogLevel };