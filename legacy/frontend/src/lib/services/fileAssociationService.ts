import { modalStore } from '../stores/modalStore';
import { platformService } from './platformService';
import { recentProjectsService } from './recentProjectsService';

export const fileAssociationService = {
	async init() {
		if (!platformService.isTauri()) return;
		
		try {
			const { listen, emit } = await import('@tauri-apps/api/event');
			
			// 监听文件打开事件（从命令行参数或文件关联打开）
			await listen<string>('open-file', async (event) => {
				const filePath = event.payload;
				console.log('Received open-file event:', filePath);
				
				if (filePath && filePath.endsWith('.bf')) {
					console.log('Opening project file:', filePath);
					// 记录到最近打开
					recentProjectsService.addRecentProject(filePath, 'bf');
					// 立即显示模态框，不需要延迟
					modalStore.showModal('openProject', {
						initialFilePath: filePath,
						autoProcess: true
					});
				}
			});
			
			// 通知后端前端已准备就绪
			await emit('frontend-ready');
			console.log('File association service initialized and frontend-ready signal sent');
		} catch (error) {
			console.error('Failed to initialize file association service:', error);
		}
	}
};