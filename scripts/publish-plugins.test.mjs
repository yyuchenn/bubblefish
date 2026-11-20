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
    releaseCommit: 'a'.repeat(40),
    sourceDirectory: '/source',
    artifacts: packages(),
    github: {
      release: async (tag) => {
        assert.equal(tag, release.tag_name);
        calls.push('release');
        return release;
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
      ensureTag: async (directory, tag, commit) => {
        assert.equal(directory, '/source');
        assert.equal(tag, release.tag_name);
        assert.equal(commit, 'a'.repeat(40));
        calls.push('gitee-tag');
      },
      publish: () => assert.fail('Plugin publication must not publish update feeds'),
      archiveRelease: () => assert.fail('Plugins must not change installer signature archives'),
    },
  };
  return { options, release, calls, githubPackages, giteePackages };
}

test('collects all seven packages from nested current-run artifacts and excludes other files', async () => {
  await fixture(async ({ directory }) => {
    await writeFile(join(directory, 'models.bfmodel'), 'separate model package');
    await writeFile(join(directory, 'installer.exe'), 'desktop installer');
    await writeFile(join(directory, 'installer.exe.sig'), 'desktop signature');
    const actual = await readPluginArtifacts(directory);
    assert.deepEqual(actual, packages());
  });
});

test('rejects empty or incomplete artifact sets and duplicate or unexpected package names', async () => {
  await fixture(async ({ directory, paths }) => {
    const missing = pluginPackageNames[0];
    await rm(paths.get(missing));
    await assert.rejects(readPluginArtifacts(directory), /Missing plugin package/);
    await writeFile(paths.get(missing), 'restored');
    const duplicateDirectory = join(directory, 'duplicate');
    await mkdir(duplicateDirectory);
    const duplicate = join(duplicateDirectory, missing);
    await writeFile(duplicate, 'duplicate');
    await assert.rejects(readPluginArtifacts(directory), /Duplicate plugin package/);
    await rm(duplicate);
    await writeFile(join(directory, 'unintended.bfplugin'), 'unexpected');
    await assert.rejects(readPluginArtifacts(directory), /Unexpected plugin package/);
  });
  const empty = await mkdtemp(join(tmpdir(), 'bubblefish-empty-plugins-'));
  try {
    await assert.rejects(readPluginArtifacts(empty), /Missing plugin package/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
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

test('publishes all seven plugin packages to both hosts without touching updater state', async () => {
  const { options, calls, githubPackages, giteePackages } = environment();
  const result = await publishPlugins(options);
  assert.equal(result.status, 'published');
  assert.equal(result.version, '0.4.0');
  assert.deepEqual(result.packages, pluginPackageNames);
  assert.deepEqual([...githubPackages], [...giteePackages]);
  assert.equal(githubPackages.size, 7);
  assert.equal(Object.keys(result.github).length, 7);
  assert.equal(Object.keys(result.gitee).length, 7);
  assert.deepEqual(calls, ['release', 'github-assets', 'gitee-tag', 'gitee-assets']);
});

test('invalid packages and release identity stop publication before any attachment writes', async () => {
  for (const change of [
    (env) => {
      env.options.artifacts = [];
    },
    (env) => {
      env.options.artifacts.pop();
    },
    (env) => {
      env.options.artifacts.push(env.options.artifacts[0]);
    },
    (env) => {
      env.options.artifacts[0].name = '../unsafe.bfplugin';
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
      env.options.releaseCommit = 'not-a-commit';
    },
    (env) => {
      env.options.releaseCommit = 'a'.repeat(41);
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

test('a failed mirror can be retried independently using the same seven packages', async () => {
  const env = environment();
  const mirror = env.options.gitee.mirror;
  env.options.gitee.mirror = async () => {
    env.calls.push('gitee-failed');
    throw new Error('Simulated Gitee upload failure');
  };
  await assert.rejects(publishPlugins(env.options), /Simulated Gitee/);
  assert.equal(env.githubPackages.size, 7);
  assert.equal(env.giteePackages.size, 0);
  env.options.gitee.mirror = mirror;
  await publishPlugins(env.options);
  assert.equal(env.githubPackages.size, 7);
  assert.equal(env.giteePackages.size, 7);
  assert.deepEqual(env.calls, [
    'release',
    'github-assets',
    'gitee-tag',
    'gitee-failed',
    'release',
    'github-assets',
    'gitee-tag',
    'gitee-assets',
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
  assert.equal(prerelease.giteePackages.size, 7);
});
