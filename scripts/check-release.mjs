import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GithubReleaseApi, ReleaseHttp, repositoryPath } from './updater-api.mjs';
import { GitUpdaterStore } from './updater-git.mjs';
import { releaseVersion } from './updater-artifacts.mjs';
import {
  assertReleaseIdentity,
  readReleaseSource,
  resolveGithubTag,
  verifyArtifactRun,
} from './release-source.mjs';

export function parseCheckReleaseArgs(args) {
  const options = { resolveOnly: false };
  const values = new Map([
    ['--tag', 'tag'],
    ['--source', 'sourceDirectory'],
    ['--allow-archived-commit', 'allowArchivedCommit'],
    ['--artifact-run-id', 'artifactRunId'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--resolve-only') options.resolveOnly = true;
    else if (values.has(arg)) {
      const value = args[++index];
      assert.ok(value && !value.startsWith('--'), `${arg} requires a value`);
      options[values.get(arg)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  assert.ok(
    options.tag,
    'Usage: check-release.mjs --tag <tag> [--source <directory>] [--artifact-run-id <id>] [--allow-archived-commit <sha>] [--resolve-only]',
  );
  releaseVersion(options.tag);
  assert.ok(
    !options.resolveOnly ||
      (!options.sourceDirectory && !options.allowArchivedCommit && !options.artifactRunId),
    '--resolve-only cannot perform source, archive or artifact preflight checks',
  );
  return options;
}

export async function checkRelease({
  tag,
  sourceDirectory,
  allowArchivedCommit,
  artifactRunId,
  resolveOnly = false,
  github,
  githubStore,
  giteeStore,
}) {
  if (resolveOnly)
    return { status: 'resolved', tag, releaseCommit: await resolveGithubTag(github, tag) };
  const source = await readReleaseSource(sourceDirectory, tag);
  const archives = await assertReleaseIdentity({
    tag,
    source,
    github,
    githubStore,
    giteeStore,
    allowArchivedCommit,
  });
  if (artifactRunId !== undefined)
    artifactRunId = await verifyArtifactRun(github, artifactRunId, source.releaseCommit);
  return {
    status: 'verified',
    tag,
    version: source.version,
    releaseCommit: source.releaseCommit,
    ...(artifactRunId === undefined ? {} : { artifactRunId }),
    archives: {
      github: archives.github?.releaseCommit ?? null,
      gitee: archives.gitee?.releaseCommit ?? null,
    },
  };
}

async function main() {
  const options = parseCheckReleaseArgs(process.argv.slice(2));
  const repository = repositoryPath(process.env.GITHUB_REPOSITORY);
  const http = new ReleaseHttp();
  try {
    const github = new GithubReleaseApi({ repository, token: process.env.GITHUB_TOKEN, http });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const stores = options.resolveOnly
      ? {}
      : {
          githubStore: new GitUpdaterStore({
            remote: `https://github.com/${repository}.git`,
            token: process.env.GITHUB_TOKEN,
          }),
          giteeStore: new GitUpdaterStore({
            remote: `https://gitee.com/${repositoryPath(process.env.GITEE_REPOSITORY || 'yyuchenn/bubblefish')}.git`,
            token: process.env.GITEE_TOKEN,
            username: 'oauth2',
          }),
        };
    const result = await checkRelease({
      ...options,
      sourceDirectory: options.sourceDirectory ?? root,
      github,
      ...stores,
    });
    if (process.env.GITHUB_OUTPUT) {
      let output = `release_commit=${result.releaseCommit}\n`;
      if (result.artifactRunId !== undefined) output += `artifact_run_id=${result.artifactRunId}\n`;
      await appendFile(process.env.GITHUB_OUTPUT, output);
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
