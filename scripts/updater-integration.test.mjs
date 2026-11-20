import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { publishUpdater } from './publish-updater.mjs';
import { GithubReleaseApi, GiteeReleaseApi, ReleaseHttp } from './updater-api.mjs';
import { GitUpdaterStore } from './updater-git.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

const run = promisify(execFile);

function releaseServer(release) {
  const assets = { github: [], gitee: [] },
    downloads = new Map(),
    calls = [];
  const server = { assets, calls, failNextGiteeUpload: false, beforeUpload: async () => {} };
  let giteeRelease;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const add = (host, name, bytes) => {
    const id = assets[host].length + 1;
    const browser_download_url =
      host === 'github'
        ? `https://github.com/test/bubblefish/releases/download/${release.tag_name}/${name}`
        : `https://gitee.com/test/bubblefish/attach_files/${id}/download/${name}`;
    const asset = { id, name, size: bytes.length, browser_download_url };
    downloads.set(browser_download_url, Buffer.from(bytes));
    assets[host].push(asset);
    return asset;
  };
  server.add = add;
  server.http = new ReleaseHttp({
    sleep: async () => {},
    timeoutSignal: () => new AbortController().signal,
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input),
        method = options.method ?? 'GET';
      calls.push({ url: url.href, method });
      if (downloads.has(url.href)) {
        assert.equal(new Headers(options.headers).get('Authorization'), null);
        return new Response(downloads.get(url.href));
      }
      if (url.hostname === 'api.github.com') {
        if (url.pathname.endsWith(`/releases/tags/${release.tag_name}`)) return json(release);
        if (url.pathname.endsWith(`/releases/${release.id}/assets`)) return json(assets.github);
      }
      if (url.hostname === 'uploads.github.com' && method === 'POST') {
        await server.beforeUpload('github');
        return json(add('github', url.searchParams.get('name'), options.body), 201);
      }
      if (url.hostname === 'gitee.com') {
        if (url.pathname.endsWith(`/releases/tags/${release.tag_name}`))
          return giteeRelease ? json(giteeRelease) : json({}, 404);
        if (url.pathname.endsWith('/releases') && method === 'POST') {
          giteeRelease = { ...JSON.parse(options.body), id: 93 };
          return json(giteeRelease, 201);
        }
        if (url.pathname.endsWith('/releases/93/attach_files')) {
          if (method === 'GET') return json(assets.gitee);
          await server.beforeUpload('gitee');
          if (server.failNextGiteeUpload) {
            server.failNextGiteeUpload = false;
            throw Object.assign(new Error('simulated upload reset'), { code: 'ECONNRESET' });
          }
          const file = options.body.get('file');
          return json(add('gitee', file.name, Buffer.from(await file.arrayBuffer())), 201);
        }
      }
      assert.fail(`Unexpected fake HTTP request: ${method} ${url.hostname}${url.pathname}`);
    },
  });
  return server;
}

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-updater-integration-'));
  try {
    const sourceDirectory = join(directory, 'source');
    const githubRemote = join(directory, 'github.git');
    const giteeRemote = join(directory, 'gitee.git');
    await run('git', ['init', '--quiet', '--bare', githubRemote]);
    await run('git', ['init', '--quiet', '--bare', giteeRemote]);
    await run('git', ['init', '--quiet', sourceDirectory]);
    await run('git', ['config', 'user.name', 'Release Test'], { cwd: sourceDirectory });
    await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: sourceDirectory });
    await writeFile(join(sourceDirectory, 'RELEASE'), 'Test release source.');
    await run('git', ['add', 'RELEASE'], { cwd: sourceDirectory });
    await run('git', ['commit', '--quiet', '-m', 'Release fixture'], { cwd: sourceDirectory });
    const release = testRelease();
    await run('git', ['tag', release.tag_name], { cwd: sourceDirectory });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory });
    const signer = testSigner();
    const server = releaseServer(release);
    const options = {
      tag: release.tag_name,
      sourceDirectory,
      publicKey: signer.publicKey,
      expectedVersion: '0.4.0',
      localArtifacts: testArtifacts(signer),
      releaseCommit: stdout.trim(),
      github: new GithubReleaseApi({
        repository: 'test/bubblefish',
        token: 'test-github-token',
        http: server.http,
      }),
      gitee: new GiteeReleaseApi({
        repository: 'test/bubblefish',
        token: 'test-gitee-token',
        http: server.http,
      }),
      githubStore: new GitUpdaterStore({ remote: githubRemote }),
      giteeStore: new GitUpdaterStore({ remote: giteeRemote }),
    };
    await operation({ options, server, release, githubRemote });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertInstallerAssets(server, artifacts) {
  const expected = artifacts.map(({ name }) => name).sort();
  for (const host of ['github', 'gitee'])
    assert.deepEqual(server.assets[host].map(({ name }) => name).sort(), expected);
  assert.ok(
    server.calls.every(({ url }) => !new URL(url).pathname.endsWith('.sig')),
    'New releases must neither upload nor depend on public signature attachments',
  );
}

