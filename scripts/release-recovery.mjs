import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { GithubReleaseApi, GiteeReleaseApi, ReleaseHttp, repositoryPath } from './updater-api.mjs';
import { GitUpdaterStore } from './updater-git.mjs';
import {
  applyReleaseMetadata,
  artifactKind,
  compareVersions,
  readLocalArtifacts,
  releaseMetadata,
  releaseVersion,
  sha256,
  verifyArtifacts,
  verifyUpdaterSignature,
} from './updater-artifacts.mjs';
import { readReleaseSource, resolveGithubTag } from './release-source.mjs';

const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxBackupBytes = 512 * 1024 * 1024;
const hosts = ['github', 'gitee'];

function positiveId(value, label) {
  assert.match(String(value ?? ''), /^[1-9]\d*$/, `Invalid ${label}`);
  return String(value);
}

function publicDownload(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'Recovery backups require public download URLs without credentials or query parameters',
  );
  return url.href;
}

function releaseRecord(release, tag) {
  if (!release) return null;
  assert.equal(release.tag_name, tag, 'Recovery release tag differs');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid recovery release ID');
  return Object.fromEntries(
    [
      'id',
      'tag_name',
      'target_commitish',
      'name',
      'body',
      'draft',
      'prerelease',
      'published_at',
      'created_at',
    ].map((key) => [key, release[key] ?? null]),
  );
}

