import { coreAPI } from '../core/adapter';
import { get } from 'svelte/store';
import { markerStore } from '../stores/markerStore';
import { projectStore } from '../stores/projectStore';
import { imageStore } from '../stores/imageStore';

export interface ServiceCallRequest {
    pluginId: string;
    service: string;
    method: string;
    params: any;
}

export interface PluginMessage {
    from: string;
    to: string;
    message: any;
}

/**
 * 插件桥接层 - 处理插件与Core模块的通信
 */
class PluginBridge {
    private serviceHandlers: Map<string, (method: string, params: any) => Promise<any>>;
    private pluginMessageHandlers: Map<string, (message: PluginMessage) => void>;
    private eventListeners: Map<string, Set<(event: any) => void>>;

    constructor() {
        this.serviceHandlers = new Map();
        this.pluginMessageHandlers = new Map();
        this.eventListeners = new Map();
        
        this.initializeServiceHandlers();
        this.setupEventForwarding();
    }

    /**
     * 初始化服务处理器
     */
    private initializeServiceHandlers() {
        // Markers服务
        this.serviceHandlers.set('markers', async (method: string, params: any) => {
            switch (method) {
                case 'get_all_markers': {
                    const markers = get(markerStore).markers;
                    return markers;
                }
                
                case 'get_marker': {
                    const markers = get(markerStore).markers;
                    const marker = markers.find(m => m.id === params.marker_id);
                    return marker || null;
                }
                
                case 'create_marker': {
                    const { data } = params;
                    const markerId = await coreAPI.addPointMarkerToImage(
                        data.image_id,
                        data.x,
                        data.y,
                        data.translation
                    );
                    
                    if (markerId) {
                        const markers = await coreAPI.getImageMarkers(data.image_id);
                        const newMarker = markers.find(m => m.id === markerId);
                        return newMarker;
                    }
                    throw new Error('Failed to create marker');
                }
                
                case 'update_marker': {
                    const { marker_id, data } = params;
                    // Update marker translation if provided
                    if (data.translation !== undefined) {
                        await coreAPI.updateMarkerTranslation(marker_id, data.translation);
                    }
                    // Update marker style if provided
                    if (data.style) {
                        await coreAPI.updateMarkerStyle(marker_id, data.style.overlayText, data.style.horizontal);
                    }
                    return { success: true };
                }
                
                case 'delete_marker': {
                    const { marker_id, image_id } = params;
                    // Need image_id to delete marker
                    if (!image_id) {
                        // Find the image_id from marker store
                        const markers = get(markerStore).markers;
                        const marker = markers.find(m => m.id === marker_id);
                        if (!marker) {
                            throw new Error('Marker not found');
                        }
                        await coreAPI.removeMarkerFromImage(marker.imageId, marker_id);
                    } else {
                        await coreAPI.removeMarkerFromImage(image_id, marker_id);
                    }
                    return { success: true };
                }
                
                default:
                    throw new Error(`Unknown markers method: ${method}`);
            }
        });

        // Project服务
        this.serviceHandlers.set('project', async (method: string, params: any) => {
            switch (method) {
                case 'get_current': {
                    const state = get(projectStore);
                    const projectId = state.currentProjectId;
                    if (!projectId) return null;
                    const project = state.projects.find(p => p.id === projectId);
                    if (!project) return null;
                    // Get full project info from core
                    const fullProject = await coreAPI.getProjectInfo(projectId);
                    if (!fullProject) return null;
                    return {
                        id: fullProject.id,
                        name: fullProject.name,
                        image_ids: [], // Will be fetched separately if needed
                        file_path: null,
                        source_language: fullProject.sourceLanguage || 'japanese',
                        target_language: fullProject.targetLanguage || 'simplifiedChinese'
                    };
                }
                
                case 'create_project': {
                    const { data } = params;
                    // Create an empty opening project first
                    const projectId = await coreAPI.createEmptyOpeningProject(data.name || 'New Project');
                    if (projectId) {
                        // Finalize it to make it a regular project
                        await coreAPI.finalizeOpeningProject(projectId);
                        const project = await coreAPI.getProjectInfo(projectId);
                        if (project) {
                            projectStore.addProject(project);
                            projectStore.setCurrentProject(projectId, project.name);
                        }
                        return project;
                    }
                    return null;
                }
                
                case 'save_project': {
                    const state = get(projectStore);
                    const projectId = state.currentProjectId;
                    if (!projectId) throw new Error('No current project');
                    await coreAPI.saveProject(projectId);
                    return { success: true };
                }
                
                case 'close_project': {
                    projectStore.setCurrentProject(null, '');
                    return { success: true };
                }
                
                default:
                    throw new Error(`Unknown project method: ${method}`);
            }
        });

        // Images服务
        this.serviceHandlers.set('images', async (method: string, params: any) => {
            switch (method) {
                case 'get_all_images': {
                    const images = get(imageStore).images;
                    return images;
                }
                
                case 'get_image': {
                    const images = get(imageStore).images;
                    const image = images.find(i => i.id === params.image_id);
                    return image || null;
                }
                
                case 'add_image': {
                    const { data } = params;
                    // 这里需要实际的图片添加API
                    return { id: Date.now(), ...data };
                }
                
                default:
                    throw new Error(`Unknown images method: ${method}`);
            }
        });

        // Stats服务
        this.serviceHandlers.set('stats', async (method: string, params: any) => {
            switch (method) {
                case 'get_stats': {
                    const { project_id } = params;
                    const state = get(projectStore);
                    
                    // Accept 'current' as a special project_id
                    let actualProjectId = project_id === 'current' || !project_id 
                        ? state.currentProjectId 
                        : project_id;
                    
                    if (!actualProjectId) {
                        throw new Error('No project specified');
                    }
                    
                    const project = state.projects.find(p => p.id === actualProjectId);
                    if (!project) {
                        throw new Error('Project not found');
                    }
                    
                    const markers = get(markerStore).markers;
                    const images = get(imageStore).images;
                    
                    return {
                        total_images: images.length,
                        total_markers: markers.length,
                        translated_markers: markers.filter(m => m.translation && m.translation.length > 0).length,
                        untranslated_markers: markers.filter(m => !m.translation || m.translation.length === 0).length,
                    };
                }
                
                default:
                    throw new Error(`Unknown stats method: ${method}`);
            }
        });
    }

