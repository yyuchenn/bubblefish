/// <reference lib="webworker" />

interface PluginInstance {
    init(plugin_id: string, permissions: string[]): void;
    on_event(event: any): void;
    on_message(from: string, message: any): void;
    activate(): void;
    deactivate(): void;
    destroy(): void;
    get_metadata(): any;
    call_service(service: string, method: string, params: any): any;
    send_message(to: string, message: any): void;
}

class PluginWorker {
    private plugins: Map<string, PluginInstance> = new Map();
    private serviceCallHandlers: Map<number, (result: any, error?: any) => void> = new Map();
    private serviceCallId = 0;

    async loadPlugin(pluginId: string, wasmUrl: string, permissions: string[]) {
        try {
            console.log(`[Worker] Loading enhanced plugin ${pluginId} from ${wasmUrl}`);
            
            // Dynamic import of the plugin module
            const moduleUrl = wasmUrl.replace('_bg.wasm', '.js');
            const pluginModule = await import(/* @vite-ignore */ moduleUrl);
            
            // Initialize the WASM module if needed
            if (pluginModule.default && typeof pluginModule.default === 'function') {
                await pluginModule.default();
            }

            // Create plugin instance
            const PluginWrapper = pluginModule.PluginWrapper;
            if (!PluginWrapper) {
                throw new Error('Plugin does not export PluginWrapper');
            }

            const instance = new PluginWrapper();
            
            // Initialize the plugin with permissions
            instance.init(pluginId, permissions);
            
            // Intercept service calls
            instance.call_service = (service: string, method: string, params: any) => {
                // Send service call request to main thread
                const callId = this.serviceCallId++;
                
                return new Promise((resolve, reject) => {
                    this.serviceCallHandlers.set(callId, (result, error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    });
                    
                    self.postMessage({
                        type: 'SERVICE_CALL',
                        pluginId,
                        callId,
                        service,
                        method,
                        params
                    });
                });
            };
            
            // Store the instance
            this.plugins.set(pluginId, instance);

            // Get metadata
            const metadata = instance.get_metadata();
            
            // Activate the plugin
            instance.activate();
            
            self.postMessage({
                type: 'PLUGIN_LOADED',
                pluginId,
                metadata
            });

            console.log(`[Worker] Plugin ${pluginId} loaded successfully`);
        } catch (error) {
            console.error(`[Worker] Failed to load plugin ${pluginId}:`, error);
            self.postMessage({
                type: 'PLUGIN_ERROR',
                pluginId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    unloadPlugin(pluginId: string) {
        const plugin = this.plugins.get(pluginId);
        if (plugin) {
            try {
                plugin.deactivate();
                plugin.destroy();
            } catch (error) {
                console.error(`[Worker] Error destroying plugin ${pluginId}:`, error);
            }
            this.plugins.delete(pluginId);
            console.log(`[Worker] Plugin ${pluginId} unloaded`);
        }
    }

    dispatchEvent(event: any) {
        this.plugins.forEach((plugin, pluginId) => {
            try {
                plugin.on_event(event);
            } catch (error) {
                console.error(`[Worker] Plugin ${pluginId} error handling event:`, error);
            }
        });
    }

    dispatchMessage(from: string, to: string, message: any) {
        const plugin = this.plugins.get(to);
        if (plugin) {
            try {
                plugin.on_message(from, message);
            } catch (error) {
                console.error(`[Worker] Plugin ${to} error handling message:`, error);
            }
        }
    }

    handleServiceCallResponse(callId: number, result: any, error?: any) {
        const handler = this.serviceCallHandlers.get(callId);
        if (handler) {
            handler(result, error);
            this.serviceCallHandlers.delete(callId);
        }
    }

    activatePlugin(pluginId: string) {
        const plugin = this.plugins.get(pluginId);
        if (plugin) {
            try {
                plugin.activate();
                console.log(`[Worker] Plugin ${pluginId} activated`);
            } catch (error) {
                console.error(`[Worker] Error activating plugin ${pluginId}:`, error);
            }
        }
    }

    deactivatePlugin(pluginId: string) {
        const plugin = this.plugins.get(pluginId);
        if (plugin) {
            try {
                plugin.deactivate();
                console.log(`[Worker] Plugin ${pluginId} deactivated`);
            } catch (error) {
                console.error(`[Worker] Error deactivating plugin ${pluginId}:`, error);
            }
        }
    }
}

const worker = new PluginWorker();

// Handle messages from main thread
self.addEventListener('message', async (event) => {
    const { type, ...data } = event.data;
    
    switch (type) {
        case 'LOAD_PLUGIN':
            await worker.loadPlugin(data.pluginId, data.wasmUrl, data.permissions || []);
            break;
            
        case 'UNLOAD_PLUGIN':
            worker.unloadPlugin(data.pluginId);
            break;
            
        case 'DISPATCH_EVENT':
            worker.dispatchEvent(data.event);
            break;
            
        case 'PLUGIN_MESSAGE':
            worker.dispatchMessage(data.from, data.to, data.message);
            break;
            
        case 'SERVICE_CALL_RESPONSE':
            worker.handleServiceCallResponse(data.callId, data.result, data.error);
            break;
            
        case 'ACTIVATE_PLUGIN':
            worker.activatePlugin(data.pluginId);
            break;
            
        case 'DEACTIVATE_PLUGIN':
            worker.deactivatePlugin(data.pluginId);
            break;
            
        default:
            console.warn(`[Worker] Unknown message type: ${type}`);
    }
});

export {};