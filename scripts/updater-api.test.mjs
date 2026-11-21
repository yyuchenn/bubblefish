import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GithubReleaseApi,
  GiteeReleaseApi,
  ReleaseHttp,
  giteeAttachmentLimit,
} from './updater-api.mjs';
import { releaseMetadata, updateManifest } from './updater-artifacts.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

function fakeHttp(options) {
  return new ReleaseHttp({
    agentFactory: (agentOptions) => ({ options: agentOptions, close: async () => {} }),
    ...options,
  });
}

function fakeServer(
  release = testRelease(),
  { onRequest = () => {}, giteeRelease: existingGiteeRelease, ...httpOptions } = {},
) {
  const github = [],
    gitee = [],
    downloads = new Map(),
    calls = [],
    signalTimeouts = new WeakMap();
  let giteeRelease = existingGiteeRelease;
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
      timeoutMs: signalTimeouts.get(options.signal),
      agentOptions: options.dispatcher.options,
    });
    await onRequest(url, options);
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
  const http = fakeHttp({
    fetchImpl,
    sleep: async () => {},
    timeoutSignal: (timeoutMs) => {
      const signal = new AbortController().signal;
      signalTimeouts.set(signal, timeoutMs);
      return signal;
    },
    ...httpOptions,
  });
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

function diagnostics(error) {
  return JSON.parse(error.message.slice(error.message.indexOf('{')));
}

test('Gitee release tags use the updater branch instead of GitHub source history', async () => {
  const release = testRelease();
  const server = fakeServer(release);
  const mirrored = await server.gt.ensureRelease(release);
  assert.equal(mirrored.tag_name, release.tag_name);
  assert.equal(mirrored.target_commitish, 'updater');
  assert.equal(mirrored.name, release.name);
  assert.equal(mirrored.body, release.body);
  assert.equal(mirrored.prerelease, release.prerelease);
});

test('Gitee reuses existing release tags without changing their unrelated source commit', async () => {
  const release = testRelease();
  const existing = { id: 93, tag_name: release.tag_name, target_commitish: 'unrelated-history' };
  const server = fakeServer(release, { giteeRelease: existing });
  await server.gt.mirror(release, testArtifacts(testSigner()));
  assert.deepEqual(await server.gt.ensureRelease(release), existing);
  assert.ok(
    server.calls.every(
      ({ method, url }) => method === 'GET' || new URL(url).pathname.endsWith('/attach_files'),
    ),
    'Only missing attachments may be written; existing releases and tags must stay unchanged',
  );
});

test('GitHub publishes only installers and resumes without replacing existing bytes', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease();
  const server = fakeServer(release);
  await server.gh.publish(release, artifacts, '0.4.0', signer.publicKey);
  assert.equal(server.github.length, 4);
  assert.ok(server.github.every(({ name }) => !name.endsWith('.sig')));
  const initialUploads = server.calls.filter(({ method }) => method === 'POST').length;
  const resumed = await server.gh.publish(release, artifacts, '0.4.0', signer.publicKey);
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

test('preflight verifies published bytes and reuses legacy signatures before any writes', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease(),
    server = fakeServer(release);
  for (const entry of artifacts) {
    server.add('github', entry.name, entry.bytes);
    server.add('github', `${entry.name}.sig`, entry.signatureBytes);
  }
  const resigned = artifacts.map((entry) => ({
    ...entry,
    signatureBytes: Buffer.from(
      signer.signature(entry.bytes, entry.name, '0.4.0', {
        comment: `timestamp:1800000000\tfile:${entry.name}\tversion:0.4.0`,
      }),
    ),
  }));
  const prepared = await server.gh.prepareArtifacts(release, resigned, '0.4.0', signer.publicKey);
  assert.deepEqual(
    prepared.map(({ signature }) => signature),
    artifacts.map(({ signature }) => signature),
  );
  assert.ok(server.calls.every(({ method }) => method === 'GET'));
  server.downloads.set(server.github[0].browser_download_url, Buffer.from('conflicting installer'));
  await assert.rejects(
    server.gh.prepareArtifacts(release, resigned, '0.4.0', signer.publicKey),
    /Published attachment differs/,
  );
  assert.ok(server.calls.every(({ method }) => method === 'GET'));
});

