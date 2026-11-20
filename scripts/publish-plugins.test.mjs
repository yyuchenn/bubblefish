import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { giteeAttachmentLimit } from './updater-api.mjs';
import { pluginPackageNames, publishPlugins, readPluginArtifacts } from './publish-plugins.mjs';
import { testRelease } from './updater-test-helpers.mjs';

const packages = () =>
  pluginPackageNames.map((name) => ({ name, bytes: Buffer.from(`compiled package: ${name}`) }));
const sortedNames = (names) => [...names].sort();
const packageNames = (artifacts) => sortedNames(artifacts.map(({ name }) => name));
const examplePackageNames = [
  'example.document-toolbox.bfplugin',
  'example.history-inspector.bfplugin',
  'example.edit-guard.bfplugin',
];

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-plugin-release-'));
  const paths = new Map();
  try {
    for (const [index, { name, bytes }] of packages().entries()) {
      const group = join(directory, `artifact-${index % 3}`);
      await mkdir(group, { recursive: true });
      const path = join(group, name);
      await writeFile(path, bytes);
      paths.set(name, path);
    }
    await operation({ directory, paths });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function environment() {
  const release = testRelease(),
    calls = [],
    readAssetRequests = [],
    githubPackages = new Map(),
    giteePackages = new Map();
  const upload = (host, stored, artifacts) => {
    const urls = {};
    for (const { name, bytes } of artifacts) {
      if (stored.has(name))
        assert.deepEqual(stored.get(name), bytes, `Conflicting package: ${name}`);
      else stored.set(name, Buffer.from(bytes));
      urls[name] = `https://${host}/test/bubblefish/releases/download/${release.tag_name}/${name}`;
    }
    return urls;
  };
  const options = {
    tag: release.tag_name,
    expectedVersion: '0.4.0',
    artifacts: packages(),
    github: {
      release: async (tag) => {
        assert.equal(tag, release.tag_name);
        calls.push('release');
        return release;
      },
      readAssets: async (target, names) => {
        assert.equal(target, release);
        assert.ok(names.every((name) => pluginPackageNames.includes(name)));
        assert.equal(new Set(names).size, names.length);
        calls.push('read-assets');
        readAssetRequests.push([...names]);
        return [...githubPackages]
          .filter(([name]) => names.includes(name))
          .map(([name, bytes]) => ({ name, bytes }));
      },
      uploadAssets: async (target, artifacts) => {
        assert.equal(target, release);
        calls.push('github-assets');
        return upload('github.com', githubPackages, artifacts);
      },
    },
    gitee: {
      mirror: async (target, artifacts) => {
        assert.equal(target, release);
        calls.push('gitee-assets');
        return upload('gitee.com', giteePackages, artifacts);
      },
    },
    giteeStore: {
      ensureTag: () => assert.fail('Plugin publication must not synchronize source tags'),
      publish: () => assert.fail('Plugin publication must not publish update feeds'),
      archiveRelease: () => assert.fail('Plugins must not change installer signature archives'),
    },
  };
  return { options, release, calls, readAssetRequests, githubPackages, giteePackages };
}

test('only the four official plugin package filenames are publishable', () => {
  assert.deepEqual(
    sortedNames(pluginPackageNames),
    sortedNames([
      'deepseek-translation-plugin.bfplugin',
      'kha-white-ocr-plugin-web.bfplugin',
      'kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin',
      'kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin',
    ]),
  );
});

test('collects official packages in fixed order and ignores examples, signatures and models', async () => {
  await fixture(async ({ directory }) => {
    await writeFile(join(directory, 'models.bfmodel'), 'separate model package');
    await writeFile(join(directory, 'installer.exe'), 'desktop installer');
    await writeFile(join(directory, 'installer.exe.sig'), 'desktop signature');
    for (const name of examplePackageNames)
      await writeFile(join(directory, name), 'legacy example package');
    const actual = await readPluginArtifacts(directory);
    assert.deepEqual(actual, packages());
  });
});

test('accepts an incomplete artifact set when a plugin build did not produce a package', async () => {
  await fixture(async ({ directory, paths }) => {
    const missing = pluginPackageNames[0];
    await rm(paths.get(missing));
    assert.deepEqual(
      packageNames(await readPluginArtifacts(directory)),
      sortedNames(pluginPackageNames.filter((name) => name !== missing)),
    );
  });
});

test('returns no packages for empty or missing artifact roots', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'bubblefish-empty-plugins-'));
  try {
    assert.deepEqual(await readPluginArtifacts(empty), []);
    assert.deepEqual(await readPluginArtifacts(join(empty, 'missing')), []);
    for (const name of examplePackageNames)
      await writeFile(join(empty, name), 'legacy example package');
    assert.deepEqual(await readPluginArtifacts(empty), []);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('rejects duplicate official and unexpected package names', async () => {
  await fixture(async ({ directory }) => {
    const name = pluginPackageNames[0];
    const duplicateDirectory = join(directory, 'duplicate');
    await mkdir(duplicateDirectory);
    const duplicate = join(duplicateDirectory, name);
    await writeFile(duplicate, 'duplicate');
    await assert.rejects(readPluginArtifacts(directory), /Duplicate plugin package/);
    await rm(duplicate);
    await writeFile(join(directory, 'unintended.bfplugin'), 'unexpected');
    await assert.rejects(readPluginArtifacts(directory), /Unexpected plugin package/);
  });
});

test('rejects oversized and empty files before reading package bytes', async () => {
  await fixture(async ({ directory, paths }) => {
    const path = paths.get(pluginPackageNames[0]);
    await truncate(path, giteeAttachmentLimit + 1);
    await assert.rejects(readPluginArtifacts(directory), /exceeds 100 MB/);
    await truncate(path, 0);
    await assert.rejects(readPluginArtifacts(directory), /Empty or invalid plugin package/);
  });
});

test('rejects unsafe package names and artifact symlinks', async () => {
  await fixture(async ({ directory }) => {
    const unsafe = join(directory, 'unsafe name.bfplugin');
    await writeFile(unsafe, 'unsafe');
    await assert.rejects(readPluginArtifacts(directory), /Unsafe plugin package filename/);
    await rm(unsafe);
    await symlink(directory, join(directory, 'linked-artifacts'), 'junction');
    await assert.rejects(readPluginArtifacts(directory), /Symbolic links/);
  });
});

test('publishes all four official packages to both hosts without touching updater state', async () => {
  const { options, calls, githubPackages, giteePackages } = environment();
  const result = await publishPlugins(options);
  assert.equal(result.status, 'published');
  assert.equal(result.version, '0.4.0');
  assert.deepEqual(sortedNames(result.packages), sortedNames(pluginPackageNames));
  assert.deepEqual(result.missingPackages, []);
  assert.deepEqual([...githubPackages], [...giteePackages]);
  assert.equal(githubPackages.size, 4);
  assert.equal(Object.keys(result.github).length, 4);
  assert.equal(Object.keys(result.gitee).length, 4);
  assert.deepEqual(calls, ['release', 'github-assets', 'gitee-assets']);
});

test('publishes available packages when web or individual native builds fail', async () => {
  for (const available of [
    ['deepseek-translation-plugin.bfplugin', 'kha-white-ocr-plugin-web.bfplugin'],
    ['kha-white-ocr-plugin-web.bfplugin', 'kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin'],
    ['deepseek-translation-plugin.bfplugin', 'kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin'],
    ['kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin'],
  ]) {
    const env = environment();
    env.options.artifacts = packages().filter(({ name }) => available.includes(name));
    const result = await publishPlugins(env.options);
    assert.equal(result.status, 'published');
    assert.deepEqual(sortedNames(result.packages), sortedNames(available));
    assert.deepEqual(
      sortedNames(result.missingPackages),
      sortedNames(pluginPackageNames.filter((name) => !available.includes(name))),
    );
    assert.deepEqual(sortedNames(env.githubPackages.keys()), sortedNames(available));
    assert.deepEqual([...env.githubPackages], [...env.giteePackages]);
    assert.deepEqual(env.calls, ['release', 'github-assets', 'gitee-assets']);
  }
});

test('an empty local artifact set skips publication without querying either host', async () => {
  const env = environment();
  env.options.artifacts = [];
  const result = await publishPlugins(env.options);
  assert.equal(result.status, 'skipped');
  assert.equal(result.version, '0.4.0');
  assert.deepEqual(result.packages, []);
  assert.deepEqual(sortedNames(result.missingPackages), sortedNames(pluginPackageNames));
  assert.deepEqual(env.calls, []);
  assert.equal(env.githubPackages.size, 0);
  assert.equal(env.giteePackages.size, 0);
});

test('invalid packages and release identity stop publication before any attachment writes', async () => {
  for (const change of [
    (env) => {
      env.options.artifacts.push(env.options.artifacts[0]);
    },
    (env) => {
      env.options.artifacts[0].name = '../unsafe.bfplugin';
    },
    (env) => {
      env.options.artifacts[0].name = 'unintended.bfplugin';
    },
    (env) => {
      env.options.artifacts[0].bytes = { length: giteeAttachmentLimit + 1 };
    },
    (env) => {
      env.options.artifacts[0].bytes = Buffer.alloc(0);
    },
    (env) => {
      env.options.expectedVersion = '0.5.0';
    },
    (env) => {
      env.release.draft = true;
    },
    (env) => {
      env.release.published_at = 'invalid date';
    },
    (env) => {
      env.release.tag_name = 'v0.5.0';
    },
  ]) {
    const env = environment();
    change(env);
    await assert.rejects(publishPlugins(env.options));
    assert.ok(env.calls.every((call) => call === 'release'));
  }
});

test('manual publication reads available official GitHub assets without requiring a rebuild', async () => {
  for (const available of [pluginPackageNames, [pluginPackageNames[0]], []]) {
    const env = environment();
    delete env.options.artifacts;
    for (const { name, bytes } of packages())
      if (available.includes(name)) env.githubPackages.set(name, bytes);
    for (const name of [...examplePackageNames, 'installer.exe.sig'])
      env.githubPackages.set(name, Buffer.from('legacy release attachment'));
    const result = await publishPlugins(env.options);
    assert.equal(result.status, available.length ? 'published' : 'skipped');
    assert.deepEqual(sortedNames(result.packages), sortedNames(available));
    assert.deepEqual(
      sortedNames(result.missingPackages),
      sortedNames(pluginPackageNames.filter((name) => !available.includes(name))),
    );
    assert.deepEqual(sortedNames(env.giteePackages.keys()), sortedNames(available));
    assert.deepEqual(env.readAssetRequests, [pluginPackageNames]);
    assert.deepEqual(
      env.calls,
      available.length
        ? ['release', 'read-assets', 'github-assets', 'gitee-assets']
        : ['release', 'read-assets'],
    );
  }
});

test('remote packages and release identity are validated before any manual repair writes', async () => {
  for (const change of [
    (env) => {
      env.options.expectedVersion = '0.5.0';
    },
    (env) => {
      env.release.draft = true;
    },
    (env) => {
      env.release.published_at = null;
    },
    (env) => {
      env.release.published_at = 'invalid date';
    },
    (env) => {
      env.options.github.readAssets = async () => [packages()[0], packages()[0]];
    },
    (env) => {
      env.options.github.readAssets = async () => [
        { name: 'unexpected.bfplugin', bytes: Buffer.from('payload') },
      ];
    },
    (env) => {
      env.options.github.readAssets = async () => [{ ...packages()[0], bytes: Buffer.alloc(0) }];
    },
  ]) {
    const env = environment();
    delete env.options.artifacts;
    change(env);
    await assert.rejects(publishPlugins(env.options));
    assert.ok(env.calls.every((call) => ['release', 'read-assets'].includes(call)));
    assert.equal(env.githubPackages.size, 0);
    assert.equal(env.giteePackages.size, 0);
  }
});

test('Gitee-only repair mirrors local or existing GitHub packages without GitHub writes', async () => {
  for (const useLocal of [true, false]) {
    const env = environment();
    env.options.mirrorOnly = true;
    const available = packages().slice(0, 2);
    for (const { name, bytes } of available) env.githubPackages.set(name, bytes);
    if (useLocal) env.options.artifacts = available;
    else delete env.options.artifacts;
    const githubBefore = [...env.githubPackages];
    env.options.github.uploadAssets = () =>
      assert.fail('Gitee-only repair must not upload to GitHub');
    const result = await publishPlugins(env.options);
    assert.equal(result.status, 'published');
    assert.deepEqual(sortedNames(result.packages), packageNames(available));
    assert.deepEqual(sortedNames(env.giteePackages.keys()), packageNames(available));
    assert.deepEqual([...env.githubPackages], githubBefore);
    assert.deepEqual(env.calls, ['release', 'read-assets', 'gitee-assets']);
    assert.deepEqual(env.readAssetRequests, [
      useLocal ? available.map(({ name }) => name) : pluginPackageNames,
    ]);
  }
});

test('Gitee-only repair rejects local packages missing from or different to their GitHub originals', async () => {
  for (const changedBytes of [false, true]) {
    const env = environment();
    env.options.mirrorOnly = true;
    env.options.artifacts = packages().slice(0, 1);
    const [{ name }] = env.options.artifacts;
    if (changedBytes) env.githubPackages.set(name, Buffer.from('different published package'));
    const githubBefore = [...env.githubPackages];
    env.options.github.uploadAssets = () =>
      assert.fail('Gitee-only repair must not upload to GitHub');
    await assert.rejects(publishPlugins(env.options), (error) => {
      assert.ok(
        error.message.includes(
          changedBytes
            ? `Published attachment differs: ${name}`
            : `Missing published GitHub plugin: ${name}`,
        ),
      );
      return true;
    });
    assert.deepEqual(env.calls, ['release', 'read-assets']);
    assert.deepEqual(env.readAssetRequests, [[name]]);
    assert.deepEqual([...env.githubPackages], githubBefore);
    assert.equal(env.giteePackages.size, 0);
  }
});

test('a failed mirror can resume using the same partial package set without replacing assets', async () => {
  const env = environment();
  env.options.artifacts = packages().slice(0, 2);
  const mirror = env.options.gitee.mirror;
  env.options.gitee.mirror = async () => {
    env.calls.push('gitee-failed');
    throw new Error('Simulated Gitee upload failure');
  };
  await assert.rejects(publishPlugins(env.options), /Simulated Gitee/);
  assert.equal(env.githubPackages.size, 2);
  assert.equal(env.giteePackages.size, 0);
  env.options.gitee.mirror = mirror;
  await publishPlugins(env.options);
  assert.equal(env.githubPackages.size, 2);
  assert.equal(env.giteePackages.size, 2);
  assert.deepEqual(env.calls, [
    'release',
    'github-assets',
    'gitee-failed',
    'release',
    'github-assets',
    'gitee-assets',
  ]);
});

test('same-tag repairs reject changed bytes in an already published package', async () => {
  const env = environment();
  env.options.artifacts = packages().slice(0, 1);
  await publishPlugins(env.options);
  const before = [...env.giteePackages];
  env.options.artifacts = [
    { ...env.options.artifacts[0], bytes: Buffer.from('different rebuild') },
  ];
  await assert.rejects(publishPlugins(env.options), /Conflicting package/);
  assert.deepEqual([...env.giteePackages], before);
  assert.deepEqual(env.calls, [
    'release',
    'github-assets',
    'gitee-assets',
    'release',
    'github-assets',
  ]);
});

test('GitHub upload failure stops later writes and prereleases may publish plugins', async () => {
  const failed = environment();
  failed.options.github.uploadAssets = async () => {
    throw new Error('Simulated GitHub upload failure');
  };
  await assert.rejects(publishPlugins(failed.options), /Simulated GitHub/);
  assert.deepEqual(failed.calls, ['release']);
  const prerelease = environment();
  prerelease.release.prerelease = true;
  assert.equal((await publishPlugins(prerelease.options)).status, 'published');
  assert.equal(prerelease.giteePackages.size, 4);
});
