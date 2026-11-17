import { writable, derived, get } from 'svelte/store';
import { platformService } from './platformService';
import { invoke } from '@tauri-apps/api/core';

export interface ConfigField {
    key: string;
    label: string;
    field_type: 'text' | 'password' | 'number' | 'select' | 'switch' | 'textarea';
    required?: boolean;
    placeholder?: string;
    help_text?: string;
    default_value?: string;
    options?: Array<{ value: string; label: string }>;
    validation?: Array<{
        type: 'min_length' | 'max_length' | 'pattern' | 'min' | 'max';
        value: number | string;
    }>;
    disabled?: boolean;
}

export interface ConfigSection {
    title: string;
    description?: string;
    fields: ConfigField[];
}

export interface ConfigSchema {
    sections: ConfigSection[];
}

export interface PluginConfig {
    [key: string]: any;
}

interface PluginConfigState {
    [pluginId: string]: PluginConfig;
}

const STORAGE_KEY_PREFIX = 'plugin_config_';

class PluginConfigService {
    private configs = writable<PluginConfigState>({});
    private changeListeners = new Map<string, Set<(config: PluginConfig) => void>>();

    constructor() {
        // Load saved configs on initialization
        if (typeof window !== 'undefined') {
            this.loadAllConfigs();
        }
    }

    /**
     * Load all plugin configurations from localStorage
     */
    private loadAllConfigs() {
        const configs: PluginConfigState = {};

        // Iterate through localStorage to find all plugin configs
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
                const pluginId = key.substring(STORAGE_KEY_PREFIX.length);
                try {
                    const configData = localStorage.getItem(key);
                    if (configData) {
                        configs[pluginId] = JSON.parse(configData);
                    }
                } catch (error) {
                    console.error(`Failed to load config for plugin ${pluginId}:`, error);
                }
            }
        }

        this.configs.set(configs);
    }

    /**
     * Get configuration for a specific plugin
     */
    getConfig(pluginId: string): PluginConfig {
        const configs = get(this.configs);
        return configs[pluginId] || {};
    }

    /**
     * Get a specific configuration value
     */
    getConfigValue(pluginId: string, key: string): any {
        const config = this.getConfig(pluginId);
        return config[key];
    }

    /**
     * Set configuration for a plugin
     */
    async setConfig(pluginId: string, config: PluginConfig) {
        // Always save to localStorage for frontend access
        const storageKey = `${STORAGE_KEY_PREFIX}${pluginId}`;
        localStorage.setItem(storageKey, JSON.stringify(config));

        // Additionally save to backend on desktop for native plugins
        if (platformService.isTauri()) {
            try {
                await invoke('set_plugin_config', { pluginId, config });
            } catch (error) {
                console.error('Failed to save plugin config to backend:', error);
            }
        }

        // Update store
        this.configs.update(configs => ({
            ...configs,
            [pluginId]: config
        }));

        // Notify listeners
        this.notifyListeners(pluginId, config);
    }

    /**
     * Update a specific configuration value
     */
    updateConfigValue(pluginId: string, key: string, value: any) {
        const config = this.getConfig(pluginId);
        const updatedConfig = { ...config, [key]: value };
        this.setConfig(pluginId, updatedConfig);
    }

    /**
     * Delete configuration for a plugin
     */
    deleteConfig(pluginId: string) {
        // Remove from localStorage
        const storageKey = `${STORAGE_KEY_PREFIX}${pluginId}`;
        localStorage.removeItem(storageKey);

        // Update store
        this.configs.update(configs => {
            const updated = { ...configs };
            delete updated[pluginId];
            return updated;
        });

        // Notify listeners with empty config
        this.notifyListeners(pluginId, {});
    }

    /**
     * Validate configuration against schema
     */
    validateConfig(config: PluginConfig, schema: ConfigSchema): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        for (const section of schema.sections) {
            for (const field of section.fields) {
                const value = config[field.key];

                // Check required fields
                if (field.required && (value === undefined || value === null || value === '')) {
                    errors.push(`${field.label} is required`);
                    continue;
                }

                // Skip validation if field is not required and empty
                if (!value) continue;

                // Apply validation rules
                if (field.validation) {
                    for (const rule of field.validation) {
                        switch (rule.type) {
                            case 'min_length':
                                if (typeof value === 'string' && value.length < (rule.value as number)) {
                                    errors.push(`${field.label} must be at least ${rule.value} characters`);
                                }
                                break;
                            case 'max_length':
                                if (typeof value === 'string' && value.length > (rule.value as number)) {
                                    errors.push(`${field.label} must be at most ${rule.value} characters`);
                                }
                                break;
                            case 'pattern':
                                if (typeof value === 'string' && !new RegExp(rule.value as string).test(value)) {
                                    errors.push(`${field.label} format is invalid`);
                                }
                                break;
                            case 'min':
                                if (typeof value === 'number' && value < (rule.value as number)) {
                                    errors.push(`${field.label} must be at least ${rule.value}`);
                                }
                                break;
                            case 'max':
                                if (typeof value === 'number' && value > (rule.value as number)) {
                                    errors.push(`${field.label} must be at most ${rule.value}`);
                                }
                                break;
                        }
                    }
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Apply default values from schema
     */
    applyDefaults(config: PluginConfig, schema: ConfigSchema): PluginConfig {
        const result = { ...config };

        for (const section of schema.sections) {
            for (const field of section.fields) {
                if (result[field.key] === undefined && field.default_value !== undefined) {
                    result[field.key] = field.default_value;
                }
            }
        }

        return result;
    }

    /**
     * Subscribe to configuration changes for a plugin
     */
    subscribeToChanges(pluginId: string, callback: (config: PluginConfig) => void): () => void {
        if (!this.changeListeners.has(pluginId)) {
            this.changeListeners.set(pluginId, new Set());
        }

        const listeners = this.changeListeners.get(pluginId)!;
        listeners.add(callback);

        // Return unsubscribe function
        return () => {
            listeners.delete(callback);
            if (listeners.size === 0) {
                this.changeListeners.delete(pluginId);
            }
        };
    }

    /**
     * Notify listeners of configuration changes
     */
    private notifyListeners(pluginId: string, config: PluginConfig) {
        const listeners = this.changeListeners.get(pluginId);
        if (listeners) {
            listeners.forEach(callback => callback(config));
        }
    }

    /**
     * Export all plugin configurations
     */
    exportConfigs(): string {
        const configs = get(this.configs);
        return JSON.stringify(configs, null, 2);
    }

    /**
     * Import plugin configurations
     */
    importConfigs(data: string) {
        try {
            const configs = JSON.parse(data);

            // Validate and save each config
            for (const [pluginId, config] of Object.entries(configs)) {
                if (typeof config === 'object' && config !== null) {
                    this.setConfig(pluginId, config as PluginConfig);
                }
            }
        } catch (error) {
            console.error('Failed to import configs:', error);
            throw new Error('Invalid configuration data');
        }
    }

    /**
     * Get reactive store for all configs
     */
    get store() {
        return this.configs;
    }

    /**
     * Get reactive store for a specific plugin's config
     */
    getPluginStore(pluginId: string) {
        return derived(this.configs, $configs => $configs[pluginId] || {});
    }
}

export const pluginConfigService = new PluginConfigService();