import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GithubReleaseApi, GiteeReleaseApi, ReleaseHttp, repositoryPath } from './updater-api.mjs';
import { GitUpdaterStore } from './updater-git.mjs';
import { assertReleaseIdentity, readReleaseSource } from './release-source.mjs';
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
    sourceDirectory,
    mirrorOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--tag') tag = args[++index];
    else if (args[index] === '--artifacts') {
      directory = args[++index];
      assert.ok(directory && !directory.startsWith('--'), '--artifacts requires a directory');
    } else if (args[index] === '--source') {
      sourceDirectory = args[++index];
      assert.ok(
        sourceDirectory && !sourceDirectory.startsWith('--'),
        '--source requires a directory',
      );
    } else if (args[index] === '--mirror-only') mirrorOnly = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const giteeRepository = repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish');
  assert.ok(
    tag,
    'Usage: publish-updater.mjs --tag <published-tag> [--source <directory>] [--artifacts <directory>] [--mirror-only]',
  );
  releaseVersion(tag);
  const source = await readReleaseSource(resolve(sourceDirectory ?? root), tag);
  const http = new ReleaseHttp();
  try {
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
    await assertReleaseIdentity({ tag, source, github, githubStore, giteeStore });
    const localArtifacts = directory
      ? await readLocalArtifacts(resolve(directory), source.version, source.publicKey)
      : undefined;
    const result = await publishUpdater({
      tag,
      publicKey: source.publicKey,
      expectedVersion: source.version,
      localArtifacts,
      github,
      gitee,
      githubStore,
      giteeStore,
      releaseCommit: source.releaseCommit,
      mirrorOnly,
    });
    console.log(JSON.stringify(result));
  } finally {
    await http.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // Do not dump request objects, environments or credentials on failures.
    console.error(error.message);
    process.exitCode = 1;
  });
