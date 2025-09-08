import { modalStore } from '../stores/modalStore';
import { platformService } from './platformService';

export interface RecentProject {
	path: string;
	name: string;
	timestamp: number;
	type: 'bf' | 'labelplus';
}

const STORAGE_KEY = 'recentProjects';
const MAX_RECENT_PROJECTS = 5;

export const recentProjectsService = {
	// 获取最近打开的项目列表
	getRecentProjects(): RecentProject[] {
		if (typeof localStorage === 'undefined') return [];
		
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return [];
			
			const projects = JSON.parse(stored) as RecentProject[];
			// 按时间戳降序排序
			return projects.sort((a, b) => b.timestamp - a.timestamp);
		} catch (error) {
			console.error('Failed to load recent projects:', error);
			return [];
		}
	},

	// 添加项目到最近打开列表
	addRecentProject(path: string, type: 'bf' | 'labelplus' = 'bf') {
		if (typeof localStorage === 'undefined') return;
		if (!path) return;
		
		try {
			let projects = this.getRecentProjects();
			
			// 移除已存在的相同路径
			projects = projects.filter(p => p.path !== path);
			
			// 提取项目名称（保留扩展名）
			const pathParts = path.replace(/\\/g, '/').split('/');
			const fileName = pathParts[pathParts.length - 1];
			const name = fileName;
			
			// 添加新项目到开头
			projects.unshift({
				path,
				name,
				timestamp: Date.now(),
				type
			});
			
			// 限制数量
			projects = projects.slice(0, MAX_RECENT_PROJECTS);
			
			// 保存到 localStorage
			localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
			
			// 触发自定义事件，通知其他组件更新
			window.dispatchEvent(new CustomEvent('recent-projects-updated'));
			
			// 如果在 Tauri 环境，同步到后端
			if (platformService.isTauri()) {
				this.syncToBackend();
			}
		} catch (error) {
			console.error('Failed to add recent project:', error);
		}
	},

	// 清空最近打开列表
	clearRecentProjects() {
		if (typeof localStorage === 'undefined') return;
		
		try {
			localStorage.removeItem(STORAGE_KEY);
			
			// 触发自定义事件，通知其他组件更新
			window.dispatchEvent(new CustomEvent('recent-projects-updated'));
			
			// 如果在 Tauri 环境，同步到后端
			if (platformService.isTauri()) {
				this.syncToBackend();
			}
		} catch (error) {
			console.error('Failed to clear recent projects:', error);
		}
	},

	// 打开最近的项目
	async openRecentProject(path: string) {
		// 先验证文件是否存在
		const exists = await this.validateProjectPath(path);
		
		if (!exists) {
			// 文件不存在，显示错误提示
			modalStore.showModal('openProject', {
				errorMessage: `项目文件不存在或已被移动：\n${path}`
			});
			return;
		}
		
		// 文件存在，正常打开
		modalStore.showModal('openProject', {
			initialFilePath: path,
			autoProcess: true
		});
	},

	// 验证文件路径是否存在
	async validateProjectPath(path: string): Promise<boolean> {
		if (!platformService.isTauri()) {
			// Web 环境无法验证文件
			return true;
		}
		
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const exists = await invoke<boolean>('check_file_exists', { path });
			return exists;
		} catch (error) {
			console.error('Failed to validate file path:', error);
			return false;
		}
	},

	// 同步最近打开列表到后端（用于更新 macOS 原生菜单）
	async syncToBackend() {
		if (!platformService.isTauri()) return;
		
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const projects = this.getRecentProjects();
			await invoke('update_recent_projects_menu', { projects });
		} catch (error) {
			console.error('Failed to sync recent projects to backend:', error);
		}
	},

	// 从路径中提取项目类型
	getProjectType(path: string): 'bf' | 'labelplus' {
		const lowerPath = path.toLowerCase();
		if (lowerPath.endsWith('.lp') || lowerPath.endsWith('.labelplus') || lowerPath.endsWith('.txt')) {
			return 'labelplus';
		}
		return 'bf';
	}
};