test('archived signatures take precedence over legacy .sig during preflight and repair', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease(),
    metadata = releaseMetadata(release.tag_name, 'a'.repeat(40), artifacts),
    server = fakeServer(release);
  for (const entry of artifacts) {
    server.add('github', entry.name, entry.bytes);
    server.add('github', `${entry.name}.sig`, Buffer.from('invalid legacy signature'));
  }
  const prepared = await server.gh.prepareArtifacts(
    release,
    artifacts,
    '0.4.0',
    signer.publicKey,
    metadata,
  );
  const repaired = await server.gh.readArtifacts(release, '0.4.0', signer.publicKey, metadata);
  for (const values of [prepared, repaired])
    assert.deepEqual(
      values.map(({ signature }) => signature),
      artifacts.map(({ signature }) => signature),
    );
  assert.ok(server.calls.every(({ method, url }) => method === 'GET' && !url.endsWith('.sig')));
});

test('manual repair reads archived signatures without public .sig files and checks their digests', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease(),
    metadata = releaseMetadata(release.tag_name, 'a'.repeat(40), artifacts),
    server = fakeServer(release);
  for (const entry of artifacts) server.add('github', entry.name, entry.bytes);
  assert.equal(
    (await server.gh.readArtifacts(release, '0.4.0', signer.publicKey, metadata)).length,
    4,
  );
  const modified = structuredClone(metadata);
  modified.artifacts[0].sha256 = 'f'.repeat(64);
  await assert.rejects(
    server.gh.readArtifacts(release, '0.4.0', signer.publicKey, modified),
    /Archived installer differs/,
  );
  server.github.pop();
  await assert.rejects(
    server.gh.readArtifacts(release, '0.4.0', signer.publicKey, metadata),
    /Missing app installer/,
  );
  assert.ok(server.calls.every(({ method, url }) => method === 'GET' && !url.endsWith('.sig')));
});

