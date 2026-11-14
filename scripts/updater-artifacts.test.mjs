import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  compareVersions,
  releaseVersion,
  selectArtifacts,
  updateManifest,
  verifyUpdaterSignature,
} from './updater-artifacts.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

test('accepts independent legacy and prehashed Minisign reference vectors', () => {
  const publicText =
    'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
  const publicKey = Buffer.from(publicText).toString('base64');
  const vectors = [
    [
      'RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=',
      'timestamp:1555779966\tfile:test',
      'QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==',
    ],
    [
      'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
      'timestamp:1556193335\tfile:test',
      'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
    ],
  ];
  for (const [packet, comment, global] of vectors) {
    const encoded = Buffer.from(
      `untrusted comment: reference vector\n${packet}\ntrusted comment: ${comment}\n${global}`,
    ).toString('base64');
    verifyUpdaterSignature(Buffer.from('test'), encoded, publicKey);
    assert.throws(
      () => verifyUpdaterSignature(Buffer.from('Test'), encoded, publicKey),
      /verification failed/,
    );
  }
});

test('locks installer bytes, public key, trusted filename and release version', () => {
  const signer = testSigner(),
    bytes = Buffer.from('installer');
  const signature = signer.signature(bytes, 'app.exe', '0.4.0');
  const expected = { filename: 'app.exe', version: '0.4.0' };
  verifyUpdaterSignature(bytes, signature, signer.publicKey, expected);
  assert.throws(
    () => verifyUpdaterSignature(Buffer.from('tampered'), signature, signer.publicKey, expected),
    /verification failed/,
  );
  assert.throws(
    () => verifyUpdaterSignature(bytes, signature, testSigner().publicKey, expected),
    /key ID differs/,
  );
  assert.throws(
    () =>
      verifyUpdaterSignature(bytes, signature, signer.publicKey, { ...expected, version: '0.5.0' }),
    /app version/,
  );
  assert.throws(
    () =>
      verifyUpdaterSignature(bytes, signature, signer.publicKey, {
        ...expected,
        filename: 'other.exe',
      }),
    /filename/,
  );
  const tampered = Buffer.from(
    Buffer.from(signature, 'base64').toString().replace('version:0.4.0', 'version:0.5.0'),
  ).toString('base64');
  assert.throws(() => verifyUpdaterSignature(bytes, tampered, signer.publicKey), /Trusted comment/);
  const duplicate = signer.signature(bytes, 'app.exe', '0.4.0', {
    comment: 'file:app.exe\tversion:0.4.0\tversion:0.5.0',
  });
  assert.throws(
    () => verifyUpdaterSignature(bytes, duplicate, signer.publicKey),
    /Duplicate trusted/,
  );
});

test('verifies a real locked Tauri CLI --app-version signature with an ephemeral key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-signature-test-'));
  const cli = resolve('node_modules/@tauri-apps/cli/tauri.js');
  const run = (args, env = process.env) =>
    promisify(execFile)(process.execPath, [cli, ...args], { env });
  try {
    const key = join(directory, 'ephemeral.key');
    await run(['signer', 'generate', '--ci', '--password', '', '--write-keys', key]);
    const file = join(directory, 'Bubblefish_0.4.0_x64-setup.exe');
    const bytes = Buffer.from('cross-check with the production signer binary');
    await writeFile(file, bytes);
    await run(['signer', 'sign', '--app-version', '0.4.0', file], {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: await readFile(key, 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    });
    verifyUpdaterSignature(
      bytes,
      await readFile(`${file}.sig`, 'utf8'),
      await readFile(`${key}.pub`, 'utf8'),
      {
        version: '0.4.0',
        filename: 'Bubblefish_0.4.0_x64-setup.exe',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires one payload per platform and rejects ambiguous MSI language variants', () => {
  const artifacts = testArtifacts(testSigner());
  assert.throws(
    () =>
      selectArtifacts(
        artifacts.filter(({ kind }) => kind !== 'nsis'),
        '0.4.0',
      ),
    /Missing nsis/,
  );
  assert.throws(
    () => selectArtifacts([...artifacts, { name: 'Bubblefish_0.4.0_x64_zh-CN.msi' }], '0.4.0'),
    /Duplicate msi/,
  );
  assert.equal(
    selectArtifacts([...artifacts, { name: 'example.plugin.bfplugin' }], '0.4.0').length,
    4,
  );
});

test('manifest routes legacy Windows to NSIS and preserves strict installer families and notes', () => {
  const artifacts = testArtifacts(testSigner()),
    release = testRelease();
  const urls = Object.fromEntries(
    artifacts.map(({ name }, index) => [
      name,
      `https://gitee.com/test/bubblefish/attach_files/${index + 70}/download/${name}`,
    ]),
  );
  const manifest = updateManifest(release, artifacts, urls);
  assert.equal(manifest.notes, release.body);
  assert.equal(manifest.platforms['windows-x86_64'].url, urls[artifacts[1].name]);
  assert.equal(manifest.platforms['windows-x86_64-msi'].url, urls[artifacts[0].name]);
  assert.deepEqual(manifest.platforms['darwin-aarch64'], manifest.platforms['darwin-aarch64-app']);
  assert.throws(() => updateManifest(release, artifacts, {}), /Missing published/);
});

test('version ordering prevents lexical and prerelease downgrades', () => {
  assert.equal(releaseVersion('v0.4.0'), '0.4.0');
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.4.0', '0.4.0-beta.9'), 1);
  assert.equal(compareVersions('0.4.0-beta.11', '0.4.0-beta.2'), 1);
  for (const tag of ['main', 'v01.4.0', '0.4.0\nextra', '0.4.0-beta.01'])
    assert.throws(() => releaseVersion(tag));
});
