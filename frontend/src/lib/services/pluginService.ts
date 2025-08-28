import { writable, derived, get } from 'svelte/store';
import { pluginBridge } from './pluginBridge';

export interface PluginMetadata {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    required_permissions: string[];
    subscribed_events: string[];
}

export interface PluginInfo {
    metadata: PluginMetadata;
    enabled: boolean;
    loaded: boolean;
    worker?: Worker;
}

export interface CoreEvent {
    type: string;
    [key: string]: any;
}

const PLUGIN_STATE_KEY = 'bubblefish_plugin_state';

interface PluginState {
    pluginId: string;
    enabled: boolean;
}

class PluginService {
    private plugins = writable<Map<string, PluginInfo>>(new Map());
    private workers = new Map<string, Worker>();
    private serviceCallHandlers = new Map<Worker, Map<number, any>>();
    
    constructor() {
        this.initializeEventBridge();
        // Only restore state in browser environment
        if (typeof window !== 'undefined') {
            this.restorePluginState();
        }
    }

    private initializeEventBridge() {
        // Subscribe to all events from pluginBridge
        pluginBridge.subscribeToEvent('*', (event) => {
            this.dispatchEventToPlugins(event);
        });
    }

    private savePluginState() {
        // Only save state in browser environment
        if (typeof window === 'undefined') return;
        
        const plugins = get(this.plugins);
        const state: PluginState[] = [];
        
        plugins.forEach((plugin) => {
            state.push({
                pluginId: plugin.metadata.id,
                enabled: plugin.enabled
            });
        });
        
        localStorage.setItem(PLUGIN_STATE_KEY, JSON.stringify(state));
    }

    private async restorePluginState() {
        // Only restore state in browser environment
        if (typeof window === 'undefined') return;
        
        try {
            const savedState = localStorage.getItem(PLUGIN_STATE_KEY);
            if (!savedState) return;
            
            const state: PluginState[] = JSON.parse(savedState);
            console.log('[PluginService] Restoring plugin state:', state);
            
            for (const pluginState of state) {
                try {
                    // Try to load the plugin
                    await this.loadPlugin(pluginState.pluginId);
                    
                    // Set enabled state
                    if (!pluginState.enabled) {
                        this.disablePlugin(pluginState.pluginId);
                    }
                    
                    console.log(`[PluginService] Restored plugin ${pluginState.pluginId} (enabled: ${pluginState.enabled})`);
                } catch (error) {
                    console.warn(`[PluginService] Failed to restore plugin ${pluginState.pluginId}:`, error);
                    // Continue with other plugins even if one fails
                }
            }
        } catch (error) {
            console.error('[PluginService] Failed to restore plugin state:', error);
        }
    }

    async loadPlugin(pluginId: string, wasmUrl?: string, permissions?: string[]): Promise<void> {
        try {
            const url = wasmUrl || `/plugins/${pluginId}/pkg/${pluginId.replace(/-/g, '_')}_plugin.js`;
            
            // Get permissions from bridge if not provided
            const grantedPermissions = permissions || pluginBridge.getAvailablePermissions();
            
            // Create a worker for this plugin
            const worker = new Worker('/src/lib/workers/pluginWorker.ts', { type: 'module' });
            
            // Store worker reference
            this.workers.set(pluginId, worker);
            this.serviceCallHandlers.set(worker, new Map());
            
            // Initialize the plugin in the worker
            worker.postMessage({
                type: 'LOAD_PLUGIN',
                pluginId,
                wasmUrl: url,
                permissions: grantedPermissions
            });

            // Wait for plugin to load
            await new Promise<void>((resolve, reject) => {
                const handler = (event: MessageEvent) => {
                    if (event.data.type === 'PLUGIN_LOADED' && event.data.pluginId === pluginId) {
                        worker.removeEventListener('message', handler);
                        
                        const metadata = event.data.metadata;
                        const pluginInfo: PluginInfo = {
                            metadata,
                            enabled: true,
                            loaded: true,
                            worker
                        };
                        
                        this.plugins.update(plugins => {
                            plugins.set(pluginId, pluginInfo);
                            return plugins;
                        });
                        
                        // Save state after successfully loading
                        this.savePluginState();
                        
                        console.log(`[PluginService] Plugin ${pluginId} loaded successfully`);
                        console.log(`  Permissions: ${metadata.required_permissions}`);
                        console.log(`  Events: ${metadata.subscribed_events}`);
                        
                        resolve();
                    } else if (event.data.type === 'PLUGIN_ERROR' && event.data.pluginId === pluginId) {
                        worker.removeEventListener('message', handler);
                        reject(new Error(event.data.error));
                    }
                };
                worker.addEventListener('message', handler);
            });

            // Set up ongoing message handling
            worker.addEventListener('message', (event) => {
                this.handleWorkerMessage(pluginId, worker, event);
            });

        } catch (error) {
            console.error(`[PluginService] Failed to load plugin ${pluginId}:`, error);
            throw error;
        }
    }

    private handleWorkerMessage(pluginId: string, worker: Worker, event: MessageEvent) {
        const { type, ...data } = event.data;
        
        switch (type) {
            case 'SERVICE_CALL':
                this.handleServiceCall(worker, data);
                break;
                
            case 'PLUGIN_LOG':
                console.log(`[Plugin ${pluginId}]:`, data.message);
                break;
                
            case 'PLUGIN_MESSAGE':
                this.handlePluginMessage(data);
                break;
                
            default:
                // Already handled in load promise
                break;
        }
    }