test('legacy manual repair still requires complete signed GitHub release assets', async () => {
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
  assert.equal(server.gitee.length, 4);
  assert.ok(server.gitee.every(({ name }) => !name.endsWith('.sig')));
  assert.match(urls[artifacts[0].name], /\/attach_files\/1000\/download\//);
  const manifest = updateManifest(release, artifacts, urls);
  assert.match(manifest.platforms['windows-x86_64'].url, /\/attach_files\/1001\//);
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

test('reads only requested existing GitHub assets in order using anonymous downloads', async () => {
  const release = testRelease(),
    server = fakeServer(release),
    plugins = [
      { name: 'deepseek-translation-plugin.bfplugin', bytes: Buffer.from('plugin one') },
      { name: 'kha-white-ocr-plugin-web.bfplugin', bytes: Buffer.from('plugin two') },
    ];
  for (const { name, bytes } of [...plugins].reverse()) server.add('github', name, bytes);
  server.add('github', 'example.edit-guard.bfplugin', Buffer.from('example plugin'));
  server.add('github', 'installer.exe', Buffer.from('installer'));
  assert.deepEqual(
    await server.gh.readAssets(release, [
      plugins[0].name,
      'kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin',
      plugins[1].name,
    ]),
    plugins,
  );
  const downloads = server.calls.filter(({ url }) => new URL(url).hostname === 'github.com');
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(({ authorization }) => authorization === null));
  assert.ok(server.calls.every(({ method }) => method === 'GET'));
  assert.deepEqual(await server.gh.readAssets(release, ['absent.bfplugin']), []);
});

test('duplicate GitHub repair assets fail before any attachment downloads', async () => {
  const release = testRelease(),
    server = fakeServer(release),
    name = 'deepseek-translation-plugin.bfplugin';
  const asset = server.add('github', name, Buffer.from('plugin bytes'));
  server.github.push({ ...asset, id: 9999 });
  await assert.rejects(server.gh.readAssets(release, [name]), /Duplicate GitHub attachment/);
  assert.equal(server.calls.length, 1);
  assert.equal(new URL(server.calls[0].url).hostname, 'api.github.com');
});

test('unsigned plugin packages publish to both hosts and resume without duplicate attachments', async () => {
  const release = testRelease(),
    server = fakeServer(release),
    plugins = [
      { name: 'deepseek-translation-plugin.bfplugin', bytes: Buffer.from('plugin one') },
      { name: 'kha-white-ocr-plugin-web.bfplugin', bytes: Buffer.from('plugin two') },
    ];
  const githubUrls = await server.gh.uploadAssets(release, plugins);
  const giteeUrls = await server.gt.mirror(release, plugins);
  assert.equal(server.github.length, 2);
  assert.equal(server.gitee.length, 2);
  assert.ok([...server.github, ...server.gitee].every(({ name }) => name.endsWith('.bfplugin')));
  const uploads = server.calls.filter(({ method }) => method === 'POST').length;
  assert.deepEqual(await server.gh.uploadAssets(release, plugins), githubUrls);
  assert.deepEqual(await server.gt.mirror(release, plugins), giteeUrls);
  assert.equal(server.calls.filter(({ method }) => method === 'POST').length, uploads);
  const attachments = server.calls.filter(
    ({ method, url }) =>
      method === 'POST' &&
      (new URL(url).hostname === 'uploads.github.com' || url.endsWith('/attach_files')),
  );
  assert.ok(attachments.every(({ timeoutMs }) => timeoutMs === 900_000));
  for (const [api, asset] of [
    [(values) => server.gh.uploadAssets(release, values), server.github[0]],
    [(values) => server.gt.mirror(release, values), server.gitee[0]],
  ]) {
    server.downloads.set(asset.browser_download_url, Buffer.from('different plugin bytes'));
    await assert.rejects(api(plugins), /Published attachment differs/);
  }
  assert.ok(server.calls.every(({ method }) => !['PATCH', 'DELETE'].includes(method)));
});

test('duplicate requested or published attachments fail without replacing files', async () => {
  const release = testRelease(),
    server = fakeServer(release),
    plugin = { name: 'test.bfplugin', bytes: Buffer.from('plugin bytes') };
  await assert.rejects(server.gh.uploadAssets(release, [plugin, plugin]), /Duplicate GitHub/);
  await assert.rejects(server.gt.mirror(release, [plugin, plugin]), /Duplicate Gitee/);
  assert.equal(server.calls.length, 0);
  const asset = server.add('github', plugin.name, plugin.bytes);
  server.github.push({ ...asset, id: 9999 });
  await assert.rejects(server.gh.uploadAssets(release, [plugin]), /Duplicate GitHub/);
  assert.ok(server.calls.every(({ method }) => method === 'GET'));
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
  const http = fakeHttp({
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
  const http = fakeHttp({
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

test('installer uploads use fifteen minutes while metadata and downloads use two', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease(),
    server = fakeServer(release);
  await server.gh.publish(release, artifacts, '0.4.0', signer.publicKey);
  await server.gt.mirror(release, artifacts);
  const uploads = server.calls.filter(
    ({ url, method }) =>
      method === 'POST' &&
      (new URL(url).hostname === 'uploads.github.com' ||
        new URL(url).pathname.endsWith('/attach_files')),
  );
  assert.equal(uploads.length, 8);
  assert.ok(uploads.every(({ timeoutMs }) => timeoutMs === 900_000));
  for (const { agentOptions } of uploads)
    assert.deepEqual(agentOptions, {
      headersTimeout: 900_000,
      bodyTimeout: 900_000,
      connectTimeout: 10_000,
    });
  const otherRequests = server.calls.filter((call) => !uploads.includes(call));
  assert.ok(
    otherRequests.some(({ method }) => method === 'POST'),
    'Release creation is metadata',
  );
  assert.ok(otherRequests.some(({ method }) => method === 'GET'));
  assert.ok(otherRequests.every(({ timeoutMs }) => timeoutMs === 120_000));
  for (const { agentOptions } of otherRequests)
    assert.deepEqual(agentOptions, {
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
      connectTimeout: 10_000,
    });
});

test('HTTP profiles cache owned agents by budget and close them once after use', async () => {
  const created = [],
    used = [],
    closed = [];
  const http = new ReleaseHttp({
    agentFactory: (options) => {
      const agent = { options, close: async () => closed.push(agent) };
      created.push(agent);
      return agent;
    },
    fetchImpl: async (_url, { dispatcher }) => {
      used.push(dispatcher);
      return new Response('{"ok":true}');
    },
  });
  await http.json('https://api.github.com/metadata');
  await http.json('https://gitee.com/metadata');
  await http.json(
    'https://uploads.github.com/installers',
    { method: 'POST' },
    { timeoutMs: 900_000 },
  );
  await http.json('https://gitee.com/plugins', { method: 'POST' }, { timeoutMs: 900_000 });
  assert.equal(created.length, 2);
  assert.deepEqual(used, [created[0], created[0], created[1], created[1]]);
  assert.deepEqual(
    created.map(({ options }) => options),
    [
      { headersTimeout: 120_000, bodyTimeout: 120_000, connectTimeout: 10_000 },
      { headersTimeout: 900_000, bodyTimeout: 900_000, connectTimeout: 10_000 },
    ],
  );
  await http.close();
  await http.close();
  assert.deepEqual(closed, created);
  await assert.rejects(http.json('https://gitee.com/closed', { method: 'POST' }), (error) => {
    assert.match(error.cause.message, /client is closed/);
    return true;
  });
  assert.equal(used.length, 4);
});

test('unconsumed error and missing bodies are cancelled before owned agent shutdown', async () => {
  const cancelled = [];
  let call = 0;
  const http = fakeHttp({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel: () => cancelled.push(call),
        }),
        { status: ++call === 1 ? 404 : 403 },
      ),
  });
  assert.equal(await http.json('https://gitee.com/missing', {}, { missing: true }), null);
  await assert.rejects(http.json('https://gitee.com/forbidden'), /HTTP 403/);
  assert.deepEqual(cancelled, [1, 2]);
  await http.close();
});

test('both release adapters identify failed installer and plugin uploads without retrying them', async () => {
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    release = testRelease();
  for (const host of ['uploads.github.com', 'gitee.com']) {
    for (const [name, bytes] of [
      [artifacts[0].name, artifacts[0].bytes],
      ['deepseek-translation-plugin.bfplugin', Buffer.from('plugin bytes')],
    ]) {
      const failure = Object.assign(new Error('raw upload error must stay private'), {
        code: 'ECONNRESET',
      });
      let failedUploads = 0;
      const server = fakeServer(release, {
        onRequest: (url, options) => {
          if (url.hostname !== host || options.method !== 'POST') return;
          const filename =
            host === 'uploads.github.com'
              ? url.searchParams.get('name')
              : options.body.get?.('file')?.name;
          if (filename !== name) return;
          failedUploads++;
          throw failure;
        },
      });
      await assert.rejects(
        host === 'uploads.github.com'
          ? server.gh.uploadAssets(release, [{ name, bytes }])
          : server.gt.mirror(release, [{ name, bytes }]),
        (error) => {
          const detail = diagnostics(error);
          assert.equal(error.cause, failure);
          assert.equal(detail.phase, 'request');
          assert.equal(detail.attachmentName, name);
          assert.equal(detail.attachmentSize, bytes.length);
          assert.equal(detail.timeoutMs, 900_000);
          assert.equal(detail.attempt, 1);
          assert.equal(detail.maxAttempts, 1);
          assert.ok(detail.causes.some(({ code }) => code === 'ECONNRESET'));
          assert.doesNotMatch(error.message, /raw upload error/);
          return true;
        },
      );
      assert.equal(failedUploads, 1);
    }
  }
});

test('request timeout diagnostics include safe upload context and retain the original cause', async () => {
  let now = 0,
    calls = 0;
  const timeout = new DOMException('private timeout message with secret-token', 'TimeoutError');
  const controller = new AbortController();
  controller.abort(timeout);
  const http = fakeHttp({
    now: () => now,
    timeoutSignal: (timeoutMs) => {
      assert.equal(timeoutMs, 900_000);
      return controller.signal;
    },
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      now = 901_234;
      throw options.signal.reason;
    },
    sleep: async () => assert.fail('Uploads must not retry'),
  });
  await assert.rejects(
    http.json(
      'https://private-user:private-password@gitee.com/api/v5/repos/test/bubblefish/releases/93/attach_files?access_token=secret-token#private-fragment',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer private-authorization' },
        body: 'private-upload-body',
      },
      { timeoutMs: 900_000, attachmentName: 'Bubblefish_0.4.0_x64.msi', attachmentSize: 123_456 },
    ),
    (error) => {
      assert.equal(error.cause, timeout);
      assert.match(error.message, /network request failed/);
      assert.deepEqual(diagnostics(error), {
        phase: 'request',
        method: 'POST',
        url: 'gitee.com/api/v5/repos/test/bubblefish/releases/93/attach_files',
        attachmentName: 'Bubblefish_0.4.0_x64.msi',
        attachmentSize: 123_456,
        elapsedMs: 901_234,
        timeoutMs: 900_000,
        headersTimeoutMs: 900_000,
        bodyTimeoutMs: 900_000,
        connectTimeoutMs: 10_000,
        attempt: 1,
        maxAttempts: 1,
        causes: [{ name: 'TimeoutError' }],
      });
      assert.doesNotMatch(error.message, /private-|secret-token|Authorization|access_token|Bearer/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('network diagnostics bound aggregate and cyclic causes without printing their messages', async () => {
  const reset = Object.assign(new Error('private reset message'), { code: 'ECONNRESET' });
  const connect = Object.assign(new Error('private connect message'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  const aggregate = new AggregateError(
    [reset, connect, ...Array.from({ length: 100 }, () => new Error('private extra message'))],
    'private aggregate message',
  );
  const failure = new TypeError('private fetch message', { cause: aggregate });
  reset.cause = failure;
  const http = fakeHttp({
    fetchImpl: async () => {
      throw failure;
    },
    timeoutSignal: () => new AbortController().signal,
    now: () => 0,
  });
  await assert.rejects(http.json('https://gitee.com/api/v5/test', { method: 'POST' }), (error) => {
    assert.equal(error.cause, failure);
    const { causes } = diagnostics(error);
    assert.ok(causes.some(({ name }) => name === 'TypeError'));
    assert.ok(causes.some(({ name }) => name === 'AggregateError'));
    assert.ok(causes.some(({ code }) => code === 'ECONNRESET'));
    assert.ok(causes.some(({ code }) => code === 'UND_ERR_CONNECT_TIMEOUT'));
    assert.ok(causes.length <= 16);
    assert.ok(error.message.length < 4_000);
    assert.ok(
      causes.every((entry) => Object.keys(entry).every((key) => ['name', 'code'].includes(key))),
    );
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test('HTTP errors report status and timing without exposing response bodies or credentials', async () => {
  let now = 100,
    calls = 0;
  const http = fakeHttp({
    now: () => now,
    timeoutSignal: () => new AbortController().signal,
    fetchImpl: async () => {
      calls++;
      now = 175;
      return new Response('private-response-body', {
        status: 403,
        headers: { 'X-Private-Header': 'private-response-header' },
      });
    },
  });
  await assert.rejects(
    http.json(
      'https://private-user:private-password@gitee.com/api/v5/test?access_token=private-token',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer private-auth' },
        body: 'private-request-body',
      },
    ),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      const detail = diagnostics(error);
      assert.equal(detail.phase, 'http');
      assert.equal(detail.method, 'POST');
      assert.equal(detail.url, 'gitee.com/api/v5/test');
      assert.equal(detail.status, 403);
      assert.equal(detail.elapsedMs, 75);
      assert.equal(detail.timeoutMs, 120_000);
      assert.equal(detail.attempt, 1);
      assert.equal(detail.maxAttempts, 1);
      assert.doesNotMatch(error.message, /private-|access_token|Authorization|Bearer/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('exhausted read retries report the last attempt timing rather than total backoff time', async () => {
  let now = 0,
    calls = 0;
  const sleeps = [],
    timeouts = [];
  const failure = Object.assign(new Error('private DNS failure'), { code: 'ENOTFOUND' });
  const http = fakeHttp({
    now: () => now,
    timeoutSignal: (timeoutMs) => {
      timeouts.push(timeoutMs);
      return new AbortController().signal;
    },
    fetchImpl: async () => {
      calls++;
      now += 25;
      throw failure;
    },
    sleep: async (delay) => {
      sleeps.push(delay);
      now += delay;
    },
  });
  await assert.rejects(http.json('https://api.github.com/test'), (error) => {
    const detail = diagnostics(error);
    assert.equal(error.cause, failure);
    assert.equal(detail.phase, 'request');
    assert.equal(detail.method, 'GET');
    assert.equal(detail.elapsedMs, 25);
    assert.equal(detail.attempt, 4);
    assert.equal(detail.maxAttempts, 4);
    assert.equal(detail.timeoutMs, 120_000);
    assert.ok(detail.causes.some(({ code }) => code === 'ENOTFOUND'));
    assert.equal(detail.attachmentName, undefined);
    assert.equal(detail.attachmentSize, undefined);
    return true;
  });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  assert.deepEqual(timeouts, [120_000, 120_000, 120_000, 120_000]);
});

test('JSON failures retain successful retry context and do not print invalid response content', async () => {
  let now = 0,
    calls = 0;
  const http = fakeHttp({
    now: () => now,
    timeoutSignal: () => new AbortController().signal,
    sleep: async (delay) => {
      now += delay;
    },
    fetchImpl: async () => {
      now += 10;
      return ++calls === 1
        ? new Response('', { status: 503 })
        : new Response('private-invalid-json-body', { status: 201 });
    },
  });
  await assert.rejects(
    http.json('https://api.github.com/test?private-query=private-token'),
    (error) => {
      const detail = diagnostics(error);
      assert.ok(error.cause instanceof SyntaxError);
      assert.equal(detail.phase, 'json');
      assert.equal(detail.url, 'api.github.com/test');
      assert.equal(detail.status, 201);
      assert.equal(detail.elapsedMs, 10);
      assert.equal(detail.timeoutMs, 120_000);
      assert.equal(detail.attempt, 2);
      assert.equal(detail.maxAttempts, 4);
      assert.ok(detail.causes.some(({ name }) => name === 'SyntaxError'));
      assert.doesNotMatch(error.message, /private-/);
      return true;
    },
  );
  assert.equal(calls, 2, 'JSON parse failures must not add new read retries');
});

test('download stream failures preserve final response context without replaying the download', async () => {
  let now = 0,
    calls = 0;
  const failure = Object.assign(new Error('private body failure'), { code: 'ECONNRESET' });
  const http = fakeHttp({
    now: () => now,
    timeoutSignal: () => new AbortController().signal,
    sleep: async (delay) => {
      now += delay;
    },
    fetchImpl: async () => {
      now += 10;
      if (++calls === 1) return new Response('', { status: 503 });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('private-partial-download'));
          },
          pull(controller) {
            now += 5;
            controller.error(failure);
          },
        }),
      );
    },
  });
  await assert.rejects(
    http.download(
      'https://gitee.com/test/attach_files/1000/download/installer.exe?private-query=private-token',
    ),
    (error) => {
      const detail = diagnostics(error);
      assert.equal(error.cause, failure);
      assert.equal(detail.phase, 'download-body');
      assert.equal(detail.method, 'GET');
      assert.equal(detail.url, 'gitee.com/test/attach_files/1000/download/installer.exe');
      assert.equal(detail.status, 200);
      assert.ok(
        Number.isInteger(detail.elapsedMs) && detail.elapsedMs >= 10 && detail.elapsedMs <= 15,
      );
      assert.equal(detail.timeoutMs, 120_000);
      assert.equal(detail.attempt, 2);
      assert.equal(detail.maxAttempts, 4);
      assert.ok(detail.causes.some(({ code }) => code === 'ECONNRESET'));
      assert.doesNotMatch(error.message, /private-/);
      return true;
    },
  );
  assert.equal(calls, 2, 'Body failures must not add new read retries');
});
