// WASM Worker - 在独立线程中运行WASM core模块
import type { WasmModule } from '../core/adapter';

// Worker消息类型定义
export interface WasmWorkerMessage {
	id: number;
	method: string;
	args: unknown[];
}

export interface WasmWorkerResponse {
	id: number;
	result?: unknown;
	error?: string;
	success: boolean;
}

export interface WasmWorkerEvent {
	type: 'event';
	eventType: 'business' | 'log';
	eventName?: string;
	data: unknown;
}

let wasmModule: WasmModule | null = null;

// 定义全局函数供WASM调用（在Worker上下文中）
declare const self: DedicatedWorkerGlobalScope;

// 初始化WASM模块
async function initWasmInWorker(): Promise<boolean> {
	try {
		// 动态导入WASM模块
		const module = await import('../wasm-pkg/bubblefish_core.js');

		// 使用URL import导入WASM二进制文件
		const wasmUrl = new URL('../wasm-pkg/bubblefish_core_bg.wasm', import.meta.url);

		// 使用新格式调用初始化函数
		await module.default({ module_or_path: wasmUrl });

		wasmModule = module as unknown as WasmModule;

		// 初始化wasm-bindgen-rayon线程池
		try {
			if (module.initThreadPool) {
				const numThreads = navigator.hardwareConcurrency || 4;
				await module.initThreadPool(numThreads);
			}
		} catch (error) {
			console.warn('Failed to initialize WASM thread pool in worker:', error);
		}

		// 初始化WASM的事件系统
		if (module.wasm_init_event_system) {
			module.wasm_init_event_system();
		}

		// 设置事件回调 - 转发事件到主线程
		if (module.wasm_set_event_callback) {
			module.wasm_set_event_callback((eventName: string, eventData: unknown) => {
				// 检查是否是日志事件
				if (eventName === 'core-log') {
					// 添加时间戳（如果没有的话）
					const data = eventData as any;
					if (!data.timestamp) {
						data.timestamp = Date.now();
					}
					const event: WasmWorkerEvent = {
						type: 'event',
						eventType: 'log',
						data: data
					};
					self.postMessage(event);
				} else {
					// 处理业务事件
					const event: WasmWorkerEvent = {
						type: 'event',
						eventType: 'business',
						eventName,
						data: eventData
					};
					self.postMessage(event);
				}
			});
		}

		// 启动事件轮询（处理来自Rayon线程的事件）
		if (module.wasm_poll_events) {
			setInterval(() => {
				const events = module.wasm_poll_events();
				if (events && Array.isArray(events)) {
					events.forEach((eventData: unknown) => {
						// 处理 Map 对象
						let eventName: string | undefined;
						let eventPayload: unknown;
						
						if (eventData instanceof Map) {
							// 从 Map 中提取数据
							eventName = eventData.get('event_name');
							eventPayload = eventData.get('event_data');
							
							// 如果 event_data 也是 Map，转换为普通对象
							if (eventPayload instanceof Map) {
								const obj: Record<string, unknown> = {};
								eventPayload.forEach((value: unknown, key: string) => {
									obj[key] = value;
								});
								eventPayload = obj;
							}
						} else if (eventData && typeof eventData === 'object') {
							// 普通对象
							const data = eventData as any;
							eventName = data.event_name;
							eventPayload = data.event_data;
						}
						
						if (eventName && eventPayload) {
							// 检查是否是日志事件
							if (eventName === 'core-log') {
								// 处理日志事件 - eventPayload 已经是正确的格式
								// 添加时间戳（如果没有的话）
								const payload = eventPayload as any;
								if (!payload.timestamp) {
									payload.timestamp = Date.now();
								}
								const event: WasmWorkerEvent = {
									type: 'event',
									eventType: 'log',
									data: payload
								};
								self.postMessage(event);
							} else {
								// 处理业务事件
								const event: WasmWorkerEvent = {
									type: 'event',
									eventType: 'business',
									eventName: eventName,
									data: eventPayload
								};
								self.postMessage(event);
							}
						}
					});
				}
			}, 100); // 每100ms轮询一次
		}

		return true;
	} catch (error) {
		console.error('Failed to initialize WASM module in worker:', error);
		throw error;
	}
}

// 调用WASM方法
async function callWasmMethod(method: string, args: unknown[]): Promise<unknown> {
	if (!wasmModule) {
		throw new Error('WASM module not initialized');
	}

	const wasmFunction = (wasmModule as any)[method];
	if (typeof wasmFunction !== 'function') {
		throw new Error(`WASM method '${method}' not found`);
	}

	return wasmFunction.apply(wasmModule, args);
}

// Worker消息处理
self.onmessage = async (event: MessageEvent<WasmWorkerMessage>) => {
	const { id, method, args } = event.data;

	try {
		// 特殊处理初始化请求
		if (method === '__init__') {
			await initWasmInWorker();
			const response: WasmWorkerResponse = {
				id,
				result: true,
				success: true
			};
			self.postMessage(response);
			return;
		}

		// 确保WASM已初始化
		if (!wasmModule) {
			throw new Error('WASM module not initialized. Call __init__ first.');
		}

		// 调用WASM方法
		const result = await callWasmMethod(method, args);

		const response: WasmWorkerResponse = {
			id,
			result,
			success: true
		};
		self.postMessage(response);

	} catch (error) {
		const response: WasmWorkerResponse = {
			id,
			error: error instanceof Error ? error.message : String(error),
			success: false
		};
		self.postMessage(response);
	}
};

// Worker错误处理
self.onerror = (event: string | Event): boolean => {
	console.error('Worker error:', event);
	return true;
};

self.onunhandledrejection = (event: PromiseRejectionEvent) => {
	console.error('Worker unhandled rejection:', event.reason);
};