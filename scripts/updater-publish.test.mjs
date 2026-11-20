import assert from 'node:assert/strict';
import test from 'node:test';
import { publishUpdater } from './publish-updater.mjs';
import { applyReleaseMetadata, releaseMetadata } from './updater-artifacts.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

function environment({ version = '0.4.0', failMirror = false, failGiteeCommit = false } = {}) {
  const signer = testSigner(),
    artifacts = testArtifacts(signer, version),
    release = testRelease(version);
  const calls = [],
    archives = {},
    manifests = {};
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
      readArtifacts: async (_release, _version, _publicKey, metadata) => {
        calls.push('read-assets');
        return metadata
          ? applyReleaseMetadata(
              metadata,
              artifacts,
              release.tag_name,
              options.releaseCommit,
              signer.publicKey,
            )
          : artifacts;
      },
      prepareArtifacts: async (_release, values) => {
        calls.push('preflight');
        return values;
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
      readRelease: async () => {
        calls.push('github-archive-read');
        return archives.github ?? null;
      },
      archiveRelease: async (metadata) => {
        calls.push('github-archive');
        archives.github ??= structuredClone(metadata);
        return archives.github;
      },
      publish: async (manifest) => {
        calls.push('github-latest');
        manifests.github = manifest;
        return { version: manifest.version };
      },
    },
    giteeStore: {
      ensureTag: async () => calls.push('gitee-tag'),
      archiveRelease: async (metadata) => {
        calls.push('gitee-archive');
        archives.gitee ??= structuredClone(metadata);
        return archives.gitee;
      },
      publish: async (manifest) => {
        calls.push('gitee-latest');
        if (failGiteeCommit) throw new Error('Gitee commit failed');
        manifests.gitee = manifest;
        return { version: manifest.version };
      },
    },
  };
  return { options, calls, release, artifacts, signer, archives, manifests };
}

test('both stores contain verified installers before either latest feed changes', async () => {
  const { options, calls } = environment();
  const result = await publishUpdater(options);
  assert.equal(result.status, 'published');
  assert.deepEqual(calls, [
    'github-archive-read',
    'preflight',
    'github-archive',
    'github-assets',
    'gitee-tag',
    'gitee-archive',
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
    assert.ok(env.calls.every((call) => call === 'github-archive-read'));
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
  assert.deepEqual(calls, [
    'github-archive-read',
    'read-assets',
    'preflight',
    'gitee-tag',
    'gitee-archive',
    'gitee-assets',
    'gitee-latest',
  ]);
});

test('a failed mirror can be repaired using published payloads and the archived signatures', async () => {
  const env = environment({ failMirror: true });
  await assert.rejects(publishUpdater(env.options), /Gitee quota/);
  assert.ok(env.archives.github);
  assert.equal(env.archives.github.artifacts.length, 4);
  assert.deepEqual(env.manifests, {});
  // Simulate a later run without local staging or public .sig attachments.
  delete env.options.localArtifacts;
  env.options.github.readArtifacts = async (_release, _version, publicKey, metadata) => {
    assert.deepEqual(metadata, env.archives.github);
    return applyReleaseMetadata(
      metadata,
      env.artifacts.map(({ name, bytes }) => ({ name, bytes })),
      env.release.tag_name,
      env.options.releaseCommit,
      publicKey,
    );
  };
  env.options.gitee.mirror = async (_release, values) =>
    Object.fromEntries(values.map(({ name }) => [name, `https://gitee.com/test/${name}`]));
  assert.equal((await publishUpdater(env.options)).status, 'published');
  assert.equal(env.manifests.github.version, '0.4.0');
  assert.equal(env.manifests.gitee.version, '0.4.0');
});

test('published-byte conflicts stop before immutable signature archives are written', async () => {
  const { options, calls } = environment();
  options.github.prepareArtifacts = async () => {
    throw new Error('Published attachment differs');
  };
  await assert.rejects(publishUpdater(options), /Published attachment differs/);
  assert.deepEqual(calls, ['github-archive-read']);
});

test('an archive failure prevents the corresponding host upload and both feed changes', async () => {
  for (const host of ['github', 'gitee']) {
    const { options, calls } = environment();
    options[`${host}Store`].archiveRelease = async () => {
      throw new Error('archive push failed');
    };
    await assert.rejects(publishUpdater(options), /archive push failed/);
    assert.ok(!calls.includes(`${host}-assets`));
    assert.ok(calls.every((call) => !call.endsWith('latest')));
    if (host === 'gitee') assert.ok(calls.includes('github-assets'));
  }
});

test('the winning archive signature is reverified and reused for uploads and both feeds', async () => {
  const env = environment();
  const resigned = env.artifacts.map((entry) => {
    const signature = env.signer.signature(entry.bytes, entry.name, '0.4.0', {
      comment: `timestamp:1800000000\tfile:${entry.name}\tversion:0.4.0`,
    });
    return { ...entry, signature, signatureBytes: Buffer.from(signature) };
  });
  const winner = releaseMetadata('v0.4.0', env.options.releaseCommit, resigned);
  env.options.githubStore.archiveRelease = async () => winner;
  env.options.github.publish = async (_release, values) => {
    assert.deepEqual(
      values.map(({ signature }) => signature),
      resigned.map(({ signature }) => signature),
    );
    return {
      artifacts: values,
      urls: Object.fromEntries(values.map(({ name }) => [name, `https://github.com/test/${name}`])),
    };
  };
  await publishUpdater(env.options);
  assert.equal(env.manifests.github.platforms['windows-x86_64'].signature, resigned[1].signature);
  assert.deepEqual(env.archives.gitee, winner);
  assert.equal(env.manifests.gitee.platforms['windows-x86_64'].signature, resigned[1].signature);
});

test('invalid archive identities and signatures never reach an attachment upload', async () => {
  for (const change of [
    (record) => {
      record.releaseCommit = 'b'.repeat(40);
    },
    (record) => {
      record.artifacts[0].sha256 = '0'.repeat(64);
    },
    (record) => {
      record.artifacts[0].signature = Buffer.from('invalid signature').toString('base64');
    },
  ]) {
    const env = environment();
    const metadata = releaseMetadata('v0.4.0', env.options.releaseCommit, env.artifacts);
    change(metadata);
    env.options.githubStore.archiveRelease = async () => metadata;
    await assert.rejects(publishUpdater(env.options));
    assert.ok(env.calls.every((call) => !call.endsWith('assets') && !call.endsWith('latest')));
  }
});

test('Gitee-only repairs never write a missing GitHub archive or advance the GitHub feed', async () => {
  const env = environment();
  delete env.options.localArtifacts;
  env.options.mirrorOnly = true;
  await publishUpdater(env.options);
  assert.equal(env.archives.github, undefined);
  assert.equal(env.manifests.github, undefined);
  assert.ok(env.archives.gitee);
  assert.equal(env.manifests.gitee.version, '0.4.0');
});
