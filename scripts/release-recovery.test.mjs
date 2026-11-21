import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { applyReleaseRecovery, prepareReleaseRecovery } from './release-recovery.mjs';
import { releaseMetadata, sha256 } from './updater-artifacts.mjs';
import { testArtifacts, testRelease, testSigner } from './updater-test-helpers.mjs';

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-release-recovery-'));
  const signer = testSigner(),
    artifacts = testArtifacts(signer),
    tag = 'v0.4.0';
  const source = {
    directory,
    version: '0.4.0',
    publicKey: signer.publicKey,
    releaseCommit: 'a'.repeat(40),
  };
  const oldCommit = 'b'.repeat(40),
    release = testRelease(),
    writes = [],
    downloads = new Map();
  const oldArtifacts = artifacts.map((entry) => {
    const bytes = Buffer.from(`older installer: ${entry.name}`);
    return { ...entry, bytes, signature: signer.signature(bytes, entry.name, source.version) };
  });
  const oldArchive = releaseMetadata(tag, oldCommit, oldArtifacts);
  const updater = (archive, head) => ({
    head,
    archive,
    archiveContent: archive ? `${JSON.stringify(archive, null, 2)}\n` : null,
    latest: {
      version: '0.3.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/test/bubblefish/releases/download/v0.3.0/old.exe',
        },
      },
    },
    latestContent: JSON.stringify({
      version: '0.3.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/test/bubblefish/releases/download/v0.3.0/old.exe',
        },
      },
    }),
  });
  const state = {
    github: { updater: updater(oldArchive, 'c'.repeat(40)), assets: [] },
    gitee: { updater: updater(null, 'd'.repeat(40)), assets: [] },
  };
  let tagCommit = source.releaseCommit,
    archiveBytes,
    receipt;
  const download = async (url) => {
    assert.ok(downloads.has(url), `Unexpected download: ${url}`);
    return Buffer.from(downloads.get(url));
  };
  const add = (host, name, bytes) => {
    const id = state[host].assets.length + 1;
    const browser_download_url = `https://${host === 'github' ? 'github.com' : 'gitee.com'}/test/bubblefish/releases/download/${tag}/${name}`;
    const asset = { id, name, size: bytes.length, browser_download_url };
    state[host].assets.push(asset);
    downloads.set(browser_download_url, Buffer.from(bytes));
    return asset;
  };
  add('github', 'deepseek-translation-plugin.bfplugin', Buffer.from('plugin one'));
  add('github', 'kha-white-ocr-plugin-web.bfplugin', Buffer.from('plugin two'));
  add('gitee', 'deepseek-translation-plugin.bfplugin', Buffer.from('plugin one'));
  const github = {
    base: 'https://api.github.com/repos/test/bubblefish',
    headers: { Authorization: 'Bearer private-test-token' },
    release: async () => structuredClone(release),
    assets: async () => structuredClone(state.github.assets),
    json: async (path) => {
      if (path.startsWith('/git/ref/tags/')) return { object: { type: 'commit', sha: tagCommit } };
      if (path === '/actions/artifacts/99') return structuredClone(receipt);
      assert.fail(`Unexpected GitHub read: ${path}`);
    },
    http: {
      download,
      response: async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/test/bubblefish/actions/artifacts/99/zip');
        assert.equal(options.headers.Authorization, 'Bearer private-test-token');
        return new Response(archiveBytes);
      },
    },
  };
  const gitee = {
    json: async (path) => {
      assert.equal(path, '/releases/tags/v0.4.0');
      return { ...release, id: 93, target_commitish: 'unrelated-gitee-history' };
    },
    list: async (path) => {
      assert.equal(path, '/releases/93/attach_files');
      return structuredClone(state.gitee.assets);
    },
    http: { download },
  };
  const store = (host) => ({
    snapshotRelease: async () => structuredClone(state[host].updater),
    removeRelease: async (_tag, expected) => {
      assert.deepEqual(expected, state[host].updater);
      writes.push(host);
      state[host].updater.archive = null;
      state[host].updater.archiveContent = null;
      state[host].updater.head = 'e'.repeat(40);
    },
  });
  const options = {
    tag,
    source,
    artifacts,
    expectedArchivedCommit: oldCommit,
    backupDirectory: join(directory, 'backup'),
    repository: 'test/bubblefish',
    runId: '1234',
    runAttempt: '2',
    github,
    gitee,
    githubStore: store('github'),
    giteeStore: store('gitee'),
    now: () => '2026-11-20T07:00:00Z',
  };
  const applyOptions = () => ({
    backupDirectory: options.backupDirectory,
    backupArtifactId: '99',
    repository: options.repository,
    runId: options.runId,
    github,
    gitee,
    githubStore: options.githubStore,
    giteeStore: options.giteeStore,
  });
  const persist = async (change = () => {}) => {
    const manifest = JSON.parse(await readFile(join(options.backupDirectory, 'manifest.json')));
    const files = {};
    for (const { path } of manifest.files)
      files[path] = await readFile(join(options.backupDirectory, path));
    files['manifest.json'] = await readFile(join(options.backupDirectory, 'manifest.json'));
    change(files);
    archiveBytes = Buffer.from(zipSync(files));
    receipt = {
      id: 99,
      name: 'release-recovery-v0.4.0-1234-2',
      workflow_run: { id: 1234 },
      expired: false,
      size_in_bytes: archiveBytes.length,
      digest: `sha256:${sha256(archiveBytes)}`,
    };
  };
  try {
    await operation({
      options,
      applyOptions,
      state,
      source,
      artifacts,
      oldArchive,
      writes,
      downloads,
      add,
      persist,
      github,
      gitee,
      setTag: (value) => {
        tagCommit = value;
      },
      changeReceipt: (change) => change(receipt),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('prepare backs up both hosts and signed installers without changing remote state', async () => {
  await fixture(async ({ options, writes, oldArchive }) => {
    const result = await prepareReleaseRecovery(options);
    assert.equal(result.status, 'prepared');
    assert.equal(result.backupName, 'release-recovery-v0.4.0-1234-2');
    assert.deepEqual(result.reset, ['github']);
    assert.deepEqual(writes, []);
    const snapshotText = await readFile(join(options.backupDirectory, 'snapshot.json'), 'utf8');
    const snapshot = JSON.parse(snapshotText);
    assert.equal(snapshot.source.releaseCommit, options.source.releaseCommit);
    assert.deepEqual(snapshot.state.github.updater.archive, oldArchive);
    assert.equal(snapshot.state.gitee.updater.archive, null);
    assert.doesNotMatch(snapshotText, /private-test-token|Authorization|Bearer/);
    const manifest = JSON.parse(await readFile(join(options.backupDirectory, 'manifest.json')));
    assert.ok(manifest.files.some(({ path }) => path === 'attachments/github/1'));
    assert.ok(manifest.files.some(({ path }) => path === 'attachments/gitee/1'));
    for (const artifact of options.artifacts) {
      assert.ok(manifest.files.some(({ path }) => path === `installers/${artifact.name}`));
      assert.ok(manifest.files.some(({ path }) => path === `installers/${artifact.name}.sig`));
    }
  });
});

test('a persisted byte-identical backup permits removal of only the obsolete archive', async () => {
  await fixture(async ({ options, applyOptions, persist, state, writes }) => {
    const before = structuredClone(state);
    const prepared = await prepareReleaseRecovery(options);
    await persist();
    const result = await applyReleaseRecovery({
      ...applyOptions(),
      backupFingerprint: prepared.fingerprint,
    });
    assert.equal(result.status, 'reset');
    assert.deepEqual(result.removed, ['github']);
    assert.deepEqual(writes, ['github']);
    assert.deepEqual(state.github.assets, before.github.assets);
    assert.deepEqual(state.gitee, before.gitee);
    assert.deepEqual(state.github.updater.latest, before.github.updater.latest);
    assert.equal(state.github.updater.archive, null);
  });
});

test('missing, expired or unrelated persisted backup receipts never permit deletion', async () => {
  for (const change of [
    (options) => {
      options.backupArtifactId = undefined;
    },
    (_options, receipt) => {
      receipt.name = 'other-backup';
    },
    (_options, receipt) => {
      receipt.workflow_run.id = 9876;
    },
    (_options, receipt) => {
      receipt.expired = true;
    },
    (_options, receipt) => {
      receipt.digest = `sha256:${'0'.repeat(64)}`;
    },
  ]) {
    await fixture(async ({ options, applyOptions, persist, changeReceipt, writes }) => {
      await prepareReleaseRecovery(options);
      await persist();
      const input = applyOptions();
      changeReceipt((receipt) => change(input, receipt));
      await assert.rejects(applyReleaseRecovery(input));
      assert.deepEqual(writes, []);
    });
  }
});

test('backup upload missing a file and tampered local backup content are rejected', async () => {
  await fixture(async ({ options, applyOptions, persist, writes }) => {
    await prepareReleaseRecovery(options);
    await persist((files) => {
      delete files['attachments/github/1'];
    });
    await assert.rejects(applyReleaseRecovery(applyOptions()), /Persisted backup is missing/);
    assert.deepEqual(writes, []);
    await persist();
    await writeFile(join(options.backupDirectory, 'github/latest.json'), 'changed after upload');
    await assert.rejects(
      applyReleaseRecovery(applyOptions()),
      /Recovery backup (size|digest) differs/,
    );
    assert.deepEqual(writes, []);
  });
});

test('backup manifest and snapshot cannot be replaced after persistence', async () => {
  await fixture(async ({ options, applyOptions, persist, writes }) => {
    await prepareReleaseRecovery(options);
    await persist();
    const snapshotPath = join(options.backupDirectory, 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath));
    snapshot.createdAt = 'changed-locally';
    const content = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
    await writeFile(snapshotPath, content);
    const manifestPath = join(options.backupDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath));
    const entry = manifest.files.find(({ path }) => path === 'snapshot.json');
    entry.size = content.length;
    entry.sha256 = sha256(content);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(applyReleaseRecovery(applyOptions()), /Persisted backup differs/);
    assert.deepEqual(writes, []);
  });
});

test('changed tags, updater heads or attachment bytes abort before the first reset', async () => {
  for (const change of [
    ({ setTag }) => setTag('f'.repeat(40)),
    ({ state }) => {
      state.gitee.updater.head = 'f'.repeat(40);
    },
    ({ downloads, state }) => {
      const asset = state.github.assets[0];
      downloads.set(asset.browser_download_url, Buffer.alloc(asset.size, 'x'));
    },
  ]) {
    await fixture(async (env) => {
      await prepareReleaseRecovery(env.options);
      await env.persist();
      change(env);
      await assert.rejects(applyReleaseRecovery(env.applyOptions()), /tag moved|state changed/);
      assert.deepEqual(env.writes, []);
    });
  }
});

test('published feeds and references to affected assets forbid a reset', async () => {
  for (const change of [
    (env) => {
      env.state.gitee.updater.latest.version = '0.4.0';
    },
    (env) => {
      env.state.github.updater.latest.version = '0.5.0';
    },
    (env) => {
      env.state.github.updater.latest.platforms['windows-x86_64'].url =
        `https://github.com/test/bubblefish/releases/download/v0.4.0/${env.artifacts[0].name}`;
    },
  ]) {
    await fixture(async (env) => {
      change(env);
      await assert.rejects(
        prepareReleaseRecovery(env.options),
        /published or newer|already references/,
      );
      assert.deepEqual(env.writes, []);
    });
  }
});

test('conflicting published installer bytes and unexpected old archive identity are rejected', async () => {
  for (const change of [
    (env) => env.add('gitee', env.artifacts[0].name, Buffer.from('different installer')),
    (env) => {
      env.state.github.updater.archive.releaseCommit = 'f'.repeat(40);
    },
    (env) => {
      env.options.expectedArchivedCommit = env.source.releaseCommit;
    },
  ]) {
    await fixture(async (env) => {
      change(env);
      await assert.rejects(
        prepareReleaseRecovery(env.options),
        /Published attachment differs|archive changed|must not reset/,
      );
      assert.deepEqual(env.writes, []);
    });
  }
});

test('an already correct archive resumes without resetting an advanced target feed', async () => {
  await fixture(async ({ options, state, applyOptions, persist, writes }) => {
    const archive = releaseMetadata(options.tag, options.source.releaseCommit, options.artifacts);
    state.github.updater.archive = archive;
    state.github.updater.archiveContent = `${JSON.stringify(archive)}\n`;
    state.github.updater.latest.version = '0.4.0';
    const result = await prepareReleaseRecovery(options);
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(result.reset, []);
    await persist();
    assert.equal((await applyReleaseRecovery(applyOptions())).status, 'unchanged');
    assert.deepEqual(writes, []);
    assert.deepEqual(state.github.updater.archive, archive);
  });
});

test('an interrupted reset can prepare a fresh attempt and only remove remaining obsolete records', async () => {
  await fixture(async ({ options, state, applyOptions, persist, writes }) => {
    state.gitee.updater.archive = structuredClone(state.github.updater.archive);
    state.gitee.updater.archiveContent = state.github.updater.archiveContent;
    await prepareReleaseRecovery(options);
    await persist();
    const remove = options.giteeStore.removeRelease;
    options.giteeStore.removeRelease = async () => {
      throw new Error('simulated second host push failure');
    };
    await assert.rejects(applyReleaseRecovery(applyOptions()), /second host push/);
    assert.deepEqual(writes, ['github']);
    options.giteeStore.removeRelease = remove;
    options.backupDirectory = join(options.source.directory, 'backup-attempt-three');
    options.runAttempt = '3';
    const result = await prepareReleaseRecovery(options);
    assert.deepEqual(result.reset, ['gitee']);
    assert.equal(result.backupName, 'release-recovery-v0.4.0-1234-3');
  });
});
