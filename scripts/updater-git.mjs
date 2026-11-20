import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compareVersions, releaseVersion, validateReleaseMetadata } from './updater-artifacts.mjs';

const execute = promisify(execFile);

export function gitEnvironment(remote, token, username) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const origin = new URL(remote).origin;
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    env.GIT_CONFIG_KEY_1 = 'credential.helper';
    env.GIT_CONFIG_VALUE_1 = '';
  }
  return env;
}

export class GitUpdaterStore {
  constructor({ remote, token, username = 'x-access-token', run = execute }) {
    this.remote = remote;
    this.env = gitEnvironment(remote, token, username);
    this.run = run;
  }

  git(cwd, args) {
    return this.run('git', args, { cwd, env: this.env, maxBuffer: 2 * 1024 * 1024 });
  }

  async checkout(directory) {
    const { stdout } = await this.git(directory, [
      'ls-remote',
      '--heads',
      'origin',
      'refs/heads/updater',
    ]);
    if (stdout.trim()) {
      await this.git(directory, [
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        'origin',
        'refs/heads/updater',
      ]);
      await this.git(directory, ['checkout', '--quiet', '-B', 'updater', 'FETCH_HEAD']);
      await this.git(directory, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    } else {
      await this.git(directory, ['checkout', '--quiet', '--orphan', 'updater']);
    }
  }

  async withCheckout(operation) {
    const directory = await mkdtemp(join(tmpdir(), 'bubblefish-updater-'));
    try {
      await this.git(directory, ['init', '--quiet']);
      await this.git(directory, ['config', 'user.name', 'github-actions[bot]']);
      await this.git(directory, [
        'config',
        'user.email',
        '41898282+github-actions[bot]@users.noreply.github.com',
      ]);
      await this.git(directory, ['remote', 'add', 'origin', this.remote]);
      await this.checkout(directory);
      return await operation(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async readFile(directory) {
    let content;
    try {
      content = await readFile(join(directory, 'latest.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const manifest = JSON.parse(content);
    releaseVersion(manifest.version);
    return manifest;
  }

  readLatest() {
    return this.withCheckout((directory) => this.readFile(directory));
  }

  async readReleaseFile(directory, tag) {
    releaseVersion(tag);
    let content;
    try {
      content = await readFile(join(directory, 'releases', `${tag}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return validateReleaseMetadata(JSON.parse(content), tag);
  }

  readRelease(tag) {
    releaseVersion(tag);
    return this.withCheckout((directory) => this.readReleaseFile(directory, tag));
  }

  archiveRelease(metadata) {
    validateReleaseMetadata(metadata);
    const content = `${JSON.stringify(metadata, null, 2)}\n`;
    const identity = (value) => ({
      tag: value.tag,
      version: value.version,
      releaseCommit: value.releaseCommit,
      artifacts: value.artifacts
        .map(({ name, sha256 }) => ({ name, sha256 }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    });
    return this.withCheckout(async (directory) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const existing = await this.readReleaseFile(directory, metadata.tag);
        if (existing) {
          assert.deepEqual(
            identity(existing),
            identity(metadata),
            `Release archive differs: ${metadata.tag}`,
          );
          // A timestamp changes when identical bytes are re-signed. Preserve
          // the original record; the caller re-verifies its signatures before
          // using it, including when a concurrent publisher won this push.
          return existing;
        }
        const path = `releases/${metadata.tag}.json`;
        await mkdir(join(directory, 'releases'), { recursive: true });
        await writeFile(join(directory, path), content);
        await this.git(directory, ['add', '--', path]);
        await this.git(directory, [
          'commit',
          '--quiet',
          '-m',
          `Archive Bubblefish ${metadata.tag} release signatures`,
        ]);
        try {
          await this.git(directory, ['push', '--quiet', 'origin', 'HEAD:refs/heads/updater']);
          return metadata;
        } catch (error) {
          const detail = `${error.stderr ?? ''}`;
          if (
            attempt === 3 ||
            !/rejected|non-fast-forward|fetch first|cannot lock ref/i.test(detail)
          )
            throw error;
          await this.checkout(directory);
        }
      }
      throw new Error('Release archive retry limit reached');
    });
  }

  publish(manifest) {
    releaseVersion(manifest.version);
    assert.ok(!manifest.version.includes('-'), 'Prereleases cannot replace stable latest.json');
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    return this.withCheckout(async (directory) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const existing = await this.readFile(directory);
        if (existing && compareVersions(existing.version, manifest.version) > 0)
          return { status: 'newer', version: existing.version };
        await writeFile(join(directory, 'latest.json'), content);
        await this.git(directory, ['add', '--', 'latest.json']);
        const { stdout } = await this.git(directory, ['diff', '--cached', '--name-only']);
        if (!stdout.trim()) return { status: 'unchanged', version: manifest.version };
        await this.git(directory, [
          'commit',
          '--quiet',
          '-m',
          `Publish Bubblefish ${manifest.version} updater manifest`,
        ]);
        try {
          // An optimistic fast-forward update is the compare-and-swap. Never
          // replace the remote branch's independent history with a force push.
          await this.git(directory, ['push', '--quiet', 'origin', 'HEAD:refs/heads/updater']);
          return { status: 'updated', version: manifest.version };
        } catch (error) {
          const detail = `${error.stderr ?? ''}`;
          if (
            attempt === 3 ||
            !/rejected|non-fast-forward|fetch first|cannot lock ref/i.test(detail)
          )
            throw error;
          await this.checkout(directory);
        }
      }
      throw new Error('Updater publication retry limit reached');
    });
  }
}
