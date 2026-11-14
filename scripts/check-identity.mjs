import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appPackages = new Map([
  ['crates/core/Cargo.toml', 'bubblefish-core'],
  ['crates/formats/Cargo.toml', 'bubblefish-formats'],
  ['crates/wasm/Cargo.toml', 'bubblefish-wasm'],
  ['crates/plugin-protocol/Cargo.toml', 'bubblefish-plugin-protocol'],
  ['crates/plugin-sdk/Cargo.toml', 'bubblefish-plugin-sdk'],
  ['src-tauri/Cargo.toml', 'bubblefish-desktop'],
  ['tools/typegen/Cargo.toml', 'bubblefish-typegen'],
]);

export function validateIdentity({ manifest, lock, tauri, cargo, plugin, directory = root, tag }) {
  const version = manifest.version;
  assert.equal(manifest.name, 'bubblefish', 'npm package name must be bubblefish');
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid app version');
  for (const [label, value] of [
    ['npm lockfile', lock],
    ['npm root lock package', lock.packages?.['']],
  ]) {
    assert.equal(value?.name, manifest.name, `${label} package name differs from package.json`);
    assert.equal(value?.version, version, `${label} version differs from package.json`);
  }
  assert.equal(tauri.productName, 'Bubblefish', 'Tauri product name must be Bubblefish');
  assert.equal(tauri.version, version, 'Tauri version differs from package.json');
  assert.equal(tauri.identifier, 'com.yyuchenn.bubblefish', 'Tauri application identity changed');
  assert.equal(
    tauri.bundle.publisher,
    'yyuchenn',
    'Installer publisher must match the original app',
  );
  assert.equal(
    tauri.bundle.createUpdaterArtifacts,
    false,
    'Updater artifacts must be signed after final installer code signing',
  );
  assert.equal(
    tauri.plugins?.updater?.requireSignedVersion,
    true,
    'Updates must bind their version',
  );
  assert.equal(
    tauri.plugins.updater.allowDowngrades,
    false,
    'Updater downgrades must stay disabled',
  );
  assert.deepEqual(
    tauri.plugins.updater.endpoints,
    [
      'https://gitee.com/yyuchenn/bubblefish/raw/updater/latest.json',
      'https://raw.githubusercontent.com/yyuchenn/bubblefish/updater/latest.json',
    ],
    'Updater endpoints must remain compatible with the original app',
  );
  assert.equal(
    tauri.plugins?.updater?.pubkey,
    'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc3N0ZBNTM0NUU5RjgwQTMKUldTamdKOWVOS1YvZHpxcSs4NzMvSlU0Y0w0NWdKRlhtMzFIVVd2UVZOQ1NLQkNzbDVjdVVvUzcK',
    'Updater public key must remain compatible with the original app',
  );
  for (const window of tauri.app.windows)
    assert.equal(window.title, 'Bubblefish', 'Tauri window title must be Bubblefish');
  const association = tauri.bundle.fileAssociations.find((entry) => entry.ext.includes('bf'));
  assert.equal(association?.name, 'Bubblefish Project', 'BF file association name changed');
  assert.equal(association?.mimeType, 'application/x-bubblefish', 'BF MIME type changed');
  assert.equal(
    tauri.bundle.windows.nsis.installMode,
    'perMachine',
    'NSIS installation mode changed',
  );
  assert.equal(
    tauri.bundle.windows.wix.upgradeCode.toLowerCase(),
    '7fc33f0a-2e35-51fe-9cd3-2e23b04dbeb2',
    'MSI upgrade identity changed',
  );
  assert.equal(
    resolve(cargo.workspace_root),
    directory,
    'Cargo workspace must be the repository root',
  );
  const packages = new Map(cargo.packages.map((entry) => [resolve(entry.manifest_path), entry]));
  for (const [path, name] of appPackages) {
    const entry = packages.get(resolve(directory, path));
    assert.equal(entry?.name, name, `${path} package name differs`);
    assert.equal(entry?.version, version, `${name} version differs from package.json`);
  }
  const desktop = packages.get(resolve(directory, 'src-tauri/Cargo.toml'));
  assert.ok(
    desktop.targets.some(
      (target) => target.crate_types.includes('rlib') && target.name === 'bubblefish_app',
    ),
    'Desktop Rust library must be bubblefish_app',
  );
  const members = new Set(cargo.workspace_members);
  for (const entry of cargo.packages) {
    if (!members.has(entry.id)) continue;
    const path = relative(directory, entry.manifest_path).replaceAll('\\', '/');
    assert.ok(!path.startsWith('legacy/'), 'Legacy crates must remain in their own workspace');
    assert.ok(!entry.name.includes('next'), `Obsolete Cargo package name: ${entry.name}`);
  }
  const ocr = packages.get(resolve(directory, 'plugins/kha-white-ocr/rust/Cargo.toml'));
  assert.equal(ocr?.version, plugin.version, 'Kha White plugin Rust and manifest versions differ');
  if (tag)
    assert.ok(
      tag === version || tag === `v${version}`,
      `Release tag ${tag} differs from app version ${version}`,
    );
  return version;
}

async function main() {
  const args = process.argv.slice(2);
  let tag = process.env.BUBBLEFISH_RELEASE_TAG;
  if (args.length) {
    assert.ok(
      args.length === 2 && args[0] === '--tag' && args[1],
      'Usage: check-identity.mjs [--tag <version>]',
    );
    tag = args[1];
  }
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const [manifest, lock, tauri, plugin, metadata] = await Promise.all([
    json('package.json'),
    json('package-lock.json'),
    json('src-tauri/tauri.conf.json'),
    json('plugins/kha-white-ocr/plugin.json'),
    promisify(execFile)(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        resolve(root, 'Cargo.toml'),
        '--no-deps',
        '--format-version',
        '1',
        '--locked',
      ],
      { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    ),
  ]);
  const version = validateIdentity({
    manifest,
    lock,
    tauri,
    plugin,
    cargo: JSON.parse(metadata.stdout),
    tag,
  });
  console.log(
    `Bubblefish ${version}: npm, Cargo, Tauri and installer identities agree${tag ? ` (${tag})` : ''}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`Bubblefish identity check failed: ${error.message}`);
    process.exitCode = 1;
  });
