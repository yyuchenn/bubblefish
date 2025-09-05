import { writable, derived, get } from 'svelte/store';
import { pluginBridge } from './pluginBridge';
import { platformService } from './platformService';
import { pluginStorageService } from './pluginStorageService';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface PluginMetadata {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    subscribed_events: string[];
}

export interface PluginInfo {
    metadata: PluginMetadata;
    enabled: boolean;
    loaded: boolean;
    worker?: Worker;
    isNative?: boolean;  // 标记是否为原生插件
    isUploaded?: boolean; // 标记是否为上传的插件
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
            // Load stored plugins on startup
            this.loadStoredPlugins().catch(console.error);
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
            
            for (const pluginState of state) {
                try {
                    // Try to load the plugin
                    await this.loadPlugin(pluginState.pluginId);
                    
                    // Set enabled state
                    if (!pluginState.enabled) {
                        this.disablePlugin(pluginState.pluginId);
                    }
                    
                } catch (error) {
                    console.warn(`[PluginService] Failed to restore plugin ${pluginState.pluginId}:`, error);
                    // Continue with other plugins even if one fails
                }
            }
        } catch (error) {
            console.error('[PluginService] Failed to restore plugin state:', error);
        }
    }

    async loadPlugin(pluginId: string, pluginPathOrUrl?: string): Promise<void> {
        try {
            // 检测平台
            if (platformService.isTauri()) {
                // 桌面端：加载原生插件
                await this.loadNativePlugin(pluginId, pluginPathOrUrl);
            } else {
                // Web端：加载WASM插件
                await this.loadWasmPlugin(pluginId, pluginPathOrUrl);
            }
        } catch (error) {
            console.error(`[PluginService] Failed to load plugin ${pluginId}:`, error);
            throw error;
        }
    }

    private async loadNativePlugin(pluginId: string, pluginPath?: string): Promise<void> {
        try {
            // 默认插件路径 - 使用相对路径
            // 在macOS上是.dylib，Linux上是.so，Windows上是.dll
            const platform = platformService.getPlatform();
            let ext = 'dylib';
            let prefix = 'lib';
            if (platform === 'linux') {
                ext = 'so';
            } else if (platform === 'windows') {
                ext = 'dll';
                prefix = '';
            }
            
            // 对于打包的应用，直接使用文件名，插件加载器会从资源目录找
            // 对于开发环境，使用完整路径
            const fileName = `${prefix}${pluginId.replace(/-/g, '_')}_plugin.${ext}`;
            const path = pluginPath || fileName;
            
            // 调用Tauri命令加载原生插件
            const metadata = await invoke<PluginMetadata>('load_native_plugin', { 
                pluginPath: path 
            });
            
            const pluginInfo: PluginInfo = {
                metadata,
                enabled: true,
                loaded: true,
                isNative: true
            };
            
            this.plugins.update(plugins => {
                plugins.set(pluginId, pluginInfo);
                return plugins;
            });
            
            // Save state after successfully loading
            this.savePluginState();
            
            
        } catch (error) {
            console.error(`[PluginService] Failed to load native plugin ${pluginId}:`, error);
            throw error;
        }
    }

    private async loadWasmPlugin(pluginId: string, wasmUrl?: string): Promise<void> {
        const url = wasmUrl || `/plugins/${pluginId}/pkg/${pluginId.replace(/-/g, '_')}_plugin.js`;
        
        // Create a worker for this plugin using dynamic import
        const worker = new Worker(
            new URL('../workers/pluginWorker.ts', import.meta.url),
            { type: 'module' }
        );
        
        // Store worker reference
        this.workers.set(pluginId, worker);
        this.serviceCallHandlers.set(worker, new Map());
        
        // Create SharedArrayBuffer (required)
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error('SharedArrayBuffer is not supported in this environment. Please ensure CORS headers are properly configured.');
        }
        
        // Import and initialize SharedBufferHandler
        const { sharedBufferHandler } = await import('./sharedBufferHandler');
        const sharedBuffer = sharedBufferHandler.getBuffer();
        
        // Start monitoring requests if not already started
        sharedBufferHandler.start();
        
        // Initialize the plugin in the worker
        worker.postMessage({
            type: 'LOAD_PLUGIN',
            pluginId,
            wasmUrl: url,
            sharedBuffer
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
                        worker,
                        isNative: false
                    };
                    
                    this.plugins.update(plugins => {
                        plugins.set(pluginId, pluginInfo);
                        return plugins;
                    });
                    
                    // Save state after successfully loading
                    this.savePluginState();
                    
                    
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

    private async handleServiceCall(worker: Worker | null, data: any) {
        const { callId, pluginId, service, method, params } = data;
        
        try {
            let result;
            
            // 检查是否为原生插件的服务调用
            const plugins = get(this.plugins);
            const plugin = plugins.get(pluginId);
            
            if (plugin?.isNative && platformService.isTauri()) {
                // 原生插件直接调用Tauri命令
                result = await invoke('call_plugin_service', {
                    pluginId,
                    service,
                    method,
                    params
                });
            } else {
                // WASM插件通过pluginBridge
                result = await pluginBridge.handleServiceCall({
                    pluginId,
                    service,
                    method,
                    params
                });
            }
            
            if (worker) {
                worker.postMessage({
                    type: 'SERVICE_CALL_RESPONSE',
                    callId,
                    result
                });
            }
        } catch (error) {
            if (worker) {
                worker.postMessage({
                    type: 'SERVICE_CALL_RESPONSE',
                    callId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
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
        const plugins = get(this.plugins);
        const plugin = plugins.get(pluginId);
        
        if (plugin?.isNative && platformService.isTauri()) {
            // 卸载原生插件
            await invoke('unload_native_plugin', { pluginId });
        } else {
            // 卸载WASM插件
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
        }
        
        this.plugins.update(plugins => {
            plugins.delete(pluginId);
            return plugins;
        });
        
        // Save state after unloading
        this.savePluginState();
        
    }

    async enablePlugin(pluginId: string): Promise<void> {
        const plugins = get(this.plugins);
        const plugin = plugins.get(pluginId);
        
        if (plugin?.isNative && platformService.isTauri()) {
            await invoke('enable_native_plugin', { pluginId, enabled: true });
        } else {
            const worker = this.workers.get(pluginId);
            if (worker) {
                worker.postMessage({ type: 'ACTIVATE_PLUGIN', pluginId });
            }
        }
        
        this.plugins.update(plugins => {
            const newPlugins = new Map(plugins);
            const plugin = newPlugins.get(pluginId);
            if (plugin) {
                // Create a new plugin object to trigger reactivity
                newPlugins.set(pluginId, {
                    ...plugin,
                    enabled: true
                });
            }
            return newPlugins;
        });
        
        // Save state after enabling
        this.savePluginState();
    }

    async disablePlugin(pluginId: string): Promise<void> {
        const plugins = get(this.plugins);
        const plugin = plugins.get(pluginId);
        
        if (plugin?.isNative && platformService.isTauri()) {
            await invoke('enable_native_plugin', { pluginId, enabled: false });
        } else {
            const worker = this.workers.get(pluginId);
            if (worker) {
                worker.postMessage({ type: 'DEACTIVATE_PLUGIN', pluginId });
            }
        }
        
        this.plugins.update(plugins => {
            const newPlugins = new Map(plugins);
            const plugin = newPlugins.get(pluginId);
            if (plugin) {
                // Create a new plugin object to trigger reactivity
                newPlugins.set(pluginId, {
                    ...plugin,
                    enabled: false
                });
            }
            return newPlugins;
        });
        
        // Save state after disabling
        this.savePluginState();
    }

    private async dispatchEventToPlugins(event: CoreEvent): Promise<void> {
        const plugins = get(this.plugins);
        
        for (const [pluginId, plugin] of plugins) {
            if (!plugin.enabled) continue;
            
            const metadata = plugin.metadata;
            
            // Check if plugin is interested in this event
            if (metadata.subscribed_events.includes(event.type) || 
                metadata.subscribed_events.includes('*')) {
                
                const coreEvent = this.convertToCoreEvent(event);
                
                if (plugin.isNative && platformService.isTauri()) {
                    // 发送事件到原生插件
                    try {
                        await invoke('dispatch_event_to_plugin', {
                            pluginId,
                            event: coreEvent
                        });
                    } catch (error) {
                        console.error(`Failed to dispatch event to native plugin ${pluginId}:`, error);
                    }
                } else if (plugin.worker) {
                    // 发送事件到WASM插件
                    plugin.worker.postMessage({
                        type: 'DISPATCH_EVENT',
                        event: coreEvent
                    });
                }
            }
        }
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

    // Upload a plugin file
    async uploadPlugin(file: File): Promise<void> {
        try {
            if (platformService.isTauri()) {
                // Desktop: validate file extension
                const platform = platformService.getPlatform();
                let expectedExt = '.dylib';
                if (platform === 'linux') {
                    expectedExt = '.so';
                } else if (platform === 'windows') {
                    expectedExt = '.dll';
                }
                
                if (!file.name.endsWith(expectedExt)) {
                    throw new Error(`Invalid plugin file. Expected ${expectedExt} file for ${platform}`);
                }
                
                // Upload and load the plugin
                const metadata = await pluginStorageService.savePlugin(file);
                
                // Plugin is already loaded by the backend, just add to our store
                const pluginInfo: PluginInfo = {
                    metadata,
                    enabled: true,
                    loaded: true,
                    isNative: true,
                    isUploaded: true
                };
                
                this.plugins.update(plugins => {
                    plugins.set(metadata.id, pluginInfo);
                    return plugins;
                });
                
            } else {
                // Web: validate ZIP file
                if (!file.name.endsWith('.zip')) {
                    throw new Error('Invalid plugin file. Expected ZIP file for web platform');
                }
                
                // Save to IndexedDB
                const pluginId = await pluginStorageService.savePlugin(file);
                
                // Load the plugin from IndexedDB
                await this.loadUploadedWasmPlugin(pluginId);
            }
            
            // Save state
            this.savePluginState();
        } catch (error) {
            console.error('[PluginService] Failed to upload plugin:', error);
            throw error;
        }
    }

    // Load an uploaded WASM plugin from IndexedDB
    private async loadUploadedWasmPlugin(pluginId: string): Promise<void> {
        const storedPlugin = await pluginStorageService.getStoredPlugin(pluginId);
        if (!storedPlugin) {
            throw new Error(`Stored plugin ${pluginId} not found`);
        }
        
        // For uploaded plugins, we need to handle them differently
        // Since blob URLs don't support relative imports, we need to patch the JS file
        const jsFilename = Object.keys(storedPlugin.files).find(f => f.endsWith('.js'));
        if (!jsFilename) {
            throw new Error(`No JS file found for plugin ${pluginId}`);
        }
        
        // Get the JS content and patch it
        const jsContent = new TextDecoder().decode(storedPlugin.files[jsFilename]);
        const wasmFilename = Object.keys(storedPlugin.files).find(f => f.endsWith('.wasm'));
        
        if (!wasmFilename) {
            throw new Error(`No WASM file found for plugin ${pluginId}`);
        }
        
        // Create blob URL for WASM file
        const wasmUrl = await pluginStorageService.createBlobUrl(pluginId, wasmFilename);
        
        // Patch the JS to use the blob URL for WASM
        let patchedJs = jsContent;
        
        // Replace WASM import with blob URL
        patchedJs = patchedJs.replace(
            /import\.meta\.url\.replace\(\/\\\.js\$\/,[^)]+\)/g,
            `'${wasmUrl}'`
        );
        
        // Also handle direct wasm file references
        patchedJs = patchedJs.replace(
            new RegExp(`['"\`]\\.\/${wasmFilename.replace('.', '\\.')}['"\`]`, 'g'),
            `'${wasmUrl}'`
        );
        
        // Check if the JS file has snippet imports (if not bundled)
        const hasSnippetImports = /import\s*\{\s*[^}]+\s*\}\s*from\s*['"`]\.\/snippets\//.test(jsContent);
        
        if (hasSnippetImports) {
            // This is an unbundled plugin, need to inline snippets
            const snippetContents: string[] = [];
            const snippetImports: string[] = [];
            
            // Find and process all snippet imports
            const importRegex = /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"`](\.\/snippets\/[^'"]+)['"`];?/g;
            let match;
            
            while ((match = importRegex.exec(jsContent)) !== null) {
                const importedName = match[1].trim();
                const importPath = match[2];
                
                // Find the corresponding file in storedPlugin.files
                const normalizedPath = importPath.replace('./', '');
                if (storedPlugin.files[normalizedPath]) {
                    const snippetContent = new TextDecoder().decode(storedPlugin.files[normalizedPath]);
                    snippetContents.push(`// Inlined from ${normalizedPath}`);
                    snippetContents.push(snippetContent);
                    snippetImports.push(match[0]);
                }
            }
            
            // Remove all snippet imports and add inlined content at the top
            for (const imp of snippetImports) {
                patchedJs = patchedJs.replace(imp, '');
            }
            
            // Add all snippet contents at the beginning of the file
            if (snippetContents.length > 0) {
                patchedJs = snippetContents.join('\n') + '\n\n' + patchedJs;
            }
        }
        
        // Create blob URL for patched JS
        const patchedJsBlob = new Blob([patchedJs], { type: 'application/javascript' });
        const jsUrl = URL.createObjectURL(patchedJsBlob);
        
        try {
            // Use the existing loadWasmPlugin method with patched JS URL
            await this.loadWasmPlugin(pluginId, jsUrl);
            
            // Mark as uploaded
            this.plugins.update(plugins => {
                const plugin = plugins.get(pluginId);
                if (plugin) {
                    plugin.isUploaded = true;
                }
                return plugins;
            });
        } finally {
            // Clean up blob URLs
            URL.revokeObjectURL(jsUrl);
            URL.revokeObjectURL(wasmUrl);
        }
    }

    // Delete an uploaded plugin
    async deleteUploadedPlugin(pluginId: string): Promise<void> {
        try {
            // First unload the plugin
            await this.unloadPlugin(pluginId);
            
            // Then delete from storage
            await pluginStorageService.deletePlugin(pluginId);
            
            console.log(`[PluginService] Deleted uploaded plugin ${pluginId}`);
        } catch (error) {
            console.error(`[PluginService] Failed to delete plugin ${pluginId}:`, error);
            throw error;
        }
    }

    // Load all stored plugins on startup
    async loadStoredPlugins(): Promise<void> {
        try {
            if (platformService.isTauri()) {
                // Desktop: listen for stored plugin events from backend
                await listen<string>('plugin:stored-plugin-found', async (event) => {
                    const pluginPath = event.payload;
                    const filename = pluginPath.split(/[/\\]/).pop() || '';
                    const pluginId = filename
                        .replace(/^lib/, '')
                        .replace(/\.(dylib|so|dll)$/, '');
                    
                    try {
                        await this.loadPlugin(pluginId, pluginPath);
                        // Mark as uploaded
                        this.plugins.update(plugins => {
                            const plugin = plugins.get(pluginId);
                            if (plugin) {
                                plugin.isUploaded = true;
                            }
                            return plugins;
                        });
                    } catch (error) {
                        console.error(`Failed to load stored plugin ${pluginId}:`, error);
                    }
                });
            } else {
                // Web: load from IndexedDB
                const storedPlugins = await pluginStorageService.loadStoredPlugins();
                for (const plugin of storedPlugins) {
                    try {
                        await this.loadUploadedWasmPlugin(plugin.id);
                    } catch (error) {
                        console.error(`Failed to load stored plugin ${plugin.id}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error('[PluginService] Failed to load stored plugins:', error);
        }
    }

    // Send message from one plugin to another
    async sendPluginMessage(from: string, to: string, message: any) {
        const plugins = get(this.plugins);
        const targetPlugin = plugins.get(to);
        
        if (targetPlugin?.isNative && platformService.isTauri()) {
            // 发送消息到原生插件
            await invoke('send_message_to_plugin', { to, from, message });
        } else {
            // 发送消息到WASM插件
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
}

export const pluginService = new PluginService();