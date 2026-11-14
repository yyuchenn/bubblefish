import { platformService } from './platformService';
import { recentProjectsService } from './recentProjectsService';

// 处理 macOS 原生菜单的最近打开功能
export const recentMenuService = {
	async init() {
		if (!platformService.isTauri()) return;
		if (platformService.getPlatform() !== 'macos') return;
		
		try {
			const { listen } = await import('@tauri-apps/api/event');
			
			// 监听清空最近打开
			await listen('menu:file:clear-recent', async () => {
				console.log('Clearing recent projects from menu');
				recentProjectsService.clearRecentProjects();
			});
			
			// 监听打开最近项目
			await listen<string>('menu:file:open-recent', async (event) => {
				const eventId = event.payload;
				console.log('Opening recent project from menu:', eventId);
				
				// 从 ID 提取索引 (recent-0, recent-1, etc.)
				const match = eventId.match(/recent-(\d+)/);
				if (match) {
					const index = parseInt(match[1], 10);
					const projects = recentProjectsService.getRecentProjects();
					if (projects[index]) {
						await recentProjectsService.openRecentProject(projects[index].path);
					}
				}
			});
			
			// 监听 open-recent-file 事件（从后端直接发送的）
			await listen<string>('open-recent-file', async (event) => {
				const filePath = event.payload;
				console.log('Opening recent file:', filePath);
				await recentProjectsService.openRecentProject(filePath);
			});
			
			// 初始化时同步最近打开列表到 macOS 菜单
			await recentProjectsService.syncToBackend();
			
			console.log('Recent menu service initialized for macOS');
		} catch (error) {
			console.error('Failed to initialize recent menu service:', error);
		}
	}
};