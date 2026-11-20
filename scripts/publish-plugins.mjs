import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GithubReleaseApi,
  GiteeReleaseApi,
  giteeAttachmentLimit,
  repositoryPath,
} from './updater-api.mjs';
import { releaseVersion } from './updater-artifacts.mjs';

export const pluginPackageNames = Object.freeze([
  'deepseek-translation-plugin.bfplugin',
  'example.document-toolbox.bfplugin',
  'example.history-inspector.bfplugin',
  'example.edit-guard.bfplugin',
  'kha-white-ocr-plugin-web.bfplugin',
  'kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin',
  'kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin',
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
  return pluginPackageNames.map((name) => {
    assert.ok(byName.has(name), `Missing plugin package: ${name}`);
    return byName.get(name);
  });
}

export async function readPluginArtifacts(directory) {
  const paths = new Map();
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Symbolic links are not supported in plugin artifacts');
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.bfplugin')) {
        validatePackageName(entry.name);
        assert.ok(!paths.has(entry.name), `Duplicate plugin package: ${entry.name}`);
        validatePackageSize(entry.name, (await stat(path)).size);
        paths.set(entry.name, path);
      }
    }
  }
  await visit(directory);
  // Check the complete build output before reading or publishing any package.
  for (const name of pluginPackageNames)
    assert.ok(paths.has(name), `Missing plugin package: ${name}`);
  return validatePluginArtifacts(
    await Promise.all(
      pluginPackageNames.map(async (name) => ({ name, bytes: await readFile(paths.get(name)) })),
    ),
  );
}

export async function publishPlugins({ tag, expectedVersion, artifacts, github, gitee }) {
  const version = releaseVersion(tag);
  assert.equal(version, expectedVersion, 'Release tag differs from the checked-out app version');
  const packages = validatePluginArtifacts(artifacts);
  const release = await github.release(tag);
  assert.equal(release.tag_name, tag, 'GitHub release tag differs');
  assert.ok(!release.draft && release.published_at, 'Plugin assets require a published release');
  assert.ok(Number.isFinite(Date.parse(release.published_at)), 'Invalid release publication date');
  const githubUrls = await github.uploadAssets(release, packages);
  const giteeUrls = await gitee.mirror(release, packages);
  return {
    status: 'published',
    version,
    packages: packages.map(({ name }) => name),
    github: githubUrls,
    gitee: giteeUrls,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let tag, directory;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--tag') tag = args[++index];
    else if (args[index] === '--artifacts') directory = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  assert.ok(
    tag && directory,
    'Usage: publish-plugins.mjs --tag <published-tag> --artifacts <directory>',
  );
  releaseVersion(tag);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const giteeRepository = repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.version, manifest.version, 'Tauri and npm versions differ');
  const github = new GithubReleaseApi({ repository, token: process.env.GITHUB_TOKEN });
  const gitee = new GiteeReleaseApi({
    repository: giteeRepository,
    token: process.env.GITEE_TOKEN,
  });
  const result = await publishPlugins({
    tag,
    expectedVersion: manifest.version,
    artifacts: await readPluginArtifacts(resolve(directory)),
    github,
    gitee,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // HTTP errors already contain safe context; never dump requests or credentials.
    console.error(error.message);
    process.exitCode = 1;
  });
