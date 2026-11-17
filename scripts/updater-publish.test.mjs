import assert from 'node:assert/strict';
import test from 'node:test';
import { publishUpdater } from './publish-updater.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

function environment({ version = '0.4.0', failMirror = false, failGiteeCommit = false } = {}) {
  const signer = testSigner(),
    artifacts = testArtifacts(signer, version),
    release = testRelease(version);
  const calls = [];
  const urls = (host) =>
    Object.fromEntries(artifacts.map(({ name }) => [name, `https://${host}/test/${name}`]));
  const options = {
    tag: release.tag_name,
    sourceDirectory: '/source',
    publicKey: signer.publicKey,
    expectedVersion: version,
    localArtifacts: artifacts,
    releaseCommit: 'a'.repeat(40),
    github: {
      release: async () => release,
      readArtifacts: async () => {
        calls.push('read-assets');
        return artifacts;
      },
      publish: async (_release, values) => {
        calls.push('github-assets');
        return { artifacts: values, urls: urls('github.com') };
      },
    },
    gitee: {
      mirror: async () => {
        calls.push('gitee-assets');
        if (failMirror) throw new Error('Gitee quota or download failure');
        return urls('gitee.com');
      },
    },
    githubStore: {
      publish: async (manifest) => {
        calls.push('github-latest');
        return { version: manifest.version };
      },
    },
    giteeStore: {
      ensureTag: async () => calls.push('gitee-tag'),
      publish: async (manifest) => {
        calls.push('gitee-latest');
        if (failGiteeCommit) throw new Error('Gitee commit failed');
        return { version: manifest.version };
      },
    },
  };
  return { options, calls, release, artifacts };
}

test('both stores contain verified installers before either latest feed changes', async () => {
  const { options, calls } = environment();
  const result = await publishUpdater(options);
  assert.equal(result.status, 'published');
  assert.deepEqual(calls, [
    'github-assets',
    'gitee-tag',
    'gitee-assets',
    'github-latest',
    'gitee-latest',
  ]);
});

test('bad signatures, incomplete platforms, tag mismatch and draft releases block publication', async () => {
  for (const change of [
    (env) => {
      env.options.localArtifacts = env.artifacts.slice(1);
    },
    (env) => {
      env.artifacts[0].bytes = Buffer.from('modified after signing');
    },
    (env) => {
      env.options.tag = 'v0.5.0';
    },
    (env) => {
      env.release.draft = true;
    },
  ]) {
    const env = environment();
    change(env);
    await assert.rejects(publishUpdater(env.options));
    assert.deepEqual(env.calls, []);
  }
});

test('mirror failure leaves both feeds untouched; a failed second commit never rolls back the first', async () => {
  const mirror = environment({ failMirror: true });
  await assert.rejects(publishUpdater(mirror.options), /Gitee quota/);
  assert.ok(mirror.calls.every((call) => !call.endsWith('latest')));
  const commit = environment({ failGiteeCommit: true });
  await assert.rejects(publishUpdater(commit.options), /Gitee commit/);
  assert.deepEqual(commit.calls.slice(-2), ['github-latest', 'gitee-latest']);
});

test('prereleases can be signed and mirrored without moving the stable feed', async () => {
  const { options, calls } = environment({ version: '0.5.0-beta.1' });
  assert.equal((await publishUpdater(options)).status, 'prerelease');
  assert.ok(calls.includes('gitee-assets'));
  assert.ok(calls.every((call) => !call.endsWith('latest')));
});

test('manual Gitee repair reads existing signed release assets without publishing to GitHub', async () => {
  const { options, calls } = environment();
  delete options.localArtifacts;
  options.mirrorOnly = true;
  await publishUpdater(options);
  assert.deepEqual(calls, ['read-assets', 'gitee-tag', 'gitee-assets', 'gitee-latest']);
});