    private async handleServiceCall(worker: Worker, data: any) {
        const { callId, pluginId, service, method, params } = data;
        
        try {
            const result = await pluginBridge.handleServiceCall({
                pluginId,
                service,
                method,
                params
            });
            
            worker.postMessage({
                type: 'SERVICE_CALL_RESPONSE',
                callId,
                result
            });
        } catch (error) {
            worker.postMessage({
                type: 'SERVICE_CALL_RESPONSE',
                callId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private handlePluginMessage(data: any) {
        const { from, to, message } = data;
        
        // Route message to target plugin
        const targetWorker = this.workers.get(to);
        if (targetWorker) {
            targetWorker.postMessage({
                type: 'PLUGIN_MESSAGE',
                from,
                to,
                message
            });
        } else {
            console.warn(`[EnhancedPluginService] Target plugin ${to} not found`);
        }
    }

    async unloadPlugin(pluginId: string): Promise<void> {
        const worker = this.workers.get(pluginId);
        
        if (worker) {
            worker.postMessage({ type: 'UNLOAD_PLUGIN' });
            
            // Give plugin time to cleanup
            setTimeout(() => {
                worker.terminate();
                this.workers.delete(pluginId);
                this.serviceCallHandlers.delete(worker);
            }, 100);
        }
        
        this.plugins.update(plugins => {
            plugins.delete(pluginId);
            return plugins;
        });
        
        // Save state after unloading
        this.savePluginState();
        
        console.log(`[PluginService] Plugin ${pluginId} unloaded`);
    }

    enablePlugin(pluginId: string): void {
        const worker = this.workers.get(pluginId);
        if (worker) {
            worker.postMessage({ type: 'ACTIVATE_PLUGIN', pluginId });
        }
        
        this.plugins.update(plugins => {
            const plugin = plugins.get(pluginId);
            if (plugin) {
                plugin.enabled = true;
            }
            return plugins;
        });
        
        // Save state after enabling
        this.savePluginState();
    }

    disablePlugin(pluginId: string): void {
        const worker = this.workers.get(pluginId);
        if (worker) {
            worker.postMessage({ type: 'DEACTIVATE_PLUGIN', pluginId });
        }
        
        this.plugins.update(plugins => {
            const plugin = plugins.get(pluginId);
            if (plugin) {
                plugin.enabled = false;
            }
            return plugins;
        });
        
        // Save state after disabling
        this.savePluginState();
    }

    private dispatchEventToPlugins(event: CoreEvent): void {
        const plugins = get(this.plugins);
        
        plugins.forEach((plugin) => {
            if (plugin.enabled && plugin.worker) {
                const metadata = plugin.metadata;
                
                // Check if plugin is interested in this event
                if (metadata.subscribed_events.includes(event.type) || 
                    metadata.subscribed_events.includes('*')) {
                    
                    const coreEvent = this.convertToCoreEvent(event);
                    
                    plugin.worker.postMessage({
                        type: 'DISPATCH_EVENT',
                        event: coreEvent
                    });
                }
            }
        });
    }

    private convertToCoreEvent(event: any): any {
        const coreEventType = event.type;
        
        // Build Core event structure
        switch (coreEventType) {
            case 'MarkerSelected':
                return {
                    MarkerSelected: {
                        marker_id: String(event.marker_id || event.markerId),
                        marker: event.marker || null
                    }
                };
            case 'MarkerDeselected':
                return {
                    MarkerDeselected: {
                        marker_id: String(event.marker_id || event.markerId)
                    }
                };
            case 'MarkerCreated':
                return {
                    MarkerCreated: {
                        marker: event.marker
                    }
                };
            case 'MarkerUpdated':
                return {
                    MarkerUpdated: {
                        old: event.old || event.marker,
                        new: event.new || event.marker
                    }
                };
            case 'MarkerDeleted':
                return {
                    MarkerDeleted: {
                        marker_id: String(event.marker_id || event.markerId)
                    }
                };
            case 'ProjectOpened':
                return {
                    ProjectOpened: {
                        project: event.project
                    }
                };
            case 'ProjectClosed':
                return { ProjectClosed: {} };
            case 'ImageSelected':
                return {
                    ImageSelected: {
                        image_id: String(event.image_id || event.imageId),
                        image: event.image || null
                    }
                };
            case 'ImageDeselected':
                return { ImageDeselected: {} };
            case 'ImageRemoved':
                return {
                    ImageRemoved: {
                        image_id: String(event.image_id || event.imageId)
                    }
                };
            case 'ImagesReordered':
                return {
                    ImagesReordered: {
                        image_ids: (event.image_ids || event.imageIds || []).map((id: any) => String(id))
                    }
                };
            case 'MarkersReordered':
                return {
                    MarkersReordered: {
                        marker_ids: (event.marker_ids || event.markerIds || []).map((id: any) => String(id))
                    }
                };
            case 'SystemReady':
                return { SystemReady: {} };
            default:
                return {
                    Custom: {
                        event_type: event.type,
                        data: event
                    }
                };
        }
    }

    getPlugins() {
        return derived(this.plugins, $plugins => Array.from($plugins.values()));
    }

    getPlugin(pluginId: string) {
        return derived(this.plugins, $plugins => $plugins.get(pluginId));
    }


    // Send message from one plugin to another
    sendPluginMessage(from: string, to: string, message: any) {
        const targetWorker = this.workers.get(to);
        if (targetWorker) {
            targetWorker.postMessage({
                type: 'PLUGIN_MESSAGE',
                from,
                to,
                message
            });
        }
    }
}

export const pluginService = new PluginService();