    /**
     * 设置事件转发
     */
    private setupEventForwarding() {
        // Track previous marker selection to detect changes
        let previousSelectedMarkerId: number | null = null;
        
        // 监听Store变化并转换为Core事件
        markerStore.subscribe((state) => {
            // 检测选择状态变化
            if (state.selectedMarkerId !== previousSelectedMarkerId) {
                // 如果之前有选中的marker，发送取消选中事件
                if (previousSelectedMarkerId !== null && state.selectedMarkerId === null) {
                    this.dispatchToPlugins({
                        type: 'MarkerDeselected',
                        marker_id: previousSelectedMarkerId
                    });
                }
                
                // 如果有新选中的marker，发送选中事件
                if (state.selectedMarkerId !== null) {
                    const marker = state.markers.find(m => m.id === state.selectedMarkerId);
                    const event = {
                        type: 'MarkerSelected',
                        marker_id: state.selectedMarkerId,
                        marker: marker || null
                    };
                    this.dispatchToPlugins(event);
                }
                
                previousSelectedMarkerId = state.selectedMarkerId;
            }
        });

        projectStore.subscribe((state) => {
            if (state.currentProjectId) {
                const project = state.projects.find(p => p.id === state.currentProjectId);
                if (project) {
                    this.dispatchToPlugins({
                        type: 'ProjectOpened',
                        project
                    });
                }
            }
        });

        imageStore.subscribe((state) => {
            if (state.currentImageId !== null) {
                const image = state.images.find(i => i.id === state.currentImageId);
                this.dispatchToPlugins({
                    type: 'ImageSelected',
                    image_id: state.currentImageId,
                    image: image || null
                });
            }
        });

        // 监听系统事件
        if (typeof window !== 'undefined') {
            window.addEventListener('system-ready', () => {
                this.dispatchToPlugins({ type: 'SystemReady' });
            });
        }
    }

    /**
     * 处理插件的Service调用请求
     */
    async handleServiceCall(request: ServiceCallRequest): Promise<any> {
        const handler = this.serviceHandlers.get(request.service);
        
        if (!handler) {
            throw new Error(`Service '${request.service}' not found`);
        }

        try {
            console.log(`[PluginBridge] Handling service call: ${request.service}.${request.method}`);
            const result = await handler(request.method, request.params);
            return result;
        } catch (error) {
            console.error(`[PluginBridge] Service call error:`, error);
            throw error;
        }
    }

    /**
     * 处理插件间消息
     */
    handlePluginMessage(message: PluginMessage) {
        const handler = this.pluginMessageHandlers.get(message.to);
        if (handler) {
            handler(message);
        } else {
            console.warn(`[PluginBridge] No handler for plugin: ${message.to}`);
        }
    }

    /**
     * 注册插件消息处理器
     */
    registerPluginMessageHandler(pluginId: string, handler: (message: PluginMessage) => void) {
        this.pluginMessageHandlers.set(pluginId, handler);
    }

    /**
     * 注销插件消息处理器
     */
    unregisterPluginMessageHandler(pluginId: string) {
        this.pluginMessageHandlers.delete(pluginId);
    }

    /**
     * 订阅事件
     */
    subscribeToEvent(eventType: string, handler: (event: any) => void) {
        if (!this.eventListeners.has(eventType)) {
            this.eventListeners.set(eventType, new Set());
        }
        this.eventListeners.get(eventType)?.add(handler);
    }

    /**
     * 分发事件给插件
     */
    private dispatchToPlugins(event: any) {
        const handlers = this.eventListeners.get(event.type) || new Set();
        const allHandlers = this.eventListeners.get('*') || new Set();
        
        [...handlers, ...allHandlers].forEach(handler => {
            try {
                handler(event);
            } catch (error) {
                console.error(`[PluginBridge] Event handler error:`, error);
            }
        });
    }

    /**
     * 获取当前权限
     */
    getAvailablePermissions(): string[] {
        return [
            'ServiceAccess:markers:*',
            'ServiceAccess:project:*',
            'ServiceAccess:images:*',
            'ServiceAccess:stats:*',
            'EventSubscribeAll',
            'DataFullAccess',
            'PluginCommunication',
        ];
    }
}

export const pluginBridge = new PluginBridge();