function assetRecords(assets) {
  const names = new Set();
  return assets
    .map((asset) => {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid recovery attachment ID');
      assert.ok(
        typeof asset.name === 'string' && asset.name.length > 0,
        'Invalid recovery attachment name',
      );
      assert.ok(!names.has(asset.name), `Duplicate recovery attachment: ${asset.name}`);
      names.add(asset.name);
      assert.ok(
        Number.isSafeInteger(asset.size) && asset.size > 0,
        `Invalid recovery attachment size: ${asset.name}`,
      );
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        url: publicDownload(asset.browser_download_url),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
}

async function collectState({ tag, source, github, gitee, githubStore, giteeStore }) {
  const remoteCommit = await resolveGithubTag(github, tag);
  assert.equal(remoteCommit, source.releaseCommit, 'Release tag moved before recovery');
  const release = await github.release(tag);
  assert.ok(
    !release.draft && Number.isFinite(Date.parse(release.published_at)),
    'Recovery requires a published GitHub release',
  );
  const mirrored = await gitee.json(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });
  const [githubSnapshot, giteeSnapshot, githubAssets, giteeAssets] = await Promise.all([
    githubStore.snapshotRelease(tag),
    giteeStore.snapshotRelease(tag),
    github.assets(release),
    mirrored ? gitee.list(`/releases/${mirrored.id}/attach_files`) : [],
  ]);
  const state = {
    remoteCommit,
    github: {
      updater: githubSnapshot,
      release: releaseRecord(release, tag),
      assets: assetRecords(githubAssets),
    },
    gitee: {
      updater: giteeSnapshot,
      release: releaseRecord(mirrored, tag),
      assets: assetRecords(giteeAssets),
    },
  };
  const bytes = new Map();
  let total = 0;
  for (const host of hosts) {
    for (const asset of state[host].assets) {
      const content = await (host === 'github' ? github : gitee).http.download(asset.url);
      assert.equal(content.length, asset.size, `Recovery attachment size differs: ${asset.name}`);
      total += content.length;
      assert.ok(total <= maxBackupBytes, 'Recovery backup exceeds the supported size limit');
      asset.sha256 = sha256(content);
      bytes.set(`${host}/${asset.id}`, content);
    }
  }
  return { state, bytes };
}

function verifiedSourceArtifacts(artifacts, source, tag) {
  assert.equal(source.version, releaseVersion(tag), 'Recovery source version differs');
  assert.match(source.releaseCommit, commitPattern, 'Invalid recovery source commit');
  return verifyArtifacts(
    artifacts.flatMap((artifact) => [
      artifact,
      { name: `${artifact.name}.sig`, bytes: artifact.signatureBytes },
    ]),
    source.version,
    source.publicKey,
  );
}

function assertUnpublishedFeed(latest, { tag, version, assets }) {
  if (!latest) return;
  assert.ok(
    compareVersions(latest.version, version) < 0,
    `Cannot reset a published or newer update feed: ${tag}`,
  );
  const assetUrls = new Set(assets.map(({ url }) => url));
  for (const entry of Object.values(latest.platforms ?? {})) {
    if (!entry?.url) continue;
    const url = new URL(entry.url);
    const path = decodeURIComponent(url.pathname);
    const filename = path.slice(path.lastIndexOf('/') + 1);
    assert.ok(
      !assetUrls.has(url.href) &&
        !path.includes(`/${tag}/`) &&
        !path.includes(`/${version}/`) &&
        !artifactKind(filename, version),
      `Update feed already references recovery release assets: ${tag}`,
    );
  }
}

function recoveryHosts(state, source, tag, expectedArchivedCommit, artifacts, downloaded) {
  assert.match(
    expectedArchivedCommit ?? '',
    commitPattern,
    'An expected archived commit is required',
  );
  assert.notEqual(
    expectedArchivedCommit,
    source.releaseCommit,
    'Recovery must not reset the selected source commit',
  );
  const reset = [];
  for (const host of hosts) {
    const archived = state[host].updater.archive;
    if (archived?.releaseCommit === source.releaseCommit) {
      // A previous recovery may already have established the correct archive.
      applyReleaseMetadata(archived, artifacts, tag, source.releaseCommit, source.publicKey);
    } else if (archived) {
      assert.equal(
        archived.releaseCommit,
        expectedArchivedCommit,
        `${host} archive changed from the expected recovery identity`,
      );
      reset.push(host);
    }
    for (const asset of state[host].assets) {
      const signature = asset.name.endsWith('.sig');
      const filename = signature ? asset.name.slice(0, -4) : asset.name;
      if (!artifactKind(filename, source.version)) continue;
      const artifact = artifacts.find(({ name }) => name === filename);
      assert.ok(artifact, `Unexpected published installer during recovery: ${asset.name}`);
      const bytes = downloaded.get(`${host}/${asset.id}`);
      if (signature) {
        verifyUpdaterSignature(artifact.bytes, bytes.toString('utf8').trim(), source.publicKey, {
          version: source.version,
          filename,
        });
      } else {
        assert.equal(
          sha256(bytes),
          sha256(artifact.bytes),
          `Published attachment differs: ${asset.name}`,
        );
      }
    }
  }
  if (reset.length) {
    for (const host of hosts)
      assertUnpublishedFeed(state[host].updater.latest, {
        tag,
        version: source.version,
        assets: state[host].assets,
      });
  }
  return reset;
}

function backupPath(value) {
  assert.ok(
    typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe recovery backup path',
  );
  return value;
}

export async function prepareReleaseRecovery({
  tag,
  source,
  artifacts,
  expectedArchivedCommit,
  backupDirectory,
  repository,
  runId,
  runAttempt = '1',
  github,
  gitee,
  githubStore,
  giteeStore,
  now = () => new Date().toISOString(),
}) {
  repositoryPath(repository);
  runId = positiveId(runId, 'recovery workflow run');
  runAttempt = positiveId(runAttempt, 'recovery workflow attempt');
  artifacts = verifiedSourceArtifacts(artifacts, source, tag);
  const { state, bytes } = await collectState({
    tag,
    source,
    github,
    gitee,
    githubStore,
    giteeStore,
  });
  const reset = recoveryHosts(state, source, tag, expectedArchivedCommit, artifacts, bytes);
  const backupName = `release-recovery-${tag}-${runId}-${runAttempt}`;
  await mkdir(dirname(backupDirectory), { recursive: true });
  await mkdir(backupDirectory);
  const files = [];
  const save = async (path, content) => {
    backupPath(path);
    content = Buffer.from(content);
    await mkdir(dirname(join(backupDirectory, path)), { recursive: true });
    await writeFile(join(backupDirectory, path), content, { flag: 'wx', mode: 0o600 });
    files.push({ path, size: content.length, sha256: sha256(content) });
  };
  for (const host of hosts) {
    const updater = state[host].updater;
    if (updater.archiveContent !== null)
      await save(`${host}/release-archive.json`, updater.archiveContent);
    if (updater.latestContent !== null) await save(`${host}/latest.json`, updater.latestContent);
    await save(`${host}/release.json`, JSON.stringify(state[host].release, null, 2));
    for (const asset of state[host].assets)
      await save(`attachments/${host}/${asset.id}`, bytes.get(`${host}/${asset.id}`));
  }
  for (const artifact of artifacts) {
    await save(`installers/${artifact.name}`, artifact.bytes);
    await save(`installers/${artifact.name}.sig`, artifact.signatureBytes);
  }
  const snapshot = {
    schemaVersion: 1,
    repository,
    tag,
    source: {
      version: source.version,
      publicKey: source.publicKey,
      releaseCommit: source.releaseCommit,
    },
    expectedArchivedCommit,
    runId,
    runAttempt,
    backupName,
    createdAt: now(),
    state,
    reset,
    installers: releaseMetadata(tag, source.releaseCommit, artifacts),
  };
  await save('snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  const manifest = `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
  await writeFile(join(backupDirectory, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
  return {
    status: reset.length ? 'prepared' : 'unchanged',
    backupName,
    fingerprint: sha256(Buffer.from(manifest)),
    reset,
  };
}

async function readBackup(directory, expectedFingerprint) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  if (expectedFingerprint)
    assert.equal(sha256(manifestBytes), expectedFingerprint, 'Recovery backup fingerprint differs');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1, 'Unsupported recovery backup manifest');
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    'Incomplete recovery backup',
  );
  const files = new Map();
  let total = 0;
  for (const entry of manifest.files) {
    backupPath(entry.path);
    assert.ok(!files.has(entry.path), 'Duplicate recovery backup path');
    const bytes = await readFile(join(directory, entry.path));
    assert.equal(bytes.length, entry.size, `Recovery backup size differs: ${entry.path}`);
    assert.equal(sha256(bytes), entry.sha256, `Recovery backup digest differs: ${entry.path}`);
    total += bytes.length;
    assert.ok(total <= maxBackupBytes, 'Recovery backup exceeds the supported size limit');
    files.set(entry.path, bytes);
  }
  assert.ok(files.has('snapshot.json'), 'Missing recovery snapshot');
  const snapshot = JSON.parse(files.get('snapshot.json'));
  assert.equal(snapshot.schemaVersion, 1, 'Unsupported recovery snapshot');
  files.set('manifest.json', manifestBytes);
  return { snapshot, files, manifest, total };
}

async function verifyPersistedBackup({ github, backupArtifactId, backup, repository, runId }) {
  backupArtifactId = positiveId(backupArtifactId, 'persisted backup artifact');
  const { snapshot, files, total } = backup;
  assert.equal(snapshot.repository, repository, 'Recovery repository differs');
  assert.equal(
    snapshot.runId,
    positiveId(runId, 'recovery workflow run'),
    'Recovery workflow run differs',
  );
  const artifact = await github.json(`/actions/artifacts/${backupArtifactId}`);
  assert.equal(String(artifact.id), backupArtifactId, 'Persisted backup artifact ID differs');
  assert.equal(artifact.name, snapshot.backupName, 'Persisted backup artifact name differs');
  assert.equal(
    String(artifact.workflow_run?.id),
    snapshot.runId,
    'Persisted backup belongs to another workflow run',
  );
  assert.equal(artifact.expired, false, 'Persisted backup artifact has expired');
  if (artifact.expires_at !== undefined)
    assert.ok(
      Number.isFinite(Date.parse(artifact.expires_at)) &&
        Date.parse(artifact.expires_at) > Date.now(),
      'Persisted backup artifact has expired or has an invalid expiry',
    );
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= total + 1024 * 1024,
    'Invalid persisted backup size',
  );
  const response = await github.http.response(
    `${github.base}/actions/artifacts/${backupArtifactId}/zip`,
    { headers: github.headers },
  );
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= total + 1024 * 1024, 'Persisted backup archive exceeds expected size');
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  assert.equal(archive.length, artifact.size_in_bytes, 'Persisted backup archive size differs');
  if (artifact.digest)
    assert.equal(
      artifact.digest,
      `sha256:${sha256(archive)}`,
      'Persisted backup archive digest differs',
    );
  const stored = unzipSync(archive, { filter: (entry) => files.has(entry.name) });
  for (const [path, bytes] of files) {
    assert.ok(stored[path], `Persisted backup is missing ${path}`);
    assert.equal(sha256(stored[path]), sha256(bytes), `Persisted backup differs: ${path}`);
  }
}

