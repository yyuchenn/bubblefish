import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDoubaoConfig } from '../src/lib/services/doubaoConfigMigration.js';

const pluginId = 'doubao-translation-plugin';
const defaultModel = 'doubao-seed-2-1-pro-260915';

for (const model of [
    'doubao-seed-1-6-250615',
    'doubao-seed-1-6-flash-250828',
    'doubao-1-5-pro-32k-250115'
]) {
    test(`migrates ${model} while preserving credentials and custom settings`, () => {
        const savedConfig = Object.freeze({
            model,
            api_key: 'test-api-key',
            system_prompt: 'Translate {source_lang} to {target_lang}.',
            extra_setting: { enabled: true }
        });

        const migrated = normalizeDoubaoConfig(pluginId, savedConfig);

        assert.deepEqual(migrated, { ...savedConfig, model: defaultModel });
        assert.equal(savedConfig.model, model);
        assert.equal(normalizeDoubaoConfig(pluginId, migrated), migrated);
    });
}

test('preserves current and custom model selections without rewriting config', () => {
    for (const model of [defaultModel, 'doubao-seed-2-1-lite-260915',
        'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-1-pro-260628', 'ep-custom-model']) {
        const config = { model, api_key: 'test-api-key' };
        assert.equal(normalizeDoubaoConfig(pluginId, config), config);
    }
});

test('migrates whitespace-padded legacy model IDs imported from old configs', () => {
    const config = { model: '  doubao-seed-1-6-250615\n', api_key: 'test-api-key' };
    assert.deepEqual(normalizeDoubaoConfig(pluginId, config), { ...config, model: defaultModel });
});

test('leaves other plugins unchanged even when they contain a legacy model ID', () => {
    const config = { model: 'doubao-seed-1-6-250615', api_key: 'other-api-key' };
    assert.equal(normalizeDoubaoConfig('another-plugin', config), config);
});

test('does not introduce defaults into missing or malformed saved model settings', () => {
    for (const config of [{}, { model: '' }, { model: null }, { model: 123 }, null, []]) {
        assert.equal(normalizeDoubaoConfig(pluginId, config), config);
    }
});
