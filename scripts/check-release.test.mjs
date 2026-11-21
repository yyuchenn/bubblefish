import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRelease, parseCheckReleaseArgs } from './check-release.mjs';

test('parses release source, artifact and read-only recovery preflight options', () => {
  assert.deepEqual(
    parseCheckReleaseArgs([
      '--tag',
      'v0.4.0',
      '--source',
      '/release/source',
      '--artifact-run-id',
      '44687676350',
      '--allow-archived-commit',
      'a'.repeat(40),
    ]),
    {
      resolveOnly: false,
      tag: 'v0.4.0',
      sourceDirectory: '/release/source',
      artifactRunId: '44687676350',
      allowArchivedCommit: 'a'.repeat(40),
    },
  );
  assert.deepEqual(parseCheckReleaseArgs(['--tag', 'v0.4.0', '--resolve-only']), {
    resolveOnly: true,
    tag: 'v0.4.0',
  });
});

test('requires explicit argument values and prevents resolve-only from masking full checks', () => {
  for (const args of [
    [],
    ['--tag'],
    ['--tag', 'v0.4.0', '--source'],
    ['--tag', 'v0.4.0', '--artifact-run-id'],
    ['--tag', 'v0.4.0', '--allow-archived-commit'],
    ['--tag', 'v0.4.0', '--unknown'],
    ['--tag', 'v0.4.0', '--source', '--resolve-only'],
    ['--tag', 'v0.4.0', '--resolve-only', '--source', '/release'],
    ['--tag', 'v0.4.0', '--resolve-only', '--artifact-run-id', '123'],
    ['--tag', 'v0.4.0', '--resolve-only', '--allow-archived-commit', 'a'.repeat(40)],
  ])
    assert.throws(() => parseCheckReleaseArgs(args));
});

test('resolve-only works before a release source checkout or either metadata store exists', async () => {
  const releaseCommit = 'a'.repeat(40),
    calls = [];
  const result = await checkRelease({
    tag: 'v0.4.0',
    resolveOnly: true,
    sourceDirectory: '/does-not-exist',
    github: {
      json: async (path, options) => {
        calls.push(path);
        assert.equal(options, undefined);
        return { object: { type: 'commit', sha: releaseCommit } };
      },
    },
  });
  assert.deepEqual(result, { status: 'resolved', tag: 'v0.4.0', releaseCommit });
  assert.deepEqual(calls, ['/git/ref/tags/v0.4.0']);
});
