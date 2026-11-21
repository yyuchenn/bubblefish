import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { releaseMetadata } from './updater-artifacts.mjs';
import {
  assertReleaseIdentity,
  readReleaseSource,
  resolveGithubTag,
  verifyArtifactRun,
} from './release-source.mjs';
import { testArtifacts, testSigner } from './updater-test-helpers.mjs';

const execute = promisify(execFile);
const commit = 'a'.repeat(40),
  oldCommit = 'b'.repeat(40),
  tagObject = 'c'.repeat(40);
const tag = 'v0.4.0';

async function sourceFixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'bubblefish-release-source-'));
  const manifest = { version: '0.4.0' },
    config = { version: '0.4.0', plugins: { updater: { pubkey: 'release-specific-public-key' } } };
  const write = async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await mkdir(join(directory, 'src-tauri'), { recursive: true });
    await writeFile(join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify(config));
  };
  try {
    await write();
    await operation({ directory, manifest, config, write });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('reads an older source version and its key from a separate checkout with an annotated tag', async () => {
  await sourceFixture(async ({ directory, manifest, config, write }) => {
    manifest.version = config.version = '0.3.7';
    const sourceTag = 'v0.3.7';
    await write();
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.name', 'Release Test'],
      ['config', 'user.email', 'release@example.invalid'],
      ['add', '.'],
      ['commit', '--quiet', '-m', 'Release source'],
      ['tag', '-a', sourceTag, '-m', 'Annotated release'],
    ])
      await execute('git', args, { cwd: directory });
    const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: directory });
    assert.deepEqual(await readReleaseSource(directory, sourceTag), {
      directory,
      version: '0.3.7',
      publicKey: config.plugins.updater.pubkey,
      releaseCommit: stdout.trim(),
    });
  });
});

test('rejects a source checkout at a different commit from its local release tag', async () => {
  await sourceFixture(async ({ directory }) => {
    await assert.rejects(
      readReleaseSource(directory, tag, {
        run: async (_binary, _args, options) => {
          assert.equal(options.cwd, directory);
          return { stdout: `${commit}\n${oldCommit}\n` };
        },
      }),
      (error) => {
        assert.ok(error.message.includes(commit));
        assert.ok(error.message.includes(oldCommit));
        assert.match(error.message, /check out the release tag/);
        return true;
      },
    );
  });
});

test('rejects mismatched source versions, missing keys and malformed source commits', async () => {
  for (const change of [
    ({ manifest }) => {
      manifest.version = '0.5.0';
    },
    ({ manifest, config }) => {
      manifest.version = config.version = '0.5.0';
    },
    ({ config }) => {
      delete config.plugins.updater.pubkey;
    },
  ])
    await sourceFixture(async (fixture) => {
      change(fixture);
      await fixture.write();
      await assert.rejects(
        readReleaseSource(fixture.directory, tag, {
          run: async () => ({ stdout: `${commit}\n${commit}\n` }),
        }),
      );
    });
  await sourceFixture(async ({ directory }) => {
    await assert.rejects(
      readReleaseSource(directory, tag, {
        run: async () => ({ stdout: 'invalid\ninvalid\n' }),
      }),
      /Invalid release source HEAD/,
    );
    await assert.rejects(readReleaseSource(directory, 'refs/heads/main'), /Invalid release tag/);
  });
});

test('resolves lightweight and nested annotated GitHub tags without writing any refs', async () => {
  for (const annotated of [false, true]) {
    const calls = [];
    const github = {
      json: async (path) => {
        calls.push(path);
        if (path === `/git/ref/tags/${tag}`)
          return {
            object: { type: annotated ? 'tag' : 'commit', sha: annotated ? tagObject : commit },
          };
        if (path === `/git/tags/${tagObject}`) return { object: { type: 'tag', sha: oldCommit } };
        assert.equal(path, `/git/tags/${oldCommit}`);
        return { object: { type: 'commit', sha: commit } };
      },
    };
    assert.equal(await resolveGithubTag(github, tag), commit);
    assert.deepEqual(
      calls,
      annotated
        ? [`/git/ref/tags/${tag}`, `/git/tags/${tagObject}`, `/git/tags/${oldCommit}`]
        : [`/git/ref/tags/${tag}`],
    );
  }
});

