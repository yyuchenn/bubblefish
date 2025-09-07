/// <reference lib="webworker" />

interface PluginInstance {
    init(plugin_id: string): void;
    on_event(event: any): void;
    on_message(from: string, message: any): void;
    activate(): void;
    deactivate(): void;
    destroy(): void;
    get_metadata(): any;
    call_service(service: string, method: string, params: any): any;
    send_message(to: string, message: any): void;
}

interface WasmTransferMessage {
    type: 'PLUGIN_WASM_TRANSFER';
    pluginId: string;
    wasmBytes: ArrayBuffer;
    moduleUrl: string;
    sharedBuffer?: SharedArrayBuffer;
}


class PluginWorker {
    private plugins: Map<string, PluginInstance> = new Map();
    private wasmCache: Map<string, ArrayBuffer> = new Map();

    async loadPlugin(pluginId: string, wasmUrl: string, sharedBuffer?: SharedArrayBuffer) {
        try {
            
            // Dynamic import of the plugin module
            const moduleUrl = wasmUrl.replace('_bg.wasm', '.js');
            const pluginModule = await import(/* @vite-ignore */ moduleUrl);
            
            // Initialize the WASM module with cached bytes from main thread
            const cachedWasmBytes = this.wasmCache.get(pluginId);
            if (!cachedWasmBytes) {
                throw new Error(`WASM bytes not provided for plugin ${pluginId}`);
            }
            
            // Use transferred WASM bytes
            if (pluginModule.initSync) {
                const compiledModule = await WebAssembly.compile(cachedWasmBytes);
                pluginModule.initSync({ module: compiledModule });
            } else {
                throw new Error(`Plugin ${pluginId} does not support initSync`);
            }
            
            // Clear cache after use
            this.wasmCache.delete(pluginId);

            // Create plugin instance
            const PluginWrapper = pluginModule.PluginWrapper;
            if (!PluginWrapper) {
                throw new Error('Plugin does not export PluginWrapper');
            }

            const instance = new PluginWrapper();
            
            // Initialize SharedArrayBuffer FIRST (before plugin.init)
            // This is required so service calls during init() will work
            if (!sharedBuffer) {
                throw new Error('SharedArrayBuffer is required but not provided');
            }
            
            if (!instance.init_shared_buffer) {
                throw new Error('Plugin does not support SharedArrayBuffer');
            }
            
            instance.init_shared_buffer(sharedBuffer);
            
            // NOW initialize the plugin
            // The SharedArrayBuffer channel is ready for service calls
            instance.init(pluginId);
            
            // Store current instance for global access
            (self as any).currentPluginInstance = instance;
            
            // Don't override call_service when SharedArrayBuffer is available
            // The plugin will use synchronous SharedArrayBuffer communication instead
            
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
        case 'PLUGIN_WASM_TRANSFER':
            // Store transferred WASM bytes for later use
            const transferData = event.data as WasmTransferMessage;
            (worker as any).wasmCache.set(transferData.pluginId, transferData.wasmBytes);
            // Now load the plugin with the cached WASM
            await worker.loadPlugin(transferData.pluginId, transferData.moduleUrl.replace('.js', '_bg.wasm'), transferData.sharedBuffer);
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