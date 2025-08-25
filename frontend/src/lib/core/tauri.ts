import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';

// 定义平台类型
export type Platform = 'macos' | 'windows' | 'linux' | 'unknown';

export interface TauriAPI {
	openFileDialog(): Promise<string | null>;
	openProjectFileDialog(): Promise<string | null>;
	saveTextFile(content: string, fileName: string): Promise<string>;
	readFileContent(filePath: string): Promise<string>;
	getAppInfo(): Promise<string>;
	// 新增操作系统相关方法
	getPlatform(): Platform;
	// 更新菜单项选中状态
	updateMenuCheckedState(menuId: string, checked: boolean): Promise<void>;
	// 更新菜单项启用状态
	updateMenuEnabledState(menuId: string, enabled: boolean): Promise<void>;
	// 更新菜单项文本
	updateMenuText(menuId: string, text: string): Promise<void>;
}

export const tauriAPI: TauriAPI = {
	async openFileDialog(): Promise<string | null> {
		try {
			const result = await invoke<string | null>('open_file_dialog');
			return result;
		} catch (error) {
			console.error('Failed to open file dialog:', error);
			return null;
		}
	},

	async openProjectFileDialog(): Promise<string | null> {
		try {
			// 使用Tauri的文件对话框API
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				multiple: false,
				filters: [{
					name: 'Project Files',
					extensions: ['bf', 'txt', 'lp']
				}]
			});
			return selected as string | null;
		} catch (error) {
			console.error('Failed to open project file dialog:', error);
			return null;
		}
	},

	async saveTextFile(content: string, fileName: string): Promise<string> {
		try {
			const result = await invoke<string>('save_text_file', { content, fileName });
			return result;
		} catch (error) {
			console.error('Failed to save file:', error);
			throw error;
		}
	},

	async readFileContent(filePath: string): Promise<string> {
		try {
			const result = await invoke<string>('read_file_content', { filePath });
			return result;
		} catch (error) {
			console.error('Failed to read file content:', error);
			throw error;
		}
	},

	async getAppInfo(): Promise<string> {
		try {
			const result = await invoke<string>('get_app_info');
			return result;
		} catch (error) {
			console.error('Failed to get app info:', error);
			return 'Bubblefish Desktop App';
		}
	},

	// 使用 Tauri OS 插件检测操作系统
	getPlatform(): Platform {
		try {
			// 检查是否在 Tauri 环境中
			if (!isTauri()) {
				// 在 web 环境中使用 navigator.platform 作为后备
				if (typeof window !== 'undefined' && window.navigator) {
					const userAgent = window.navigator.userAgent.toLowerCase();
					if (userAgent.includes('mac')) return 'macos';
					if (userAgent.includes('win')) return 'windows';
					if (userAgent.includes('linux')) return 'linux';
				}
				return 'unknown';
			}

			const tauriPlatform = platform();

			// 映射 Tauri 平台值到我们的类型
			switch (tauriPlatform) {
				case 'macos':
					return 'macos';
				case 'windows':
					return 'windows';
				case 'linux':
					return 'linux';
				default:
					return 'unknown';
			}
		} catch (error) {
			console.error('Failed to get platform:', error);
			return 'unknown';
		}
	},

	async updateMenuCheckedState(menuId: string, checked: boolean): Promise<void> {
		try {
			if (!isTauri()) return;
			await invoke('update_menu_checked_state', { menuId, checked });
		} catch (error) {
			console.error('Failed to update menu checked state:', error);
		}
	},
	async updateMenuEnabledState(menuId: string, enabled: boolean): Promise<void> {
		try {
			if (!isTauri()) return;
			await invoke('update_menu_enabled_state', { menuId, enabled });
		} catch (error) {
			console.error('Failed to update menu enabled state:', error);
		}
	},
	
	async updateMenuText(menuId: string, text: string): Promise<void> {
		try {
			if (!isTauri()) return;
			await invoke('update_menu_text', { menuId, text });
		} catch (error) {
			console.error('Failed to update menu text:', error);
		}
	}
};

// 检测是否在Tauri环境中运行
export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}