test('rejects malformed, non-commit and cyclic tag objects', async () => {
  for (const object of [
    { type: 'commit', sha: 'bad' },
    { type: 'tree', sha: commit },
  ])
    await assert.rejects(resolveGithubTag({ json: async () => ({ object }) }, tag));
  let reads = 0;
  await assert.rejects(
    resolveGithubTag(
      {
        json: async () => {
          reads++;
          return { object: { type: 'tag', sha: tagObject } };
        },
      },
      tag,
    ),
    /cycle/,
  );
  assert.equal(reads, 2);
});

function identityEnvironment({
  githubArchive = null,
  giteeArchive = null,
  liveCommit = commit,
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      tag,
      source: { releaseCommit: commit },
      github: {
        json: async (path, options) => {
          assert.equal(options, undefined, 'Preflight must not make a write request');
          assert.equal(path, `/git/ref/tags/${tag}`);
          calls.push('tag-read');
          return { object: { type: 'commit', sha: liveCommit } };
        },
      },
      githubStore: {
        readRelease: async () => {
          calls.push('github-read');
          return githubArchive;
        },
      },
      giteeStore: {
        readRelease: async () => {
          calls.push('gitee-read');
          return giteeArchive;
        },
      },
    },
  };
}
const archive = (sha = commit) => releaseMetadata(tag, sha, testArtifacts(testSigner()));

test('preflight permits missing or matching archives on both hosts', async () => {
  for (const metadata of [null, archive()]) {
    const env = identityEnvironment({ githubArchive: metadata, giteeArchive: metadata });
    assert.deepEqual(await assertReleaseIdentity(env.options), {
      github: metadata,
      gitee: metadata,
    });
    assert.deepEqual(env.calls, ['tag-read', 'github-read', 'gitee-read']);
  }
});

test('preflight rejects a moved live tag before loading either archive', async () => {
  const env = identityEnvironment({ liveCommit: oldCommit });
  await assert.rejects(assertReleaseIdentity(env.options), (error) => {
    assert.ok(error.message.includes(commit));
    assert.ok(error.message.includes(oldCommit));
    assert.match(error.message, /GitHub tag v0.4.0 moved/);
    return true;
  });
  assert.deepEqual(env.calls, ['tag-read']);
});

test('archive conflicts identify the host, archive and both source commits before publication', async () => {
  for (const host of ['github', 'gitee']) {
    const env = identityEnvironment({ [`${host}Archive`]: archive(oldCommit) });
    await assert.rejects(assertReleaseIdentity(env.options), (error) => {
      assert.ok(error.message.includes(host === 'github' ? 'GitHub' : 'Gitee'));
      assert.ok(error.message.includes(`updater/releases/${tag}.json`));
      assert.ok(error.message.includes(oldCommit));
      assert.ok(error.message.includes(`source HEAD=${commit}`));
      assert.match(error.message, /audited reset/);
      return true;
    });
  }
});

test('recovery preflight permits only the explicitly allowed archived commit and still checks the live tag', async () => {
  const metadata = archive(oldCommit);
  const env = identityEnvironment({ githubArchive: metadata, giteeArchive: metadata });
  assert.deepEqual(
    await assertReleaseIdentity({ ...env.options, allowArchivedCommit: oldCommit }),
    {
      github: metadata,
      gitee: metadata,
    },
  );
  await assert.rejects(
    assertReleaseIdentity({ ...env.options, allowArchivedCommit: tagObject }),
    /records commit/,
  );
  await assert.rejects(
    assertReleaseIdentity({ ...env.options, allowArchivedCommit: 'bad' }),
    /Invalid allowed/,
  );
  const moved = identityEnvironment({ liveCommit: oldCommit, githubArchive: metadata });
  await assert.rejects(
    assertReleaseIdentity({ ...moved.options, allowArchivedCommit: oldCommit }),
    /moved/,
  );
});

