import { isTauri, tauriAPI } from '../core/tauri';
import type { Platform } from '../core/tauri';

/**
 * Platform Service - 封装平台相关功能
 * 为组件提供统一的接口，隔离对平台特定功能的直接访问
 */
export const platformService = {
	/**
	 * 检查是否运行在Tauri环境
	 */
	isTauri(): boolean {
		return isTauri();
	},

	/**
	 * 获取平台信息
	 */
	getPlatform(): Platform {
		return isTauri() ? tauriAPI.getPlatform() : 'web' as Platform;
	},

	/**
	 * 获取Tauri API实例
	 */
	getTauriAPI() {
		return tauriAPI;
	},

	/**
	 * 检查是否支持文件系统访问
	 */
	supportsFileSystem(): boolean {
		return isTauri();
	},

	/**
	 * 检查是否支持SharedArrayBuffer（用于WASM优化）
	 */
	supportsSharedArrayBuffer(): boolean {
		return typeof SharedArrayBuffer !== 'undefined';
	},

	/**
	 * 获取环境信息
	 */
	getEnvironmentInfo() {
		return {
			platform: this.getPlatform(),
			isTauri: this.isTauri(),
			supportsFileSystem: this.supportsFileSystem(),
			supportsSharedArrayBuffer: this.supportsSharedArrayBuffer(),
			isProduction: import.meta.env.PROD,
			isDevelopment: import.meta.env.DEV
		};
	},

	/**
	 * 更新原生菜单状态（仅 macOS）
	 */
	updateMenuCheckedState(menuId: string, checked: boolean): void {
		if (isTauri()) {
			tauriAPI.updateMenuCheckedState(menuId, checked);
		}
	},

	/**
	 * 更新原生菜单启用状态（仅 macOS）
	 */
	updateMenuEnabledState(menuId: string, enabled: boolean): void {
		if (isTauri()) {
			tauriAPI.updateMenuEnabledState(menuId, enabled);
		}
	},

	/**
	 * 更新原生菜单文本（仅 macOS）
	 */
	updateMenuText(menuId: string, text: string): void {
		if (isTauri()) {
			tauriAPI.updateMenuText(menuId, text);
		}
	},

	/**
	 * 打开项目文件对话框
	 */
	async openProjectFileDialog(): Promise<string | null> {
		if (isTauri()) {
			return tauriAPI.openProjectFileDialog();
		}
		return null;
	}
};