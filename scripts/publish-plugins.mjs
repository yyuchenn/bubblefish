import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GithubReleaseApi,
  GiteeReleaseApi,
  ReleaseHttp,
  giteeAttachmentLimit,
  repositoryPath,
} from './updater-api.mjs';
import { releaseVersion, sha256 } from './updater-artifacts.mjs';
import { readReleaseSource, resolveGithubTag } from './release-source.mjs';

export const pluginPackageNames = Object.freeze([
  'deepseek-translation-plugin.bfplugin',
  'kha-white-ocr-plugin-web.bfplugin',
  'kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin',
  'kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin',
]);
const examplePackageNames = new Set([
  'example.document-toolbox.bfplugin',
  'example.history-inspector.bfplugin',
  'example.edit-guard.bfplugin',
]);

function validatePackageName(name) {
  assert.equal(typeof name, 'string', 'Expected a plugin package filename');
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.bfplugin$/, 'Unsafe plugin package filename');
  assert.ok(pluginPackageNames.includes(name), `Unexpected plugin package: ${name}`);
}

function validatePackageSize(name, size) {
  assert.ok(Number.isSafeInteger(size) && size > 0, `Empty or invalid plugin package: ${name}`);
  assert.ok(size <= giteeAttachmentLimit, `Gitee attachment exceeds 100 MB: ${name}`);
}

function validatePluginArtifacts(artifacts) {
  assert.ok(Array.isArray(artifacts), 'Expected plugin packages');
  const byName = new Map();
  for (const { name, bytes } of artifacts) {
    validatePackageName(name);
    assert.ok(!byName.has(name), `Duplicate plugin package: ${name}`);
    validatePackageSize(name, bytes?.length);
    assert.ok(
      Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
      'Expected plugin package bytes',
    );
    byName.set(name, { name, bytes });
  }
  return pluginPackageNames.filter((name) => byName.has(name)).map((name) => byName.get(name));
}

export async function readPluginArtifacts(directory) {
  const paths = new Map();
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // Downloading an empty set of Actions artifacts need not create a folder.
      // Only tolerate the missing root, not files disappearing while scanning.
      if (current === directory && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), 'Symbolic links are not supported in plugin artifacts');
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.bfplugin')) {
        if (examplePackageNames.has(entry.name)) continue;
        validatePackageName(entry.name);
        assert.ok(!paths.has(entry.name), `Duplicate plugin package: ${entry.name}`);
        validatePackageSize(entry.name, (await stat(path)).size);
        paths.set(entry.name, path);
      }
    }
  }
  await visit(directory);
  return validatePluginArtifacts(
    await Promise.all(
      pluginPackageNames
        .filter((name) => paths.has(name))
        .map(async (name) => ({ name, bytes: await readFile(paths.get(name)) })),
    ),
  );
}

export async function publishPlugins({
  tag,
  expectedVersion,
  artifacts,
  github,
  gitee,
  mirrorOnly = false,
}) {
  const version = releaseVersion(tag);
  assert.equal(version, expectedVersion, 'Release tag differs from the checked-out app version');
  let packages = artifacts === undefined ? undefined : validatePluginArtifacts(artifacts);
  const summary = (status) => ({
    status,
    version,
    packages: packages.map(({ name }) => name),
    missingPackages: pluginPackageNames.filter(
      (name) => !packages.some((entry) => entry.name === name),
    ),
  });
  if (packages?.length === 0) return summary('skipped');
  const release = await github.release(tag);
  assert.equal(release.tag_name, tag, 'GitHub release tag differs');
  assert.ok(!release.draft && release.published_at, 'Plugin assets require a published release');
  assert.ok(Number.isFinite(Date.parse(release.published_at)), 'Invalid release publication date');
  packages ??= validatePluginArtifacts(await github.readAssets(release, pluginPackageNames));
  if (packages.length === 0) return summary('skipped');
  if (mirrorOnly && artifacts !== undefined) {
    // A staged repair must mirror GitHub's published bytes just like a repair
    // without staging. Never introduce a different payload only on Gitee.
    const published = validatePluginArtifacts(
      await github.readAssets(
        release,
        packages.map(({ name }) => name),
      ),
    );
    for (const { name, bytes } of packages) {
      const canonical = published.find((entry) => entry.name === name);
      assert.ok(canonical, `Missing published GitHub plugin: ${name}`);
      assert.equal(sha256(bytes), sha256(canonical.bytes), `Published attachment differs: ${name}`);
    }
  }
  const githubUrls = mirrorOnly ? undefined : await github.uploadAssets(release, packages);
  const giteeUrls = await gitee.mirror(release, packages);
  return {
    ...summary('published'),
    ...(mirrorOnly ? {} : { github: githubUrls }),
    gitee: giteeUrls,
  };
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
  assert.ok(
    tag,
    'Usage: publish-plugins.mjs --tag <published-tag> [--source <directory>] [--artifacts <directory>] [--mirror-only]',
  );
  releaseVersion(tag);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const giteeRepository = repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish');
  const source = await readReleaseSource(resolve(sourceDirectory ?? root), tag);
  const http = new ReleaseHttp();
  try {
    const github = new GithubReleaseApi({ repository, token: process.env.GITHUB_TOKEN, http });
    const gitee = new GiteeReleaseApi({
      repository: giteeRepository,
      token: process.env.GITEE_TOKEN,
      http,
    });
    assert.equal(
      await resolveGithubTag(github, tag),
      source.releaseCommit,
      `Release tag moved: ${tag}; source commit ${source.releaseCommit}`,
    );
    const result = await publishPlugins({
      tag,
      expectedVersion: source.version,
      artifacts: directory ? await readPluginArtifacts(resolve(directory)) : undefined,
      github,
      gitee,
      mirrorOnly,
    });
    console.log(JSON.stringify(result));
  } finally {
    await http.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // HTTP errors already contain safe context; never dump requests or credentials.
    console.error(error.message);
    process.exitCode = 1;
  });
