const DOUBAO_PLUGIN_ID = 'doubao-translation-plugin';
const DEFAULT_MODEL = 'doubao-seed-2-1-pro-260915';
const LEGACY_MODELS = new Set([
    'doubao-seed-1-6-250615',
    'doubao-seed-1-6-flash-250828',
    'doubao-1-5-pro-32k-250115'
]);

/**
 * Upgrade only the retired built-in Doubao choices, preserving other settings.
 * Returning the original object when unchanged lets callers avoid extra writes.
 * @template {Record<string, unknown>} T
 * @param {string} pluginId
 * @param {T} config
 * @returns {T}
 */
export function normalizeDoubaoConfig(pluginId, config) {
    if (
        pluginId !== DOUBAO_PLUGIN_ID ||
        !config || typeof config !== 'object' || Array.isArray(config) ||
        typeof config.model !== 'string' || !LEGACY_MODELS.has(config.model.trim())
    ) {
        return config;
    }

    return { ...config, model: DEFAULT_MODEL };
}
