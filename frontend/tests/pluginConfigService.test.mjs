import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as svelteStore from 'svelte/store';
import ts from 'typescript';
import { normalizeDoubaoConfig } from '../src/lib/services/doubaoConfigMigration.js';

const pluginId = 'doubao-translation-plugin';
const storageKey = `plugin_config_${pluginId}`;
const defaultModel = 'doubao-seed-2-1-pro-260915';
const source = readFileSync(new URL('../src/lib/services/pluginConfigService.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
});

// Run the real service with isolated browser/host boundaries and real Svelte stores.
function createService(storage, desktop = true) {
    const exports = {};
    const calls = [];
    const errors = [];
    const imports = {
        'svelte/store': svelteStore,
        './platformService': { platformService: { isTauri: () => desktop } },
        '@tauri-apps/api/core': {
            invoke: async (command, args) => { calls.push({ command, args: snapshot(args) }); }
        },
        './doubaoConfigMigration.js': { normalizeDoubaoConfig }
    };

    runInNewContext(outputText, {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected service dependency: ${name}`);
            return imports[name];
        },
        window: {},
        localStorage: storage,
        console: { error: (...args) => errors.push(args) }
    }, { filename: 'pluginConfigService.cjs' });

    return { service: exports.pluginConfigService, calls, errors };
}

function createStorage(config, failWrites = false) {
    const values = new Map(config ? [[storageKey, JSON.stringify(config)]] : []);
    const writes = [];
    return {
        writes,
        get length() { return values.size; },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            writes.push({ key, value });
            if (failWrites) throw new Error('Storage write unavailable');
            values.set(key, String(value));
        },
        removeItem: (key) => { values.delete(key); }
    };
}

// JSON data crossing a VM has different prototypes; compare its stored shape.
function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

test('startup persists the migrated local config without touching desktop config; reload is stable', () => {
    const savedConfig = {
        model: 'doubao-seed-1-6-250615',
        api_key: 'local-test-api-key',
        system_prompt: 'Custom {source_lang} to {target_lang} prompt',
        extra_setting: { enabled: true }
    };
    const expected = { ...savedConfig, model: defaultModel };
    const storage = createStorage(savedConfig);
    const first = createService(storage);

    assert.deepEqual(snapshot(first.service.getConfig(pluginId)), expected);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    assert.equal(storage.writes.length, 1);
    assert.deepEqual(first.calls, []);
    assert.deepEqual(first.errors, []);

    const reloaded = createService(storage);
    assert.deepEqual(snapshot(reloaded.service.getConfig(pluginId)), expected);
    assert.equal(storage.writes.length, 1);
    assert.deepEqual(reloaded.calls, []);
});

test('saving a legacy selection normalizes local, reactive, and desktop config together', async () => {
    const storage = createStorage();
    const { service, calls } = createService(storage);
    const config = {
        model: 'doubao-seed-1-6-flash-250828',
        api_key: 'saved-test-api-key',
        system_prompt: 'Keep this prompt'
    };
    const expected = { ...config, model: defaultModel };

    await service.setConfig(pluginId, config);

    assert.deepEqual(snapshot(service.getConfig(pluginId)), expected);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    assert.deepEqual(calls, [{ command: 'set_plugin_config', args: { pluginId, config: expected } }]);
    assert.equal(config.model, 'doubao-seed-1-6-flash-250828');
});

test('importing an old config normalizes before notifying subscribers or saving to the host', async () => {
    const storage = createStorage();
    const { service, calls } = createService(storage);
    const config = {
        model: '  doubao-1-5-pro-32k-250115\n',
        api_key: 'imported-test-api-key',
        system_prompt: 'Imported prompt'
    };
    const expected = { ...config, model: defaultModel };
    const notification = new Promise(resolve => service.subscribeToChanges(pluginId, resolve));

    service.importConfigs(JSON.stringify({ [pluginId]: config }));

    assert.deepEqual(snapshot(await notification), expected);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    assert.deepEqual(calls, [{ command: 'set_plugin_config', args: { pluginId, config: expected } }]);
});

test('a failed startup migration write retains normalized in-memory config and original saved data', () => {
    const savedConfig = {
        model: 'doubao-seed-1-6-250615',
        api_key: 'preserved-test-api-key',
        system_prompt: 'Preserved prompt'
    };
    const storage = createStorage(savedConfig, true);
    const { service, calls, errors } = createService(storage);

    assert.deepEqual(snapshot(service.getConfig(pluginId)), { ...savedConfig, model: defaultModel });
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), savedConfig);
    assert.equal(storage.writes.length, 1);
    assert.equal(errors.length, 1);
    assert.deepEqual(calls, []);
});
