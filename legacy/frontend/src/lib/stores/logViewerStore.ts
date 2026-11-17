import { writable } from 'svelte/store';

// LogViewer显示状态的全局store
export const logViewerVisible = writable(false);

// 切换LogViewer显示状态的函数
export function toggleLogViewer() {
	logViewerVisible.update((visible) => !visible);
}
