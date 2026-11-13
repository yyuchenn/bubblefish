import { get } from 'svelte/store';
import { projectStore } from '$lib/stores/projectStore';
import { imageStore } from '$lib/stores/imageStore';
import { imageService } from './imageService';
import { markerService } from './markerService';
import { coreAPI } from '$lib/core/adapter';
import type { UndoRedoResult } from '$lib/types';
import { eventSystem } from '$lib/core/events';
import { undoRedoStore, undoRedoActions } from '$lib/stores/undoRedoStore';
import type { BusinessEvent } from '$lib/core/events';

// Export read-only store subscription for components
export { undoRedoStore, undoRedoActions };

// Action name mapping from backend names to user-friendly Chinese names
const actionNameMap: Record<string, string> = {
    'UpdateMarkerTranslation': '编辑翻译',
    'AddMarker': '添加标记',
    'RemoveMarker': '删除标记',
    'UpdateMarkerStyle': '修改样式',
    'UpdateMarkerOrder': '调整顺序',
    'UpdatePointMarkerPosition': '移动标记',
    'UpdateRectangleGeometry': '调整矩形',
    'UpdateMarker': '更新标记',
    'ClearImageMarkers': '清空标记',
    'ConvertRectangleToPoint': '矩形转点',
    'ConvertPointToRectangle': '点转矩形',
    'AddImage': '添加图片',
    'RemoveImage': '删除图片',
    'ReorderImages': '重排图片',
    'UpdateImage': '更新图片',
    'UpdateProjectName': '重命名项目',
    'UpdateProjectLanguages': '更改语言设置'
};

export interface UndoRedoService {
    undo(): Promise<void>;
    redo(): Promise<void>;
    clearHistory(): Promise<void>;
    clearHistoryForProject(projectId: number): Promise<void>;
    clearAllHistory(): Promise<void>;
    initialize(): () => void;
    getUndoActionDisplayName(actionName: string | null): string | null;
    setBeforeUndoRedoCallback(callback: (() => Promise<void>) | null): void;
}

class UndoRedoServiceImpl implements UndoRedoService {
    private unsubscribeEventListener: (() => void) | null = null;
    private beforeUndoRedoCallback: (() => Promise<void>) | null = null;

    private getCurrentProjectId(): number | null {
        const state = get(projectStore);
        return state.currentProjectId;
    }

    initialize(): () => void {
        // Add business event handler for undo/redo state changes
        this.unsubscribeEventListener = eventSystem.addBusinessEventHandler((event: BusinessEvent) => {
            if (event.event_name === 'undo_redo_state_changed') {
                const data = event.data as {
                    project_id: number;
                    undo_action_name?: string;  // New field
                    can_undo?: boolean;  // Keep for backward compatibility
                    can_redo: boolean;
                    current_commit_id: string | null;
                };
                
                // Handle both new and old format for backward compatibility
                let undoActionName: string | null;
                if (data.undo_action_name !== undefined) {
                    // New format with action name
                    undoActionName = data.undo_action_name === 'none' ? null : data.undo_action_name;
                } else if (data.can_undo !== undefined) {
                    // Old format with boolean
                    undoActionName = data.can_undo ? 'unknown' : null;
                } else {
                    undoActionName = null;
                }
                
                // Update the store with the new state
                undoRedoActions.updateProjectState(
                    data.project_id,
                    undoActionName,
                    data.can_redo,
                    data.current_commit_id
                );
                
            }
        });

        // Return cleanup function
        return () => {
            if (this.unsubscribeEventListener) {
                this.unsubscribeEventListener();
                this.unsubscribeEventListener = null;
            }
        };
    }
    
    async undo(): Promise<void> {
        try {
            // 在执行撤销前，先执行回调（比如保存待处理的编辑）
            if (this.beforeUndoRedoCallback) {
                await this.beforeUndoRedoCallback();
            }
            
            const projectId = this.getCurrentProjectId();
            if (!projectId) {
                console.error('No project selected');
                return;
            }
            
            const result: UndoRedoResult = await coreAPI.undo(projectId);
            
            if (result.success) {
                await this.handleUndoRedoResult(result);
            }
        } catch (error) {
            console.error('Undo failed:', error);
            throw error;
        }
    }

    async redo(): Promise<void> {
        try {
            // 在执行重做前，先执行回调（比如保存待处理的编辑）
            if (this.beforeUndoRedoCallback) {
                await this.beforeUndoRedoCallback();
            }
            
            const projectId = this.getCurrentProjectId();
            if (!projectId) {
                console.error('No project selected');
                return;
            }
            
            const result: UndoRedoResult = await coreAPI.redo(projectId);
            
            if (result.success) {
                await this.handleUndoRedoResult(result);
            }
        } catch (error) {
            console.error('Redo failed:', error);
            throw error;
        }
    }


    async clearHistory(): Promise<void> {
        try {
            const projectId = this.getCurrentProjectId();
            if (!projectId) {
                console.error('No project selected');
                return;
            }
            await coreAPI.clearUndoRedoHistory(projectId);
        } catch (error) {
            console.error('Failed to clear undo/redo history:', error);
            throw error;
        }
    }
    
    async clearHistoryForProject(projectId: number): Promise<void> {
        try {
            await coreAPI.clearUndoRedoHistory(projectId);
        } catch (error) {
            console.error(`Failed to clear undo/redo history for project ${projectId}:`, error);
            throw error;
        }
    }
    
    async clearAllHistory(): Promise<void> {
        try {
            await coreAPI.clearAllUndoRedoHistory();
        } catch (error) {
            console.error('Failed to clear all undo/redo history:', error);
            throw error;
        }
    }

    private async handleUndoRedoResult(result: UndoRedoResult): Promise<void> {
        const currentImageId = get(imageStore).currentImageId;
        
        // Refresh data based on what was affected
        if (result.image_id !== null && result.image_id !== undefined) {
            // If we're not on the affected image, navigate to it
            if (currentImageId !== result.image_id) {
                // 使用 imageService.setCurrentImage 来切换图片
                // 这会自动加载markers、重置transform等
                await imageService.setCurrentImage(result.image_id);
            } else {
                // 如果已经在当前图片，只需要刷新markers
                await markerService.loadImageMarkers(result.image_id);
            }
            
            // 如果有受影响的marker，选中它
            if (result.marker_id !== null && result.marker_id !== undefined) {
                markerService.setSelectedMarker(result.marker_id);
            }
        }
    }
    
    getUndoActionDisplayName(actionName: string | null): string | null {
        if (!actionName || actionName === 'none') {
            return null;
        }
        
        // Return the mapped Chinese name, or the original name if not found
        return actionNameMap[actionName] || actionName;
    }
    
    setBeforeUndoRedoCallback(callback: (() => Promise<void>) | null): void {
        this.beforeUndoRedoCallback = callback;
    }
}

export const undoRedoService = new UndoRedoServiceImpl();