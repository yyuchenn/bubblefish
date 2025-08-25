/**
 * 进度管理服务
 * 管理长时间运行任务的进度显示，自动在超过1秒时显示进度条
 */

import { writable, derived, get } from 'svelte/store';

export interface ProgressState {
	id: string;
	title: string;
	subtitle?: string;
	progress: number; // 0-100
	startTime: number;
	canCancel: boolean;
	visible: boolean;
	cancelled: boolean;
}

export interface ProgressUpdateData {
	progress?: number;
	title?: string;
	subtitle?: string;
}

class ProgressManager {
	private progressStates = writable<Map<string, ProgressState>>(new Map());
	private visibilityTimers = new Map<string, number>();

	// 当前活跃的进度状态（用于UI显示）
	public activeProgress = derived(this.progressStates, ($states) => {
		// 返回最新创建的可见进度状态
		const visibleStates = Array.from($states.values()).filter((state) => state.visible);
		return visibleStates.length > 0 ? visibleStates[visibleStates.length - 1] : null;
	});

	/**
	 * 开始一个新的进度跟踪
	 */
	start(options: {
		id: string;
		title: string;
		subtitle?: string;
		canCancel?: boolean;
	}): ProgressController {
		const { id, title, subtitle, canCancel = false } = options;

		const progressState: ProgressState = {
			id,
			title,
			subtitle,
			progress: 0,
			startTime: Date.now(),
			canCancel,
			visible: false,
			cancelled: false
		};

		// 添加到状态管理
		this.progressStates.update((states) => {
			const newStates = new Map(states);
			newStates.set(id, progressState);
			return newStates;
		});

		// 设置1秒后显示进度条的定时器
		const timer = window.setTimeout(() => {
			this.makeVisible(id);
		}, 1000);

		this.visibilityTimers.set(id, timer);

		return new ProgressController(id, this);
	}

	/**
	 * 更新进度
	 */
	update(id: string, data: ProgressUpdateData): void {
		const states = get(this.progressStates);
		const currentState = states.get(id);

		if (!currentState || currentState.cancelled) return;

		const updatedState: ProgressState = {
			...currentState,
			...data
		};

		this.progressStates.update((states) => {
			const newStates = new Map(states);
			newStates.set(id, updatedState);
			return newStates;
		});
	}

	/**
	 * 完成进度
	 */
	complete(id: string): void {
		// 清除定时器
		const timer = this.visibilityTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.visibilityTimers.delete(id);
		}

		// 如果进度条可见，设置为100%并延迟隐藏
		const states = get(this.progressStates);
		const currentState = states.get(id);

		if (currentState?.visible) {
			this.update(id, { progress: 100 });

			// 延迟500ms后隐藏，让用户看到完成状态
			setTimeout(() => {
				this.remove(id);
			}, 500);
		} else {
			// 如果还未显示，直接移除
			this.remove(id);
		}
	}

	/**
	 * 取消进度
	 */
	cancel(id: string): void {
		const states = get(this.progressStates);
		const currentState = states.get(id);

		if (currentState) {
			this.progressStates.update((states) => {
				const newStates = new Map(states);
				newStates.set(id, { ...currentState, cancelled: true });
				return newStates;
			});
		}

		this.remove(id);
	}

	/**
	 * 强制显示进度条
	 */
	makeVisible(id: string): void {
		this.progressStates.update((states) => {
			const newStates = new Map(states);
			const currentState = newStates.get(id);
			if (currentState && !currentState.cancelled) {
				newStates.set(id, { ...currentState, visible: true });
			}
			return newStates;
		});
	}

	/**
	 * 移除进度状态
	 */
	private remove(id: string): void {
		// 清除定时器
		const timer = this.visibilityTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.visibilityTimers.delete(id);
		}

		// 移除状态
		this.progressStates.update((states) => {
			const newStates = new Map(states);
			newStates.delete(id);
			return newStates;
		});
	}

	/**
	 * 获取当前所有进度状态（调试用）
	 */
	getStates() {
		return get(this.progressStates);
	}
}

/**
 * 进度控制器
 * 提供更方便的API来控制单个进度实例
 */
export class ProgressController {
	constructor(
		private id: string,
		private manager: ProgressManager
	) {}

	/**
	 * 更新进度
	 */
	update(data: ProgressUpdateData): void {
		this.manager.update(this.id, data);
	}

	/**
	 * 设置进度百分比
	 */
	setProgress(progress: number): void {
		this.update({ progress });
	}

	/**
	 * 设置标题
	 */
	setTitle(title: string): void {
		this.update({ title });
	}

	/**
	 * 设置副标题
	 */
	setSubtitle(subtitle: string): void {
		this.update({ subtitle });
	}

	/**
	 * 完成进度
	 */
	complete(): void {
		this.manager.complete(this.id);
	}

	/**
	 * 取消进度
	 */
	cancel(): void {
		this.manager.cancel(this.id);
	}

	/**
	 * 强制显示进度条
	 */
	show(): void {
		this.manager.makeVisible(this.id);
	}
}

// 导出单例实例
export const progressManager = new ProgressManager();

/**
 * 便捷函数：包装异步操作并自动管理进度
 */
export async function withProgress<T>(
	options: {
		id: string;
		title: string;
		subtitle?: string;
		canCancel?: boolean;
		estimatedDuration?: number;
	},
	operation: (controller: ProgressController) => Promise<T>
): Promise<T> {
	const controller = progressManager.start(options);

	try {
		const result = await operation(controller);
		controller.complete();
		return result;
	} catch (error) {
		controller.cancel();
		throw error;
	}
}
