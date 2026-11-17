import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const artifactKinds = ['msi', 'nsis', 'dmg', 'app'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function releaseVersion(tag) {
  assert.equal(typeof tag, 'string', 'A release tag is required');
  const version = tag.replace(/^v/, '');
  const numeric = '(?:0|[1-9]\\d*)';
  assert.match(
    version,
    new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`),
    `Invalid release tag: ${tag}`,
  );
  for (const part of version.split('-').slice(1).join('-').split('.'))
    assert.ok(!/^0\d+$/.test(part), 'Numeric prerelease identifiers cannot have leading zeros');
  return version;
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const normalized = releaseVersion(value);
    const split = normalized.indexOf('-');
    return [
      (split < 0 ? normalized : normalized.slice(0, split)).split('.').map(BigInt),
      split < 0 ? [] : normalized.slice(split + 1).split('.'),
    ];
  };
  const [a, ap] = parse(left),
    [b, bp] = parse(right);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  if (!ap.length || !bp.length) return ap.length === bp.length ? 0 : ap.length ? -1 : 1;
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    if (ap[index] === undefined || bp[index] === undefined) return ap[index] === undefined ? -1 : 1;
    if (ap[index] === bp[index]) continue;
    const an = /^\d+$/.test(ap[index]),
      bn = /^\d+$/.test(bp[index]);
    if (an && bn) return BigInt(ap[index]) > BigInt(bp[index]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[index] > bp[index] ? 1 : -1;
  }
  return 0;
}

function decodeBase64(value, label) {
  assert.equal(typeof value, 'string', `${label} must be base64 text`);
  const text = value.trim();
  assert.ok(
    text.length && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text),
    `Invalid ${label}`,
  );
  const bytes = Buffer.from(text, 'base64');
  assert.equal(bytes.toString('base64'), text, `Noncanonical ${label}`);
  return bytes;
}

// Minisign's Ed/ED packet format, verified with Node's audited Ed25519 primitive.
// ED signs a BLAKE2b-512 digest. The separate global signature authenticates the
// raw 64-byte signature concatenated with the trusted comment (without prefix).
// References: minisign-verify PublicKey::verify and Tauri CLI sign_file.
export function verifyUpdaterSignature(bytes, encodedSignature, encodedPublicKey, expected = {}) {
  const publicLines = decodeBase64(encodedPublicKey, 'public key')
    .toString('utf8')
    .trimEnd()
    .split(/\r?\n/);
  assert.equal(publicLines.length, 2, 'Invalid minisign public key');
  assert.ok(publicLines[0].startsWith('untrusted comment: '), 'Missing public key comment');
  const packet = decodeBase64(publicLines[1], 'public key packet');
  assert.equal(packet.length, 42, 'Invalid public key packet length');
  assert.ok(
    ['Ed', 'ED'].includes(packet.subarray(0, 2).toString()),
    'Unsupported public key algorithm',
  );
  const lines = decodeBase64(encodedSignature, 'signature')
    .toString('utf8')
    .trimEnd()
    .split(/\r?\n/);
  assert.equal(lines.length, 4, 'Invalid minisign signature');
  assert.ok(lines[0].startsWith('untrusted comment: '), 'Missing signature comment');
  assert.ok(lines[2].startsWith('trusted comment: '), 'Missing trusted signature comment');
  const signature = decodeBase64(lines[1], 'signature packet');
  const global = decodeBase64(lines[3], 'global signature');
  assert.equal(signature.length, 74, 'Invalid signature packet length');
  assert.equal(global.length, 64, 'Invalid global signature length');
  assert.deepEqual(
    signature.subarray(2, 10),
    packet.subarray(2, 10),
    'Signature public key ID differs',
  );
  const algorithm = signature.subarray(0, 2).toString();
  assert.ok(['Ed', 'ED'].includes(algorithm), 'Unsupported signature algorithm');
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), packet.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  assert.ok(
    verify(null, message, key, signature.subarray(10)),
    'Installer signature verification failed',
  );
  const comment = lines[2].slice('trusted comment: '.length);
  assert.ok(
    verify(null, Buffer.concat([signature.subarray(10), Buffer.from(comment)]), key, global),
    'Trusted comment signature verification failed',
  );
  const fields = new Map();
  for (const field of comment.split('\t')) {
    const separator = field.indexOf(':');
    assert.ok(separator > 0, 'Invalid trusted signature field');
    const name = field.slice(0, separator);
    assert.ok(!fields.has(name), `Duplicate trusted signature field: ${name}`);
    fields.set(name, field.slice(separator + 1));
  }
  if (expected.version !== undefined)
    assert.equal(
      fields.get('version'),
      expected.version,
      'Signature is not bound to this app version',
    );
  if (expected.filename !== undefined)
    assert.equal(fields.get('file'), expected.filename, 'Signature is not bound to this filename');
  return comment;
}

export function artifactKind(name, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = {
    msi: new RegExp(`^Bubblefish_${escaped}_x64(?:_[a-z]{2}-[A-Z]{2})?\\.msi$`),
    nsis: new RegExp(`^Bubblefish_${escaped}_x64-setup\\.exe$`),
    dmg: new RegExp(`^Bubblefish_${escaped}_aarch64\\.dmg$`),
    app: new RegExp(`^Bubblefish_${escaped}_aarch64\\.app\\.tar\\.gz$`),
  };
  return artifactKinds.find((kind) => patterns[kind].test(name));
}

export function selectArtifacts(entries, version, kinds = artifactKinds) {
  const selected = new Map();
  const names = new Set();
  for (const entry of entries) {
    const kind = artifactKind(entry.name, version);
    if (!kind || !kinds.includes(kind)) continue;
    assert.ok(!selected.has(kind), `Duplicate ${kind} installer for ${version}`);
    assert.ok(!names.has(entry.name), `Duplicate installer name: ${entry.name}`);
    selected.set(kind, entry);
    names.add(entry.name);
  }
  for (const kind of kinds)
    assert.ok(selected.has(kind), `Missing ${kind} installer for ${version}`);
  return kinds.map((kind) => ({ ...selected.get(kind), kind }));
}

export function verifyArtifacts(entries, version, publicKey, kinds = artifactKinds) {
  const selected = selectArtifacts(entries, version, kinds);
  return selected.map((entry) => {
    const signatures = entries.filter((candidate) => candidate.name === `${entry.name}.sig`);
    assert.equal(signatures.length, 1, `Expected one signature for ${entry.name}`);
    const signature = signatures[0].bytes.toString('utf8').trim();
    verifyUpdaterSignature(entry.bytes, signature, publicKey, { version, filename: entry.name });
    return {
      ...entry,
      signature,
      signatureBytes: signatures[0].bytes,
      digest: sha256(entry.bytes),
    };
  });
}

export async function localEntries(directory) {
  const entries = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith('.app')) await visit(file);
      else if (entry.isFile()) entries.push({ name: basename(file), path: file });
    }
  }
  await visit(directory);
  return entries;
}

export async function readLocalArtifacts(directory, version, publicKey, kinds = artifactKinds) {
  const paths = await localEntries(directory);
  const selected = selectArtifacts(paths, version, kinds);
  const names = new Set(selected.flatMap(({ name }) => [name, `${name}.sig`]));
  const entries = await Promise.all(
    paths
      .filter(({ name }) => names.has(name))
      .map(async (entry) => ({ ...entry, bytes: await readFile(entry.path) })),
  );
  return verifyArtifacts(entries, version, publicKey, kinds);
}

export function updateManifest(release, artifacts, urls) {
  const get = (kind) => {
    const artifact = artifacts.find((entry) => entry.kind === kind);
    assert.ok(artifact && urls[artifact.name], `Missing published ${kind} installer URL`);
    const url = new URL(urls[artifact.name]);
    assert.ok(
      url.protocol === 'https:' && !url.username && !url.password,
      'Updater downloads require public HTTPS URLs',
    );
    return { signature: artifact.signature, url: url.href };
  };
  return {
    version: releaseVersion(release.tag_name),
    notes: release.body ?? '',
    pub_date: new Date(release.published_at).toISOString(),
    platforms: {
      // Old 0.3.0 cannot distinguish installer families. NSIS supports both its
      // own upgrades and the stock WiX -> NSIS migration; MSI lacks the reverse.
      'windows-x86_64': get('nsis'),
      'windows-x86_64-msi': get('msi'),
      'windows-x86_64-nsis': get('nsis'),
      'darwin-aarch64': get('app'),
      'darwin-aarch64-app': get('app'),
    },
  };
}
