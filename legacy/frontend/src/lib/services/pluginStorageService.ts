import { platformService } from './platformService';
import { invoke } from '@tauri-apps/api/core';
import JSZip from 'jszip';

export interface PluginFiles {
    id: string;
    files: Map<string, Uint8Array>;
    metadata: any;
}

export interface StoredPlugin {
    id: string;
    name: string;
    files: { [key: string]: ArrayBuffer };
    uploadTime: number;
}

class PluginStorageService {
    private dbName = 'bubblefish_plugins';
    private storeName = 'uploaded_plugins';
    private dbVersion = 1;
    private db: IDBDatabase | null = null;

    constructor() {
        // Initialize IndexedDB for web platform
        if (!platformService.isTauri() && typeof window !== 'undefined') {
            this.initDB().catch(console.error);
        }
    }

    private async initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('uploadTime', 'uploadTime', { unique: false });
                }
            };
        });
    }

    private async ensureDB(): Promise<IDBDatabase> {
        if (!this.db) {
            await this.initDB();
        }
        if (!this.db) {
            throw new Error('Failed to initialize IndexedDB');
        }
        return this.db;
    }

    // Web: Save plugin to IndexedDB
    async savePluginWeb(zipFile: File): Promise<string> {
        const pluginFiles = await this.extractZipToMemory(zipFile);
        const pluginId = pluginFiles.id;
        
        // Convert files to ArrayBuffer for storage
        const filesForStorage: { [key: string]: ArrayBuffer } = {};
        pluginFiles.files.forEach((content, filename) => {
            filesForStorage[filename] = content.buffer as ArrayBuffer;
        });
        
        const storedPlugin: StoredPlugin = {
            id: pluginId,
            name: pluginFiles.metadata?.name || pluginId,
            files: filesForStorage,
            uploadTime: Date.now()
        };
        
        const db = await this.ensureDB();
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.put(storedPlugin);
            request.onsuccess = () => resolve(pluginId);
            request.onerror = () => reject(request.error);
        });
    }

    // Desktop: Upload plugin via Tauri using file dialog
    async savePluginDesktopWithDialog(): Promise<any> {
        const { open } = await import('@tauri-apps/plugin-dialog');

        // Determine expected file extension based on platform
        const platform = platformService.getPlatform();
        let filters: Array<{ name: string; extensions: string[] }> = [];

        if (platform === 'macos') {
            filters = [{ name: 'Plugin', extensions: ['dylib'] }];
        } else if (platform === 'linux') {
            filters = [{ name: 'Plugin', extensions: ['so'] }];
        } else if (platform === 'windows') {
            filters = [{ name: 'Plugin', extensions: ['dll'] }];
        }

        const filePath = await open({
            filters,
            multiple: false,
        });

        if (!filePath) {
            throw new Error('No file selected');
        }

        return invoke('upload_plugin_from_path', {
            filePath: filePath
        });
    }

    // Desktop: Upload plugin via Tauri (legacy method using file data)
    async savePluginDesktop(file: File): Promise<any> {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const byteArray = Array.from(bytes);

        return invoke('upload_plugin', {
            fileData: byteArray,
            filename: file.name
        });
    }

    // Unified save method
    async savePlugin(file: File): Promise<any> {
        if (platformService.isTauri()) {
            return this.savePluginDesktop(file);
        } else {
            return this.savePluginWeb(file);
        }
    }

    // Web: Delete plugin from IndexedDB
    async deletePluginWeb(pluginId: string): Promise<void> {
        const db = await this.ensureDB();
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.delete(pluginId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Desktop: Delete plugin via Tauri
    async deletePluginDesktop(pluginId: string): Promise<void> {
        return invoke('delete_uploaded_plugin', { pluginId });
    }

    // Unified delete method
    async deletePlugin(pluginId: string): Promise<void> {
        if (platformService.isTauri()) {
            return this.deletePluginDesktop(pluginId);
        } else {
            return this.deletePluginWeb(pluginId);
        }
    }

    // Web: Load stored plugins from IndexedDB
    async loadStoredPluginsWeb(): Promise<StoredPlugin[]> {
        const db = await this.ensureDB();
        const transaction = db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // Desktop: Get stored plugins via Tauri
    async loadStoredPluginsDesktop(): Promise<any[]> {
        return invoke('get_stored_plugins');
    }

    // Unified load method
    async loadStoredPlugins(): Promise<any[]> {
        if (platformService.isTauri()) {
            return this.loadStoredPluginsDesktop();
        } else {
            return this.loadStoredPluginsWeb();
        }
    }

    // Get a specific stored plugin
    async getStoredPlugin(pluginId: string): Promise<StoredPlugin | null> {
        if (platformService.isTauri()) {
            // Desktop doesn't need this, plugins are loaded directly from disk
            return null;
        }
        
        const db = await this.ensureDB();
        const transaction = db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.get(pluginId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    // Extract ZIP file to memory (for web)
    async extractZipToMemory(zipFile: File): Promise<PluginFiles> {
        const zip = new JSZip();
        
        const content = await zipFile.arrayBuffer();
        const loadedZip = await zip.loadAsync(content);
        
        const files = new Map<string, Uint8Array>();
        let metadata: any = null;
        let pluginId = '';
        
        // Extract all files
        for (const [filename, file] of Object.entries(loadedZip.files)) {
            if (!file.dir) {
                const data = await file.async('uint8array');
                files.set(filename, data);
                
                // Parse package.json to get metadata
                if (filename.endsWith('package.json')) {
                    try {
                        const text = new TextDecoder().decode(data);
                        const pkg = JSON.parse(text);
                        metadata = pkg;
                        pluginId = pkg.name || '';
                    } catch (e) {
                        console.error('Failed to parse package.json:', e);
                    }
                }
            }
        }
        
        if (!pluginId) {
            // Extract plugin ID from filename if no package.json
            pluginId = zipFile.name.replace(/\.zip$/i, '');
        }
        
        return {
            id: pluginId,
            files,
            metadata
        };
    }

    // Create a Blob URL for a file from IndexedDB
    async createBlobUrl(pluginId: string, filename: string): Promise<string> {
        const plugin = await this.getStoredPlugin(pluginId);
        if (!plugin || !plugin.files[filename]) {
            throw new Error(`File ${filename} not found for plugin ${pluginId}`);
        }
        
        const arrayBuffer = plugin.files[filename];
        const mimeType = this.getMimeType(filename);
        const blob = new Blob([arrayBuffer], { type: mimeType });
        return URL.createObjectURL(blob);
    }
    
    // Create blob URLs for all plugin files
    async createAllBlobUrls(pluginId: string): Promise<Map<string, string>> {
        const plugin = await this.getStoredPlugin(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        
        const urls = new Map<string, string>();
        
        for (const [filename, arrayBuffer] of Object.entries(plugin.files)) {
            const mimeType = this.getMimeType(filename);
            const blob = new Blob([arrayBuffer], { type: mimeType });
            const url = URL.createObjectURL(blob);
            urls.set(filename, url);
        }
        
        return urls;
    }

    private getMimeType(filename: string): string {
        if (filename.endsWith('.js')) return 'application/javascript';
        if (filename.endsWith('.wasm')) return 'application/wasm';
        if (filename.endsWith('.json')) return 'application/json';
        return 'application/octet-stream';
    }

    // Clean up blob URLs
    revokeBlobUrl(url: string): void {
        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }
}

export const pluginStorageService = new PluginStorageService();