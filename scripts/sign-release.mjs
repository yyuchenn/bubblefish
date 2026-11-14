import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localEntries, readLocalArtifacts, selectArtifacts } from './updater-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [platform, directory] = process.argv.slice(2);
assert.ok(
  ['windows', 'macos'].includes(platform) && directory,
  'Usage: sign-release.mjs windows|macos <bundle-directory>',
);
assert.ok(
  process.env.TAURI_SIGNING_PRIVATE_KEY,
  'TAURI_SIGNING_PRIVATE_KEY is required for a release',
);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
assert.equal(config.version, manifest.version, 'Tauri and npm versions differ');
const kinds = platform === 'windows' ? ['msi', 'nsis'] : ['dmg', 'app'];
const artifacts = selectArtifacts(await localEntries(resolve(directory)), manifest.version, kinds);
for (const artifact of artifacts) {
  await promisify(execFile)(
    process.execPath,
    [
      resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'signer',
      'sign',
      '--app-version',
      manifest.version,
      artifact.path,
    ],
    { cwd: root, env: process.env },
  );
}
await readLocalArtifacts(
  resolve(directory),
  manifest.version,
  config.plugins.updater.pubkey,
  kinds,
);
console.log(
  `Verified ${artifacts.length} signed ${platform} installers for Bubblefish ${manifest.version}.`,
);