function artifactEnvironment() {
  const runId = '44687676350',
    calls = [];
  const run = {
    id: Number(runId),
    repository: { full_name: 'test/bubblefish' },
    path: '.github/workflows/build-desktop.yml',
    event: 'release',
    head_sha: commit,
    status: 'completed',
    conclusion: 'failure',
  };
  const jobs = [
    { name: 'Windows x64 installers', status: 'completed', conclusion: 'success' },
    { name: 'macOS ARM64 installer', status: 'completed', conclusion: 'success' },
    {
      name: 'Publish signed desktop release and update feeds',
      status: 'completed',
      conclusion: 'failure',
    },
  ];
  const artifacts = ['bubblefish-windows-x64', 'bubblefish-macos-arm64'].map((name, index) => ({
    id: index + 1,
    name,
    expired: false,
    size_in_bytes: 100,
  }));
  const github = {
    repository: 'test/bubblefish',
    json: async (path, options) => {
      assert.equal(options, undefined, 'Artifact preflight is read-only');
      calls.push(path);
      const url = new URL(path, 'https://api.github.com');
      if (url.pathname.endsWith('/jobs')) {
        assert.equal(url.searchParams.get('filter'), 'latest');
        const page = Number(url.searchParams.get('page'));
        return { jobs: jobs.slice((page - 1) * 100, page * 100) };
      }
      if (url.pathname.endsWith('/artifacts')) {
        const page = Number(url.searchParams.get('page'));
        return { artifacts: artifacts.slice((page - 1) * 100, page * 100) };
      }
      assert.equal(path, `/actions/runs/${runId}`);
      return run;
    },
  };
  return { runId, run, jobs, artifacts, github, calls };
}

test('accepts completed release builds even when their later publishing job failed', async () => {
  const env = artifactEnvironment();
  env.artifacts[0].workflow_run = { head_sha: commit };
  env.artifacts[0].expires_at = '2999-01-01T00:00:00Z';
  assert.equal(await verifyArtifactRun(env.github, env.runId, commit), env.runId);
  assert.equal(env.calls.length, 3);
});

test('rejects a foreign, unsigned, unfinished or differently sourced artifact run', async () => {
  for (const change of [
    ({ run }) => {
      run.id++;
    },
    ({ run }) => {
      run.repository.full_name = 'other/repo';
    },
    ({ run }) => {
      run.path = '.github/workflows/build-plugins.yml';
    },
    ({ run }) => {
      run.event = 'workflow_dispatch';
    },
    ({ run }) => {
      run.head_sha = oldCommit;
    },
    ({ run }) => {
      run.status = 'in_progress';
    },
  ]) {
    const env = artifactEnvironment();
    change(env);
    await assert.rejects(verifyArtifactRun(env.github, env.runId, commit));
    assert.equal(env.calls.length, 1, 'Reject the wrong run before reading its outputs');
  }
  for (const runId of ['', '0', '-1', '123?query=bad', 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(verifyArtifactRun(artifactEnvironment().github, runId, commit));
});

test('requires both successful build jobs and unique, nonempty, unexpired desktop artifacts', async () => {
  for (const change of [
    ({ jobs }) => {
      jobs.shift();
    },
    ({ jobs }) => {
      jobs.push({ ...jobs[0] });
    },
    ({ jobs }) => {
      jobs[0].conclusion = 'failure';
    },
    ({ jobs }) => {
      jobs[1].status = 'in_progress';
    },
    ({ artifacts }) => {
      artifacts.pop();
    },
    ({ artifacts }) => {
      artifacts.push({ ...artifacts[0] });
    },
    ({ artifacts }) => {
      artifacts[0].expired = true;
    },
    ({ artifacts }) => {
      artifacts[1].size_in_bytes = 0;
    },
    ({ artifacts }) => {
      artifacts[0].workflow_run = { head_sha: oldCommit };
    },
    ({ artifacts }) => {
      artifacts[0].expires_at = '2000-01-01T00:00:00Z';
    },
    ({ artifacts }) => {
      artifacts[0].expires_at = 'invalid';
    },
  ]) {
    const env = artifactEnvironment();
    change(env);
    await assert.rejects(verifyArtifactRun(env.github, env.runId, commit));
  }
});

test('finds desktop build outputs beyond the first Actions API page', async () => {
  const env = artifactEnvironment();
  env.jobs.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({ name: `unrelated job ${index}` })),
  );
  env.artifacts.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({ name: `unrelated artifact ${index}` })),
  );
  assert.equal(await verifyArtifactRun(env.github, env.runId, commit), env.runId);
  assert.equal(env.calls.filter((path) => path.endsWith('page=2')).length, 2);
});