export async function applyReleaseRecovery({
  backupDirectory,
  backupArtifactId,
  backupFingerprint,
  repository,
  runId,
  github,
  gitee,
  githubStore,
  giteeStore,
}) {
  repositoryPath(repository);
  const backup = await readBackup(backupDirectory, backupFingerprint);
  await verifyPersistedBackup({ github, backupArtifactId, backup, repository, runId });
  const { snapshot, files } = backup;
  const { tag, source, expectedArchivedCommit } = snapshot;
  const artifacts = verifiedSourceArtifacts(
    snapshot.installers.artifacts.map(({ name }) => ({
      name,
      bytes: files.get(`installers/${name}`),
      signatureBytes: files.get(`installers/${name}.sig`),
    })),
    source,
    tag,
  );
  applyReleaseMetadata(snapshot.installers, artifacts, tag, source.releaseCommit, source.publicKey);
  const { state, bytes } = await collectState({
    tag,
    source,
    github,
    gitee,
    githubStore,
    giteeStore,
  });
  assert.ok(
    JSON.stringify(state) === JSON.stringify(snapshot.state),
    'Remote release state changed after recovery backup',
  );
  const reset = recoveryHosts(state, source, tag, expectedArchivedCommit, artifacts, bytes);
  assert.ok(
    JSON.stringify(reset) === JSON.stringify(snapshot.reset),
    'Recovery reset scope changed',
  );
  const removed = [];
  for (const host of reset) {
    const store = host === 'github' ? githubStore : giteeStore;
    await store.removeRelease(tag, state[host].updater);
    removed.push(host);
  }
  return {
    status: removed.length ? 'reset' : 'unchanged',
    tag,
    releaseCommit: source.releaseCommit,
    removed,
  };
}

