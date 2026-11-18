import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveWasmBindgen } from './wasm-bindgen.mjs';

const version = '0.2.130';
const expected = `wasm-bindgen ${version}\n`;
const packageBlock = (value) => `[[package]]\nname = "wasm-bindgen"\nversion = "${value}"\n`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bubblefish-bindgen-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Cargo.lock'), `version = 4\n\n${packageBlock(version)}`);
  return root;
}

async function cached(root, path) {
  const command = join(root, '.cache/wasm-pack', path);
  await mkdir(dirname(command), { recursive: true });
  await writeFile(command, 'test tool');
  return command;
}

function probe(root, responses, env = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push(command);
    assert.deepEqual(args, ['--version']);
    assert.equal(options.cwd, root);
    assert.equal(options.env, env);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, 5_000);
    assert.equal(options.windowsHide, true);
    if (!responses.has(command)) throw new Error(`spawnSync ${command} ENOENT`);
    const result = responses.get(command);
    if (result instanceof Error) throw result;
    return result;
  };
  return { root, env, platform: 'linux', exec, calls };
}

for (const location of [
  'wasm-bindgen-arbitrary-url-hash/wasm-bindgen',
  `wasm-bindgen-cargo-install-${version}/wasm-bindgen`,
  `wasm-bindgen-cargo-install-${version}/bin/wasm-bindgen`,
]) {
  test(`finds an exact CLI in ${location} without requiring PATH`, async (t) => {
    const root = await fixture(t);
    const command = await cached(root, location);
    const options = probe(root, new Map([[command, expected]]));
    assert.equal(await resolveWasmBindgen(options), command);
    assert.deepEqual(options.calls, [command]);
  });
}

test('finds Windows .exe binaries and ignores Unix names on that platform', async (t) => {
  const root = await fixture(t);
  await cached(root, 'a-cache/wasm-bindgen');
  const command = await cached(root, 'z-cache/wasm-bindgen.exe');
  const options = probe(root, new Map([[command, expected]]));
  assert.equal(await resolveWasmBindgen({ ...options, platform: 'win32' }), command);
  assert.deepEqual(options.calls, [command]);
});

test('skips old and broken cached CLIs in deterministic order', async (t) => {
  const root = await fixture(t);
  const old = await cached(root, 'a-old/wasm-bindgen');
  const broken = await cached(root, 'b-broken/wasm-bindgen');
  const matching = await cached(root, 'z-matching/wasm-bindgen');
  const options = probe(
    root,
    new Map([
      [old, 'wasm-bindgen 0.2.129\n'],
      [broken, new Error('not executable')],
      [matching, expected],
    ]),
  );
  assert.equal(await resolveWasmBindgen(options), matching);
  assert.deepEqual(options.calls, [old, broken, matching]);
});

test('falls back to a matching CLI on PATH when the cache is absent', async (t) => {
  const root = await fixture(t);
  const options = probe(root, new Map([['wasm-bindgen', expected]]));
  assert.equal(await resolveWasmBindgen(options), 'wasm-bindgen');
  assert.deepEqual(options.calls, ['wasm-bindgen']);
});

test('explicit overrides take precedence over matching cache and PATH tools', async (t) => {
  const root = await fixture(t);
  await cached(root, 'cache/wasm-bindgen');
  const command = join(root, 'custom tools/wasm-bindgen');
  const options = probe(root, new Map([[command, expected]]), {
    BUBBLEFISH_WASM_BINDGEN: command,
  });
  assert.equal(await resolveWasmBindgen(options), command);
  assert.deepEqual(options.calls, [command]);
});

test('invalid explicit overrides fail without falling back', async (t) => {
  for (const result of ['wasm-bindgen 0.2.129\n', new Error('not executable')]) {
    const root = await fixture(t);
    const matching = await cached(root, 'cache/wasm-bindgen');
    const command = join(root, 'override');
    const options = probe(
      root,
      new Map([
        [command, result],
        [matching, expected],
        ['wasm-bindgen', expected],
      ]),
      { BUBBLEFISH_WASM_BINDGEN: command },
    );
    await assert.rejects(resolveWasmBindgen(options), /Invalid BUBBLEFISH_WASM_BINDGEN/);
    assert.deepEqual(options.calls, [command]);
  }
});

test('missing or mismatched CLIs explain the required version and preparation command', async (t) => {
  for (const responses of [new Map(), new Map([['wasm-bindgen', 'wasm-bindgen 0.2.129\n']])]) {
    const root = await fixture(t);
    await assert.rejects(resolveWasmBindgen(probe(root, responses)), (error) => {
      assert.match(error.message, /Cannot find wasm-bindgen 0\.2\.130/);
      assert.match(error.message, /npm run build:wasm/);
      assert.match(error.message, /BUBBLEFISH_WASM_BINDGEN/);
      return true;
    });
  }
});

test('rejects absent, ambiguous and malformed lockfile versions before probing tools', async (t) => {
  for (const [lock, error] of [
    ['[[package]]\nname = "other"\nversion = "1.0.0"\n', /found none/],
    [packageBlock(version) + packageBlock('0.2.129'), /found 0\.2\.129, 0\.2\.130/],
    [packageBlock('^0.2.130'), /exact wasm-bindgen version/],
  ]) {
    const root = await fixture(t);
    await writeFile(join(root, 'Cargo.lock'), lock);
    const options = probe(root, new Map());
    await assert.rejects(resolveWasmBindgen(options), error);
    assert.deepEqual(options.calls, []);
  }
});

test('does not follow cached directory links or inspect hidden and target directories', async (t) => {
  const root = await fixture(t);
  await cached(root, '.installing/wasm-bindgen');
  await cached(root, 'source/target/bin/wasm-bindgen');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'wasm-bindgen'), 'test tool');
  await symlink(outside, join(root, '.cache/wasm-pack/linked'), 'junction');
  const options = probe(root, new Map([['wasm-bindgen', expected]]));
  assert.equal(await resolveWasmBindgen(options), 'wasm-bindgen');
  assert.deepEqual(options.calls, ['wasm-bindgen']);
});

test('does not follow a symlink used as the cache root', async (t) => {
  const root = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'wasm-bindgen'), 'test tool');
  await mkdir(join(root, '.cache'));
  await symlink(outside, join(root, '.cache/wasm-pack'), 'junction');
  const options = probe(root, new Map([['wasm-bindgen', expected]]));
  assert.equal(await resolveWasmBindgen(options), 'wasm-bindgen');
  assert.deepEqual(options.calls, ['wasm-bindgen']);
});
