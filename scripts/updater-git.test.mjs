import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitUpdaterStore, gitEnvironment } from './updater-git.mjs';

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

test('Gitee tags are immutable and never forced to another commit', async () => {
  await fixture(async ({ remote, directory }) => {
    const source = join(directory, 'source');
    await run('git', ['init', '--quiet', source]);
    await run('git', ['config', 'user.name', 'Test'], { cwd: source });
    await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    await writeFile(join(source, 'package.json'), '{}');
    await run('git', ['add', 'package.json'], { cwd: source });
    await run('git', ['commit', '--quiet', '-m', 'Release'], { cwd: source });
    await run('git', ['tag', 'v0.4.0'], { cwd: source });
    const { stdout: commit } = await run('git', ['rev-parse', 'HEAD'], { cwd: source });
    const store = new GitUpdaterStore({ remote });
    await store.ensureTag(source, 'v0.4.0', commit.trim());
    await store.ensureTag(source, 'v0.4.0', commit.trim());
    await assert.rejects(store.ensureTag(source, 'v0.4.0', 'f'.repeat(40)), /different commit/);
  });
});

test('Git credentials stay in a host-scoped environment header, never remote URLs or argv', () => {
  const env = gitEnvironment('https://gitee.com/test/bubblefish.git', 'test-token', 'oauth2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitee.com/.extraheader');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.ok(!env.GIT_CONFIG_VALUE_0.includes('test-token'));
});