async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  assert.ok(
    ['prepare', 'apply'].includes(command),
    'Usage: release-recovery.mjs <prepare|apply> --backup <directory>',
  );
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert.ok(
      [
        '--tag',
        '--source',
        '--artifacts',
        '--expected-archived-commit',
        '--backup',
        '--backup-artifact-id',
        '--backup-fingerprint',
      ].includes(key),
      `Unknown recovery argument: ${key}`,
    );
    const value = args[++index];
    assert.ok(value && !value.startsWith('--'), `${key} requires a value`);
    options[key.slice(2)] = value;
  }
  assert.ok(options.backup, '--backup is required');
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const giteeRepository = repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish');
  const http = new ReleaseHttp();
  const github = new GithubReleaseApi({ repository, token: process.env.GITHUB_TOKEN, http });
  const gitee = new GiteeReleaseApi({
    repository: giteeRepository,
    token: process.env.GITEE_TOKEN,
    http,
  });
  const githubStore = new GitUpdaterStore({
    remote: `https://github.com/${repository}.git`,
    token: process.env.GITHUB_TOKEN,
  });
  const giteeStore = new GitUpdaterStore({
    remote: `https://gitee.com/${giteeRepository}.git`,
    token: process.env.GITEE_TOKEN,
    username: 'oauth2',
  });
  try {
    const common = {
      backupDirectory: resolve(options.backup),
      repository,
      runId: process.env.GITHUB_RUN_ID,
      github,
      gitee,
      githubStore,
      giteeStore,
    };
    let result;
    if (command === 'prepare') {
      assert.ok(
        options.tag && options.artifacts && options['expected-archived-commit'],
        'prepare requires --tag, --artifacts and --expected-archived-commit',
      );
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const source = await readReleaseSource(resolve(options.source || root), options.tag);
      result = await prepareReleaseRecovery({
        ...common,
        tag: options.tag,
        source,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
        artifacts: await readLocalArtifacts(
          resolve(options.artifacts),
          source.version,
          source.publicKey,
        ),
        expectedArchivedCommit: options['expected-archived-commit'],
      });
      if (process.env.GITHUB_OUTPUT)
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `backup_name=${result.backupName}\nbackup_fingerprint=${result.fingerprint}\n`,
        );
    } else {
      result = await applyReleaseRecovery({
        ...common,
        backupArtifactId: options['backup-artifact-id'],
        backupFingerprint: options['backup-fingerprint'],
      });
    }
    console.log(JSON.stringify(result));
  } finally {
    await http.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
