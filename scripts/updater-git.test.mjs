import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitUpdaterStore, gitEnvironment } from './updater-git.mjs';
import { releaseMetadata } from './updater-artifacts.mjs';
import { testArtifacts, testSigner } from './updater-test-helpers.mjs';

const run = promisify(execFile);
async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-git-test-'));
  const remote = join(directory, 'remote.git');
  await run('git', ['init', '--quiet', '--bare', remote]);
  try {
    await operation({ directory, remote, store: new GitUpdaterStore({ remote }) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const manifest = (version) => ({ version, notes: `Release ${version}`, platforms: {} });
function archiveFixture(version = '0.4.0') {
  const signer = testSigner();
  const artifacts = testArtifacts(signer, version);
  return {
    signer,
    artifacts,
    metadata: releaseMetadata(`v${version}`, 'a'.repeat(40), artifacts),
  };
}

async function addRemoteFile(store, path, content) {
  await store.withCheckout(async (directory) => {
    await mkdir(join(directory, 'releases'), { recursive: true });
    await writeFile(join(directory, path), content);
    await store.git(directory, ['add', '--', path]);
    await store.git(directory, ['commit', '--quiet', '-m', 'Add test file']);
    await store.git(directory, ['push', '--quiet', 'origin', 'HEAD:refs/heads/updater']);
  });
}

test('release archives create a missing branch without publishing latest and preserve original signatures', async () => {
  await fixture(async ({ store, remote }) => {
    const { metadata, artifacts, signer } = archiveFixture();
    assert.equal(await store.readRelease(metadata.tag), null);
    assert.deepEqual(await store.archiveRelease(metadata), metadata);
    assert.deepEqual(await store.readRelease(metadata.tag), metadata);
    assert.equal(await store.readLatest(), null);
    const resigned = {
      ...metadata,
      artifacts: [...metadata.artifacts].reverse().map((entry) => {
        const artifact = artifacts.find(({ name }) => name === entry.name);
        return {
          ...entry,
          signature: signer.signature(artifact.bytes, entry.name, metadata.version, {
            comment: `timestamp:1800000000\tfile:${entry.name}\tversion:${metadata.version}`,
          }),
        };
      }),
    };
    assert.notEqual(resigned.artifacts[0].signature, metadata.artifacts[3].signature);
    assert.deepEqual(await store.archiveRelease(resigned), metadata);
    for (const conflicting of [
      { ...metadata, releaseCommit: 'b'.repeat(40) },
      {
        ...metadata,
        artifacts: metadata.artifacts.map((entry, index) =>
          index === 0 ? { ...entry, sha256: 'f'.repeat(64) } : entry,
        ),
      },
      {
        ...metadata,
        artifacts: metadata.artifacts.map((entry, index) =>
          index === 0 ? { ...entry, name: entry.name.replace('en-US', 'fr-FR') } : entry,
        ),
      },
    ]) {
      await assert.rejects(store.archiveRelease(conflicting), /Release archive differs/);
    }
    assert.deepEqual(await store.readRelease(metadata.tag), metadata);
    const count = await run('git', ['--git-dir', remote, 'rev-list', '--count', 'updater']);
    assert.equal(count.stdout.trim(), '1');
  });
});

test('old and prerelease archives coexist with latest and unrelated updater files', async () => {
  await fixture(async ({ store, remote }) => {
    await store.publish(manifest('0.5.0'));
    await addRemoteFile(store, 'KEEP.txt', 'Keep updater branch content.');
    const older = archiveFixture('0.4.0').metadata;
    const prerelease = archiveFixture('0.6.0-beta.1').metadata;
    await store.archiveRelease(older);
    await store.archiveRelease(prerelease);
    assert.equal((await store.readLatest()).version, '0.5.0');
    assert.deepEqual(await store.readRelease(older.tag), older);
    assert.deepEqual(await store.readRelease(prerelease.tag), prerelease);
    await store.publish(manifest('0.7.0'));
    assert.deepEqual(await store.readRelease(older.tag), older);
    assert.deepEqual(await store.readRelease(prerelease.tag), prerelease);
    const keep = await run('git', ['--git-dir', remote, 'show', 'updater:KEEP.txt']);
    assert.equal(keep.stdout, 'Keep updater branch content.');
  });
});

test('concurrent first archive creation adopts the winning signatures without force pushing', async () => {
  await fixture(async ({ store, remote }) => {
    const { metadata, artifacts, signer } = archiveFixture();
    const winner = {
      ...metadata,
      artifacts: metadata.artifacts.map((entry, index) => ({
        ...entry,
        signature: signer.signature(artifacts[index].bytes, entry.name, metadata.version, {
          comment: `timestamp:1800000000\tfile:${entry.name}\tversion:${metadata.version}`,
        }),
      })),
    };
    let raced = false;
    const concurrent = new GitUpdaterStore({
      remote,
      run: async (binary, args, options) => {
        assert.ok(!args.includes('--force'));
        if (!raced && args[0] === 'push') {
          raced = true;
          await store.archiveRelease(winner);
        }
        return run(binary, args, options);
      },
    });
    assert.deepEqual(await concurrent.archiveRelease(metadata), winner);
    assert.deepEqual(await store.readRelease(metadata.tag), winner);
    assert.equal(await store.readLatest(), null);
    const count = await run('git', ['--git-dir', remote, 'rev-list', '--count', 'updater']);
    assert.equal(count.stdout.trim(), '1');
  });
});

test('archive retries preserve concurrent files, other archives and a newer current manifest', async () => {
  await fixture(async ({ store, remote }) => {
    await store.publish(manifest('0.3.0'));
    const metadata = archiveFixture().metadata;
    const other = archiveFixture('0.5.0').metadata;
    let raced = false;
    const concurrent = new GitUpdaterStore({
      remote,
      run: async (binary, args, options) => {
        if (!raced && args[0] === 'push') {
          raced = true;
          await store.publish(manifest('0.5.0'));
          await store.archiveRelease(other);
          await addRemoteFile(store, 'KEEP.txt', 'Concurrent data.');
        }
        return run(binary, args, options);
      },
    });
    assert.deepEqual(await concurrent.archiveRelease(metadata), metadata);
    assert.deepEqual(await store.readRelease(other.tag), other);
    assert.equal((await store.readLatest()).version, '0.5.0');
    const keep = await run('git', ['--git-dir', remote, 'show', 'updater:KEEP.txt']);
    assert.equal(keep.stdout, 'Concurrent data.');
  });
});

test('invalid archived metadata is preserved and does not depend on latest being valid', async () => {
  await fixture(async ({ store, remote }) => {
    const { metadata } = archiveFixture();
    await store.publish(manifest('0.3.0'));
    await addRemoteFile(store, 'latest.json', 'invalid latest JSON');
    assert.deepEqual(await store.archiveRelease(metadata), metadata);
    await addRemoteFile(store, `releases/${metadata.tag}.json`, 'invalid archive JSON');
    await assert.rejects(store.readRelease(metadata.tag), SyntaxError);
    await assert.rejects(store.archiveRelease(metadata), SyntaxError);
    const archived = await run('git', [
      '--git-dir',
      remote,
      'show',
      `updater:releases/${metadata.tag}.json`,
    ]);
    assert.equal(archived.stdout, 'invalid archive JSON');
  });
});

test('creates a missing updater branch, preserves history and refuses stable downgrades', async () => {
  await fixture(async ({ store, remote, directory }) => {
    assert.equal(await store.readLatest(), null);
    assert.equal((await store.publish(manifest('0.4.0'))).status, 'updated');
    assert.equal((await store.publish(manifest('0.4.0'))).status, 'unchanged');
    const checkout = join(directory, 'extra');
    await run('git', ['clone', '--quiet', '--branch', 'updater', remote, checkout]);
    await run('git', ['config', 'user.name', 'Test'], { cwd: checkout });
    await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: checkout });
    await writeFile(join(checkout, 'KEEP.txt'), 'Historical updater files stay intact.');
    await run('git', ['add', 'KEEP.txt'], { cwd: checkout });
    await run('git', ['commit', '--quiet', '-m', 'Keep historical file'], { cwd: checkout });
    await run('git', ['push', '--quiet'], { cwd: checkout });
    assert.equal((await store.publish(manifest('0.5.0'))).status, 'updated');
    assert.deepEqual(await store.publish(manifest('0.4.9')), { status: 'newer', version: '0.5.0' });
    const { stdout } = await run('git', ['--git-dir', remote, 'show', 'updater:KEEP.txt']);
    assert.equal(stdout, 'Historical updater files stay intact.');
    const count = await run('git', ['--git-dir', remote, 'rev-list', '--count', 'updater']);
    assert.equal(count.stdout.trim(), '3');
    assert.throws(() => store.publish(manifest('0.6.0-beta.1')), /Prereleases/);
  });
});

test('a concurrent newer publication wins even when an older job started first', async () => {
  await fixture(async ({ remote, store }) => {
    await store.publish(manifest('0.3.0'));
    let raced = false;
    const older = new GitUpdaterStore({
      remote,
      run: async (binary, args, options) => {
        if (!raced && args[0] === 'push') {
          raced = true;
          await store.publish(manifest('0.5.0'));
        }
        return run(binary, args, options);
      },
    });
    assert.deepEqual(await older.publish(manifest('0.4.0')), { status: 'newer', version: '0.5.0' });
    assert.equal((await store.readLatest()).version, '0.5.0');
  });
});

test('invalid historical manifest is preserved instead of overwritten', async () => {
  await fixture(async ({ store, remote, directory }) => {
    await store.publish(manifest('0.3.0'));
    const checkout = join(directory, 'invalid');
    await run('git', ['clone', '--quiet', '--branch', 'updater', remote, checkout]);
    await run('git', ['config', 'user.name', 'Test'], { cwd: checkout });
    await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: checkout });
    await writeFile(join(checkout, 'latest.json'), 'invalid historical content');
    await run('git', ['commit', '--quiet', '-am', 'Invalid fixture'], { cwd: checkout });
    await run('git', ['push', '--quiet'], { cwd: checkout });
    await assert.rejects(store.publish(manifest('0.4.0')), SyntaxError);
    const result = await run('git', ['--git-dir', remote, 'show', 'updater:latest.json']);
    assert.equal(result.stdout, 'invalid historical content');
  });
});

test('a mirror stores release provenance without requiring the source commit or creating source tags', async () => {
  await fixture(async ({ remote, store }) => {
    const { metadata } = archiveFixture();
    await store.archiveRelease(metadata);
    await store.publish(manifest(metadata.version));
    assert.deepEqual(await store.readRelease(metadata.tag), metadata);
    const { stdout: refs } = await run('git', [
      '--git-dir',
      remote,
      'for-each-ref',
      '--format=%(refname)',
    ]);
    assert.equal(refs.trim(), 'refs/heads/updater');
    await assert.rejects(
      run('git', ['--git-dir', remote, 'cat-file', '-e', `${metadata.releaseCommit}^{commit}`]),
      'releaseCommit records GitHub provenance and need not exist in the mirror',
    );
  });
});

test('Git credentials stay in a host-scoped environment header, never remote URLs or argv', () => {
  const env = gitEnvironment('https://gitee.com/test/bubblefish.git', 'test-token', 'oauth2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitee.com/.extraheader');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.ok(!env.GIT_CONFIG_VALUE_0.includes('test-token'));
});
