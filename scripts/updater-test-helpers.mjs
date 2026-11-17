import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { verifyArtifacts } from './updater-artifacts.mjs';

// Ephemeral test material only; no application key or environment secret is used.
export function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicText = `untrusted comment: ephemeral test key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`;
  const encodedPublicKey = Buffer.from(publicText).toString('base64');
  function signature(bytes, filename, version, { prehash = true, comment } = {}) {
    const trusted = comment ?? `timestamp:1700000000\tfile:${filename}\tversion:${version}`;
    const message = prehash ? createHash('blake2b512').update(bytes).digest() : bytes;
    const payload = sign(null, message, privateKey);
    const packet = Buffer.concat([Buffer.from(prehash ? 'ED' : 'Ed'), id, payload]);
    const global = sign(null, Buffer.concat([payload, Buffer.from(trusted)]), privateKey);
    return Buffer.from(
      [
        'untrusted comment: ephemeral test signature',
        packet.toString('base64'),
        `trusted comment: ${trusted}`,
        global.toString('base64'),
        '',
      ].join('\n'),
    ).toString('base64');
  }
  return { publicKey: encodedPublicKey, signature };
}

export function testRelease(version = '0.4.0') {
  return {
    id: 42,
    tag_name: `v${version}`,
    name: `Bubblefish ${version}`,
    draft: false,
    prerelease: version.includes('-'),
    published_at: '2026-11-12T20:00:00Z',
    body: '中文说明 "引号"\n$(do-not-execute) `literal`',
    upload_url: 'https://uploads.github.com/repos/test/bubblefish/releases/42/assets{?name,label}',
  };
}

export function testArtifacts(signer, version = '0.4.0') {
  const names = [
    `Bubblefish_${version}_x64_en-US.msi`,
    `Bubblefish_${version}_x64-setup.exe`,
    `Bubblefish_${version}_aarch64.dmg`,
    `Bubblefish_${version}_aarch64.app.tar.gz`,
  ];
  const entries = names.flatMap((name) => {
    const bytes = Buffer.from(`test installer: ${name}`);
    return [
      {
        name,
        bytes,
        browser_download_url: `https://github.com/test/bubblefish/releases/download/v${version}/${name}`,
      },
      { name: `${name}.sig`, bytes: Buffer.from(signer.signature(bytes, name, version)) },
    ];
  });
  return verifyArtifacts(entries, version, signer.publicKey);
}
