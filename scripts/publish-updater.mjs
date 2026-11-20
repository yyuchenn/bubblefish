import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GithubReleaseApi, GiteeReleaseApi, repositoryPath } from './updater-api.mjs';
import { GitUpdaterStore } from './updater-git.mjs';
import {
  applyReleaseMetadata,
  readLocalArtifacts,
  releaseMetadata,
  releaseVersion,
  updateManifest,
  verifyArtifacts,
  validateReleaseMetadata,
} from './updater-artifacts.mjs';

export async function publishUpdater({
  tag,
  publicKey,
  expectedVersion,
  localArtifacts,
  github,
  gitee,
  githubStore,
  giteeStore,
  releaseCommit,
  mirrorOnly = false,
}) {
  const version = releaseVersion(tag);
  assert.equal(version, expectedVersion, 'Release tag differs from the checked-out app version');
  const release = await github.release(tag);
  assert.equal(release.tag_name, tag, 'GitHub release tag differs');
  assert.ok(!release.draft && release.published_at, 'Updater assets require a published release');
  assert.ok(Number.isFinite(Date.parse(release.published_at)), 'Invalid release publication date');
  const archived = await githubStore.readRelease(tag);
  if (archived) validateReleaseMetadata(archived, tag, releaseCommit);
  const loaded =
    localArtifacts ?? (await github.readArtifacts(release, version, publicKey, archived));
  let source = verifyArtifacts(
    loaded.flatMap((entry) => [entry, { name: `${entry.name}.sig`, bytes: entry.signatureBytes }]),
    version,
    publicKey,
  );
  if (archived) source = applyReleaseMetadata(archived, source, tag, releaseCommit, publicKey);
  // Preflight every existing installer before archiving immutable signatures.
  // Legacy releases may still provide .sig attachments; new releases do not.
  source = await github.prepareArtifacts(release, source, version, publicKey, archived);
  const proposed = releaseMetadata(tag, releaseCommit, source);
  const canonical = mirrorOnly
    ? (archived ?? proposed)
    : await githubStore.archiveRelease(proposed);
  // Another writer may have archived an earlier valid signature for identical
  // bytes. Always verify and use the record that actually won the Git push.
  source = applyReleaseMetadata(canonical, source, tag, releaseCommit, publicKey);
  const published = mirrorOnly
    ? { artifacts: source }
    : await github.publish(release, source, version, publicKey);
  // Gitee stores updater metadata and downloads, not the GitHub source tree.
  // releaseCommit remains GitHub provenance inside the mirrored archive.
  const mirroredMetadata = await giteeStore.archiveRelease(canonical);
  const mirroredArtifacts = applyReleaseMetadata(
    mirroredMetadata,
    published.artifacts,
    tag,
    releaseCommit,
    publicKey,
  );
  const mirroredUrls = await gitee.mirror(release, mirroredArtifacts);
  if (release.prerelease || version.includes('-')) return { status: 'prerelease', version };
  const giteeManifest = updateManifest(release, mirroredArtifacts, mirroredUrls);
  let githubResult;
  if (!mirrorOnly) {
    const manifest = updateManifest(release, published.artifacts, published.urls);
    githubResult = await githubStore.publish(manifest);
  }
  // Cross-host atomic commits are impossible. A failed second push leaves a
  // complete GitHub release and the previous valid Gitee feed. Repair by tag.
  const giteeResult = await giteeStore.publish(giteeManifest);
  return { status: 'published', version, github: githubResult, gitee: giteeResult };
}

async function main() {
  const args = process.argv.slice(2);
  let tag,
    directory,
    mirrorOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--tag') tag = args[++index];
    else if (args[index] === '--artifacts') directory = args[++index];
    else if (args[index] === '--mirror-only') mirrorOnly = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const giteeRepository = repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.version, manifest.version, 'Tauri and npm versions differ');
  const publicKey = config.plugins?.updater?.pubkey;
  assert.ok(publicKey, 'Missing updater public key');
  assert.ok(
    tag,
    'Usage: publish-updater.mjs --tag <published-tag> [--artifacts <directory>] [--mirror-only]',
  );
  releaseVersion(tag);
  const github = new GithubReleaseApi({ repository, token: process.env.GITHUB_TOKEN });
  const gitee = new GiteeReleaseApi({
    repository: giteeRepository,
    token: process.env.GITEE_TOKEN,
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
  const { stdout } = await promisify(execFile)('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
    cwd: root,
  });
  const localArtifacts = directory
    ? await readLocalArtifacts(resolve(directory), releaseVersion(tag), publicKey)
    : undefined;
  const result = await publishUpdater({
    tag,
    publicKey,
    expectedVersion: manifest.version,
    localArtifacts,
    github,
    gitee,
    githubStore,
    giteeStore,
    releaseCommit: stdout.trim(),
    mirrorOnly,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // Do not dump request objects, environments or credentials on failures.
    console.error(error.message);
    process.exitCode = 1;
  });
