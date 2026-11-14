import assert from 'node:assert/strict';
import {
  sha256,
  selectArtifacts,
  verifyArtifacts,
  verifyUpdaterSignature,
} from './updater-artifacts.mjs';

export const giteeAttachmentLimit = 100_000_000;

export function repositoryPath(value) {
  assert.match(value ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Expected owner/repository');
  return value;
}

function publicUrl(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === 'https:' && !url.username && !url.password,
    'Expected a public HTTPS download URL',
  );
  assert.ok(!url.searchParams.has('access_token'), 'Download URLs must not contain an API token');
  return url.href;
}

export class ReleaseHttp {
  constructor({
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async response(url, options = {}, { missing = false } = {}) {
    const method = options.method ?? 'GET';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
      } catch {
        if (method === 'GET' && attempt < 3) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error(
          `${method} ${new URL(url).hostname}${new URL(url).pathname}: network request failed`,
        );
      }
      if (missing && response.status === 404) return null;
      if (response.ok) return response;
      // Retrying writes after an ambiguous response can create duplicate assets.
      // A later run lists and validates the existing release before resuming.
      if (method === 'GET' && [429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error(
        `${method} ${new URL(url).hostname}${new URL(url).pathname}: HTTP ${response.status}`,
      );
    }
  }

  async json(url, options, flags) {
    const response = await this.response(url, options, flags);
    return response ? response.json() : null;
  }

  async download(url) {
    // Deliberately omit API authorization, including when the server redirects.
    const response = await this.response(publicUrl(url));
    const contentLength = Number(response.headers.get('content-length'));
    assert.ok(
      !contentLength || contentLength <= giteeAttachmentLimit,
      'Release attachment exceeds Gitee limit',
    );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > giteeAttachmentLimit) {
        await response.body.cancel().catch(() => {});
        throw new Error('Release attachment exceeds Gitee limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

class ReleaseApi {
  constructor({ repository, token, http = new ReleaseHttp(), host }) {
    this.repository = repositoryPath(repository);
    assert.ok(token, `${host === 'api.github.com' ? 'GITHUB_TOKEN' : 'GITEE_TOKEN'} is required`);
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    this.http = http;
    this.base = `https://${host}/repos/${this.repository}`;
  }

  json(path, { method = 'GET', body, missing = false } = {}) {
    return this.http.json(
      `${this.base}${path}`,
      {
        method,
        headers: {
          ...this.headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { missing },
    );
  }

  async list(path) {
    const entries = [];
    for (let page = 1; ; page++) {
      const batch = await this.json(`${path}?per_page=100&page=${page}`);
      assert.ok(Array.isArray(batch), 'Expected an attachment list');
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
  }

  async existingBytes(asset, expected) {
    const bytes = await this.http.download(asset.browser_download_url);
    assert.equal(sha256(bytes), sha256(expected), `Published attachment differs: ${asset.name}`);
    return bytes;
  }
}

export class GithubReleaseApi extends ReleaseApi {
  constructor(options) {
    super({ ...options, host: 'api.github.com' });
  }

  release(tag) {
    return this.json(`/releases/tags/${encodeURIComponent(tag)}`);
  }

  assets(release) {
    return this.list(`/releases/${release.id}/assets`);
  }

  async readArtifacts(release, version, publicKey) {
    const assets = await this.assets(release);
    const selected = selectArtifacts(assets, version);
    const names = new Set(selected.flatMap(({ name }) => [name, `${name}.sig`]));
    const entries = await Promise.all(
      assets
        .filter(({ name }) => names.has(name))
        .map(async (entry) => ({
          ...entry,
          bytes: await this.http.download(entry.browser_download_url),
        })),
    );
    return verifyArtifacts(entries, version, publicKey);
  }

  async publish(release, artifacts, version, publicKey) {
    const assets = await this.assets(release);
    const byName = (name) => {
      const matches = assets.filter((entry) => entry.name === name);
      assert.ok(matches.length <= 1, `Duplicate GitHub attachment: ${name}`);
      return matches[0];
    };
    const upload = async (name, bytes) => {
      let asset = byName(name);
      if (asset) await this.existingBytes(asset, bytes);
      else {
        const url = new URL(release.upload_url.replace(/\{.*$/, ''));
        assert.equal(url.origin, 'https://uploads.github.com', 'Unexpected GitHub upload origin');
        url.searchParams.set('name', name);
        asset = await this.http.json(url.href, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        assert.equal(asset.name, name, 'GitHub changed attachment name');
        assets.push(asset);
        await this.existingBytes(asset, bytes);
      }
      return publicUrl(asset.browser_download_url);
    };
    const urls = {};
    const canonical = [];
    for (const artifact of artifacts) {
      // A re-sign of identical installer bytes has a different timestamp. Reuse
      // the already published, valid signature rather than mutate that asset.
      const publishedSignature = byName(`${artifact.name}.sig`);
      const signatureBytes = publishedSignature
        ? await this.http.download(publishedSignature.browser_download_url)
        : artifact.signatureBytes;
      const signature = signatureBytes.toString('utf8').trim();
      verifyUpdaterSignature(artifact.bytes, signature, publicKey, {
        version,
        filename: artifact.name,
      });
      urls[artifact.name] = await upload(artifact.name, artifact.bytes);
      urls[`${artifact.name}.sig`] = await upload(`${artifact.name}.sig`, signatureBytes);
      canonical.push({ ...artifact, signature, signatureBytes });
    }
    return { artifacts: canonical, urls };
  }
}

export class GiteeReleaseApi extends ReleaseApi {
  constructor(options) {
    super({ ...options, host: 'gitee.com/api/v5' });
  }

  async ensureRelease(source) {
    const path = `/releases/tags/${encodeURIComponent(source.tag_name)}`;
    const existing = await this.json(path, { missing: true });
    if (existing) {
      assert.equal(existing.tag_name, source.tag_name, 'Gitee release tag differs');
      return existing;
    }
    return this.json('/releases', {
      method: 'POST',
      body: {
        tag_name: source.tag_name,
        target_commitish: source.tag_name,
        name: source.name || source.tag_name,
        body: source.body || '',
        prerelease: Boolean(source.prerelease),
      },
    });
  }

  async mirror(source, artifacts) {
    for (const artifact of artifacts)
      assert.ok(
        artifact.bytes.length <= giteeAttachmentLimit,
        `Gitee attachment exceeds 100 MB: ${artifact.name}`,
      );
    const release = await this.ensureRelease(source);
    assert.ok(Number.isInteger(release.id) && release.id > 0, 'Invalid Gitee release ID');
    const path = `/releases/${release.id}/attach_files`;
    const assets = await this.list(path);
    const urls = {};
    for (const artifact of artifacts) {
      for (const [name, bytes] of [
        [artifact.name, artifact.bytes],
        [`${artifact.name}.sig`, artifact.signatureBytes],
      ]) {
        const matches = assets.filter((entry) => entry.name === name);
        assert.ok(matches.length <= 1, `Duplicate Gitee attachment: ${name}`);
        let asset = matches[0];
        if (!asset) {
          const body = new FormData();
          body.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
          asset = await this.http.json(`${this.base}${path}`, {
            method: 'POST',
            headers: this.headers,
            body,
          });
          assert.equal(asset.name, name, 'Gitee changed attachment name');
          assets.push(asset);
        }
        // The API owns the URL format. Never turn a GitHub URL into a guessed
        // Gitee /releases/download URL; attachment paths may contain numeric IDs.
        urls[name] = publicUrl(asset.browser_download_url);
        await this.existingBytes(asset, bytes);
      }
    }
    return urls;
  }
}