test('staged release archives signatures before uploads and repairs from installer-only assets', async () => {
  await fixture(async ({ options, server, release }) => {
    const checked = new Set();
    server.beforeUpload = async (host) => {
      if (checked.has(host)) return;
      checked.add(host);
      const store = host === 'github' ? options.githubStore : options.giteeStore;
      const metadata = await store.readRelease(options.tag);
      assert.equal(metadata.releaseCommit, options.releaseCommit);
      assert.equal(metadata.artifacts.length, 4);
      assert.equal(await store.readLatest(), null, 'Uploads must precede latest publication');
    };
    assert.equal((await publishUpdater(options)).status, 'published');
    assert.deepEqual([...checked].sort(), ['gitee', 'github']);
    assertInstallerAssets(server, options.localArtifacts);
    const archived = await options.githubStore.readRelease(options.tag);
    assert.deepEqual(await options.giteeStore.readRelease(options.tag), archived);
    assert.equal((await options.githubStore.readLatest()).version, '0.4.0');
    const mirroredManifest = await options.giteeStore.readLatest();
    assert.equal(mirroredManifest.version, '0.4.0');
    assert.match(mirroredManifest.platforms['windows-x86_64'].url, /attach_files\/\d+\/download/);
    const restored = await options.github.readArtifacts(
      release,
      '0.4.0',
      options.publicKey,
      archived,
    );
    assert.deepEqual(
      restored.map(({ name, signature }) => ({ name, signature })),
      options.localArtifacts.map(({ name, signature }) => ({ name, signature })),
    );
    const writes = server.calls.filter(({ method }) => method === 'POST').length;
    assert.equal(
      (await publishUpdater({ ...options, localArtifacts: undefined })).status,
      'published',
    );
    assert.equal(server.calls.filter(({ method }) => method === 'POST').length, writes);
    assertInstallerAssets(server, options.localArtifacts);
  });
});

test('failed Gitee upload leaves feeds unchanged and supports archive-only repair without GitHub writes', async () => {
  await fixture(async ({ options, server, githubRemote }) => {
    const previous = { version: '0.3.0', notes: 'Previous stable release', platforms: {} };
    await options.githubStore.publish(previous);
    await options.giteeStore.publish(previous);
    server.failNextGiteeUpload = true;
    await assert.rejects(publishUpdater(options), /network request failed/);
    assert.equal(server.assets.github.length, 4);
    assert.equal(server.assets.gitee.length, 0);
    assert.deepEqual(await options.githubStore.readLatest(), previous);
    assert.deepEqual(await options.giteeStore.readLatest(), previous);
    const archived = await options.githubStore.readRelease(options.tag);
    assert.equal(archived.artifacts.length, 4);
    assert.deepEqual(await options.giteeStore.readRelease(options.tag), archived);
    const githubHead = async () =>
      (await run('git', ['--git-dir', githubRemote, 'rev-parse', 'refs/heads/updater'])).stdout;
    const originalHead = await githubHead();
    const githubWrites = server.calls.filter(
      ({ url, method }) => method === 'POST' && new URL(url).hostname === 'uploads.github.com',
    ).length;
    const mirror = await publishUpdater({
      ...options,
      localArtifacts: undefined,
      mirrorOnly: true,
    });
    assert.equal(mirror.status, 'published');
    assert.equal(mirror.github, undefined);
    assert.equal(await githubHead(), originalHead);
    assert.equal(
      server.calls.filter(
        ({ url, method }) => method === 'POST' && new URL(url).hostname === 'uploads.github.com',
      ).length,
      githubWrites,
    );
    assert.deepEqual(await options.githubStore.readLatest(), previous);
    assert.equal((await options.giteeStore.readLatest()).version, '0.4.0');
    assertInstallerAssets(server, options.localArtifacts);
    assert.equal(
      (await publishUpdater({ ...options, localArtifacts: undefined })).status,
      'published',
    );
    assert.equal((await options.githubStore.readLatest()).version, '0.4.0');
    assert.equal((await options.giteeStore.readLatest()).version, '0.4.0');
    assertInstallerAssets(server, options.localArtifacts);
  });
});

test('conflicting published GitHub installer bytes prevent creation of a signature archive', async () => {
  await fixture(async ({ options, server }) => {
    server.add('github', options.localArtifacts[0].name, Buffer.from('Different published bytes'));
    await assert.rejects(publishUpdater(options), /Published attachment differs/);
    assert.equal(await options.githubStore.readRelease(options.tag), null);
    assert.equal(await options.giteeStore.readRelease(options.tag), null);
    assert.equal(await options.githubStore.readLatest(), null);
    assert.equal(await options.giteeStore.readLatest(), null);
    assert.ok(server.calls.every(({ method }) => method !== 'POST'));
    assert.equal(server.assets.gitee.length, 0);
  });
});
