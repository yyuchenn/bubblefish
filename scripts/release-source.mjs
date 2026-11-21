import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { releaseVersion, validateReleaseMetadata } from './updater-artifacts.mjs';

const execute = promisify(execFile);
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const desktopWorkflowPath = '.github/workflows/build-desktop.yml';
const desktopOutputs = [
  { job: 'Windows x64 installers', artifact: 'bubblefish-windows-x64' },
  { job: 'macOS ARM64 installer', artifact: 'bubblefish-macos-arm64' },
];

export async function readReleaseSource(directory, tag, { run = execute } = {}) {
  const version = releaseVersion(tag);
  directory = resolve(directory);
  const [manifestText, configText, { stdout }] = await Promise.all([
    readFile(resolve(directory, 'package.json'), 'utf8'),
    readFile(resolve(directory, 'src-tauri/tauri.conf.json'), 'utf8'),
    run('git', ['rev-parse', 'HEAD', `refs/tags/${tag}^{commit}`], { cwd: directory }),
  ]);
  const manifest = JSON.parse(manifestText),
    config = JSON.parse(configText);
  assert.equal(config.version, manifest.version, 'Tauri and npm versions differ');
  assert.equal(manifest.version, version, 'Release tag differs from the source app version');
  const publicKey = config.plugins?.updater?.pubkey;
  assert.ok(typeof publicKey === 'string' && publicKey.trim(), 'Missing updater public key');
  const [releaseCommit, tagCommit] = stdout.trim().split(/\s+/);
  assert.match(releaseCommit ?? '', commitPattern, 'Invalid release source HEAD');
  assert.match(tagCommit ?? '', commitPattern, 'Invalid local release tag commit');
  assert.equal(
    releaseCommit,
    tagCommit,
    `Release source ${tag} has HEAD ${releaseCommit} but local tag resolves to ${tagCommit}; check out the release tag`,
  );
  return { directory, version, publicKey, releaseCommit };
}

export async function resolveGithubTag(github, tag) {
  releaseVersion(tag);
  let { object } = await github.json(`/git/ref/tags/${encodeURIComponent(tag)}`);
  const visited = new Set();
  for (let depth = 0; depth < 10; depth++) {
    assert.match(object?.sha ?? '', commitPattern, 'Invalid GitHub release tag object');
    if (object.type === 'commit') return object.sha;
    assert.equal(object.type, 'tag', 'GitHub release tag must resolve to a commit');
    assert.ok(!visited.has(object.sha), 'GitHub release tag contains a cycle');
    visited.add(object.sha);
    ({ object } = await github.json(`/git/tags/${object.sha}`));
  }
  throw new Error('GitHub release tag exceeds the supported annotation depth');
}

export async function assertReleaseIdentity({
  tag,
  source,
  github,
  githubStore,
  giteeStore,
  allowArchivedCommit,
}) {
  releaseVersion(tag);
  assert.match(source.releaseCommit ?? '', commitPattern, 'Invalid release source commit');
  if (allowArchivedCommit !== undefined)
    assert.match(allowArchivedCommit, commitPattern, 'Invalid allowed archived commit');
  const liveCommit = await resolveGithubTag(github, tag);
  assert.equal(
    liveCommit,
    source.releaseCommit,
    `GitHub tag ${tag} moved: current=${liveCommit}, source HEAD=${source.releaseCommit}; resolve and check out the release again`,
  );
  const [githubArchive, giteeArchive] = await Promise.all([
    githubStore.readRelease(tag),
    giteeStore.readRelease(tag),
  ]);
  for (const [host, archive] of [
    ['GitHub', githubArchive],
    ['Gitee', giteeArchive],
  ]) {
    if (!archive) continue;
    validateReleaseMetadata(archive, tag);
    if (archive.releaseCommit === allowArchivedCommit) continue;
    assert.equal(
      archive.releaseCommit,
      source.releaseCommit,
      `${host} updater/releases/${tag}.json records commit ${archive.releaseCommit}, requested commit/source HEAD=${source.releaseCommit}; reuse the original release or complete an audited reset of this unfinished version`,
    );
  }
  return { github: githubArchive ?? null, gitee: giteeArchive ?? null };
}

async function actionEntries(github, path, key) {
  const entries = [];
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await github.json(`${path}${separator}per_page=100&page=${page}`);
    assert.ok(Array.isArray(response?.[key]), `Expected GitHub Actions ${key}`);
    entries.push(...response[key]);
    if (response[key].length < 100) return entries;
  }
}

export async function verifyArtifactRun(github, runId, sourceCommit) {
  assert.ok(
    typeof runId === 'string' || (Number.isSafeInteger(runId) && runId > 0),
    'Expected a GitHub Actions artifact run ID',
  );
  runId = String(runId);
  assert.match(runId, /^[1-9]\d*$/, 'Expected a GitHub Actions artifact run ID');
  assert.match(sourceCommit, commitPattern, 'Invalid artifact source commit');
  const path = `/actions/runs/${runId}`;
  const run = await github.json(path);
  assert.equal(String(run.id), runId, 'GitHub returned a different artifact run');
  assert.equal(
    run.repository?.full_name,
    github.repository,
    'Artifact run belongs to another repository',
  );
  assert.equal(
    run.path,
    desktopWorkflowPath,
    'Artifacts must come from the desktop build workflow',
  );
  assert.equal(run.event, 'release', 'Desktop artifacts must come from a signed release build');
  assert.equal(
    run.head_sha,
    sourceCommit,
    `Artifact run ${runId} source ${run.head_sha} differs from release source ${sourceCommit}`,
  );
  assert.equal(run.status, 'completed', 'Artifact run has not completed');
  // A failed publish job must not prevent reuse of successful signed builds.
  const [jobs, artifacts] = await Promise.all([
    actionEntries(github, `${path}/jobs?filter=latest`, 'jobs'),
    actionEntries(github, `${path}/artifacts`, 'artifacts'),
  ]);
  for (const expected of desktopOutputs) {
    const matchingJobs = jobs.filter(({ name }) => name === expected.job);
    assert.equal(matchingJobs.length, 1, `Expected one desktop build job: ${expected.job}`);
    assert.equal(
      matchingJobs[0].status,
      'completed',
      `Desktop build job is incomplete: ${expected.job}`,
    );
    assert.equal(
      matchingJobs[0].conclusion,
      'success',
      `Desktop build job failed: ${expected.job}`,
    );
    const matchingArtifacts = artifacts.filter(({ name }) => name === expected.artifact);
    assert.equal(
      matchingArtifacts.length,
      1,
      `Expected one desktop artifact: ${expected.artifact}`,
    );
    assert.equal(
      matchingArtifacts[0].expired,
      false,
      `Desktop artifact expired: ${expected.artifact}`,
    );
    const artifact = matchingArtifacts[0];
    if (artifact.workflow_run?.head_sha !== undefined)
      assert.equal(
        artifact.workflow_run.head_sha,
        sourceCommit,
        `Desktop artifact source differs: ${expected.artifact}`,
      );
    if (artifact.expires_at !== undefined) {
      const expiresAt = Date.parse(artifact.expires_at);
      assert.ok(
        Number.isFinite(expiresAt) && expiresAt > Date.now(),
        `Desktop artifact expired or has an invalid expiry: ${expected.artifact}`,
      );
    }
    assert.ok(
      Number.isSafeInteger(matchingArtifacts[0].size_in_bytes) &&
        matchingArtifacts[0].size_in_bytes > 0,
      `Desktop artifact is empty: ${expected.artifact}`,
    );
  }
  return runId;
}
