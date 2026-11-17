import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GithubReleaseApi,
  GiteeReleaseApi,
  ReleaseHttp,
  giteeAttachmentLimit,
} from './updater-api.mjs';
import { updateManifest } from './updater-artifacts.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

function fakeServer(release = testRelease()) {
  const github = [],
    gitee = [],
    downloads = new Map(),
    calls = [];
  let giteeRelease;
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const add = (host, name, bytes) => {
    const list = host === 'github' ? github : gitee;
    const id = list.length + (host === 'github' ? 1 : 1000);
    const browser_download_url =
      host === 'github'
        ? `https://github.com/test/bubblefish/releases/download/${release.tag_name}/${name}`
        : `https://gitee.com/test/bubblefish/attach_files/${id}/download/${name}`;
    const asset = { id, name, size: bytes.length, browser_download_url };
    downloads.set(browser_download_url, Buffer.from(bytes));
    list.push(asset);
    return asset;
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input),
      method = options.method ?? 'GET';
    calls.push({
      url: url.href,
      method,
      authorization: new Headers(options.headers).get('Authorization'),
    });
    if (downloads.has(url.href)) {
      assert.equal(
        new Headers(options.headers).get('Authorization'),
        null,
        'Public downloads must not receive API tokens',
      );
      return new Response(downloads.get(url.href));
    }
    if (
      url.hostname === 'api.github.com' &&
      url.pathname.endsWith(`/releases/tags/${release.tag_name}`)
    )
      return json(release);
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/42/assets'))
      return json(github);
    if (url.hostname === 'uploads.github.com' && method === 'POST')
      return json(add('github', url.searchParams.get('name'), options.body), 201);
    if (url.hostname === 'gitee.com' && url.pathname.endsWith(`/releases/tags/${release.tag_name}`))
      return giteeRelease ? json(giteeRelease) : json({}, 404);
    if (url.hostname === 'gitee.com' && url.pathname.endsWith('/releases') && method === 'POST') {
      giteeRelease = { ...JSON.parse(options.body), id: 93 };
      return json(giteeRelease, 201);
    }
    if (url.hostname === 'gitee.com' && url.pathname.endsWith('/releases/93/attach_files')) {
      if (method === 'GET') return json(gitee);
      const file = options.body.get('file');
      return json(add('gitee', file.name, Buffer.from(await file.arrayBuffer())), 201);
    }
    return json({}, 404);
  };
  const http = new ReleaseHttp({ fetchImpl, sleep: async () => {} });
  return {
    github,
    gitee,
    downloads,
    calls,
    add,
    gh: new GithubReleaseApi({ repository: 'test/bubblefish', token: 'test-github-token', http }),
    gt: new GiteeReleaseApi({ repository: 'test/bubblefish', token: 'test-gitee-token', http }),
  };
}

test('GitHub publication resumes without replacing installers or already valid signatures', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease();
  const server = fakeServer(release);
  await server.gh.publish(release, artifacts, '0.4.0', signer.publicKey);
  assert.equal(server.github.length, 8);
  const initialUploads = server.calls.filter(({ method }) => method === 'POST').length;
  const resigned = artifacts.map((entry) => ({
    ...entry,
    signatureBytes: Buffer.from(
      signer.signature(entry.bytes, entry.name, '0.4.0', {
        comment: `timestamp:1800000000\tfile:${entry.name}\tversion:0.4.0`,
      }),
    ),
  }));
  const resumed = await server.gh.publish(release, resigned, '0.4.0', signer.publicKey);
  assert.equal(server.calls.filter(({ method }) => method === 'POST').length, initialUploads);
  assert.equal(resumed.artifacts[0].signature, artifacts[0].signature);
  server.downloads.set(
    server.github[0].browser_download_url,
    Buffer.from('different published payload'),
  );
  await assert.rejects(
    server.gh.publish(release, artifacts, '0.4.0', signer.publicKey),
    /Published attachment differs/,
  );
});

test('manual repair requires complete signed GitHub release assets', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease();
  const server = fakeServer(release);
  for (const entry of artifacts) server.add('github', entry.name, entry.bytes);
  await assert.rejects(
    server.gh.readArtifacts(release, '0.4.0', signer.publicKey),
    /Expected one signature/,
  );
  for (const entry of artifacts) server.add('github', `${entry.name}.sig`, entry.signatureBytes);
  assert.equal((await server.gh.readArtifacts(release, '0.4.0', signer.publicKey)).length, 4);
});

test('Gitee uses returned numeric attachment URLs, verifies anonymous bytes and is idempotent', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease();
  const server = fakeServer(release);
  const urls = await server.gt.mirror(release, artifacts);
  assert.equal(server.gitee.length, 8);
  assert.match(urls[artifacts[0].name], /\/attach_files\/1000\/download\//);
  const manifest = updateManifest(release, artifacts, urls);
  assert.match(manifest.platforms['windows-x86_64'].url, /\/attach_files\/1002\//);
  const uploads = server.calls.filter(({ method }) => method === 'POST').length;
  assert.deepEqual(await server.gt.mirror(release, artifacts), urls);
  assert.equal(server.calls.filter(({ method }) => method === 'POST').length, uploads);
  assert.ok(server.calls.some(({ authorization }) => authorization === 'Bearer test-gitee-token'));
  server.downloads.set(
    server.gitee[0].browser_download_url,
    Buffer.from('<html>Login required</html>'),
  );
  await assert.rejects(server.gt.mirror(release, artifacts), /Published attachment differs/);
});

test('Gitee rejects duplicate attachments and oversize installers instead of deleting assets', async () => {
  const artifacts = testArtifacts(testSigner()),
    release = testRelease(),
    server = fakeServer(release);
  await server.gt.mirror(release, artifacts);
  server.gitee.push({ ...server.gitee[0], id: 9999 });
  await assert.rejects(server.gt.mirror(release, artifacts), /Duplicate Gitee/);
  await assert.rejects(
    server.gt.mirror(release, [{ ...artifacts[0], bytes: { length: giteeAttachmentLimit + 1 } }]),
    /exceeds 100 MB/,
  );
  assert.ok(server.calls.every(({ method }) => method !== 'DELETE'));
});

test('read retries handle transient HTTP failures; writes do not retry ambiguous errors', async () => {
  let calls = 0;
  const sleeps = [];
  const http = new ReleaseHttp({
    fetchImpl: async () =>
      ++calls < 3 ? new Response('', { status: 429 }) : new Response('{"ok":true}'),
    sleep: async (delay) => sleeps.push(delay),
  });
  assert.deepEqual(await http.json('https://api.github.com/test'), { ok: true });
  assert.deepEqual(sleeps, [500, 1000]);
  calls = 0;
  await assert.rejects(http.json('https://api.github.com/test', { method: 'POST' }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('network failures retry reads but never replay a possibly completed attachment upload', async () => {
  let calls = 0;
  const http = new ReleaseHttp({
    fetchImpl: async () => {
      if (++calls < 2) throw new Error('simulated connection reset');
      return new Response('{"ok":true}');
    },
    sleep: async () => {},
  });
  assert.deepEqual(await http.json('https://gitee.com/api/v5/test'), { ok: true });
  calls = 0;
  await assert.rejects(
    http.json('https://gitee.com/api/v5/test', { method: 'POST' }),
    /network request failed/,
  );
  assert.equal(calls, 1);
});
