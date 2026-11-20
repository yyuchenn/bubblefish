import assert from 'node:assert/strict';
import {
  applyReleaseMetadata,
  sha256,
  selectArtifacts,
  verifyArtifacts,
  verifyUpdaterSignature,
} from './updater-artifacts.mjs';

export const giteeAttachmentLimit = 100_000_000;
const requestTimeoutMs = 120_000;
const attachmentUploadTimeoutMs = 900_000;

function errorCauses(error) {
  const pending = [{ error, depth: 0 }],
    visited = new Set(),
    causes = [];
  // Error messages can echo authorization or signed URLs. Only summarize
  // bounded type names and system codes, including IPv4/IPv6 aggregate errors.
  while (pending.length && causes.length < 8) {
    const { error: current, depth } = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    const name =
      typeof current.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(current.name)
        ? current.name
        : 'Error';
    const code =
      typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(current.code)
        ? current.code
        : undefined;
    causes.push({ name, ...(code === undefined ? {} : { code }) });
    if (depth >= 4) continue;
    pending.push({ error: current.cause, depth: depth + 1 });
    if (Array.isArray(current.errors))
      for (const nested of current.errors.slice(0, 3))
        pending.push({ error: nested, depth: depth + 1 });
  }
  return causes;
}

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

function uniqueAttachments(entries, host) {
  const names = new Set();
  for (const { name } of entries) {
    assert.ok(
      typeof name === 'string' && name.length > 0 && !/[\\/]/.test(name),
      `Invalid ${host} attachment name`,
    );
    assert.ok(!names.has(name), `Duplicate ${host} attachment: ${name}`);
    names.add(name);
  }
}

function attachmentByName(assets, name, host) {
  const matches = assets.filter((entry) => entry.name === name);
  assert.ok(matches.length <= 1, `Duplicate ${host} attachment: ${name}`);
  return matches[0];
}

function verifiedInstallers(artifacts, version, publicKey) {
  return verifyArtifacts(
    artifacts.flatMap((entry) => [
      entry,
      { name: `${entry.name}.sig`, bytes: entry.signatureBytes },
    ]),
    version,
    publicKey,
  );
}

export class ReleaseHttp {
  constructor({
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => performance.now(),
    timeoutSignal = (ms) => AbortSignal.timeout(ms),
  } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.timeoutSignal = timeoutSignal;
    this.contexts = new WeakMap();
  }

  failure(message, context, phase, cause) {
    const details = {
      phase,
      method: context.method,
      url: context.url,
      ...(context.attachmentName === undefined
        ? {}
        : { attachmentName: String(context.attachmentName).slice(0, 256) }),
      ...(context.attachmentSize === undefined ? {} : { attachmentSize: context.attachmentSize }),
      elapsedMs: Math.max(0, Math.round(this.now() - context.startedAt)),
      timeoutMs: context.timeoutMs,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      ...(context.status === undefined ? {} : { status: context.status }),
      causes: errorCauses(cause),
    };
    // The CLI prints only error.message. Keep all printable diagnostics here,
    // while preserving the original cause for callers without serializing it.
    return new Error(
      `${context.method} ${context.url}: ${message} ${JSON.stringify(details)}`,
      cause === undefined ? undefined : { cause },
    );
  }

  async response(
    url,
    options = {},
    { missing = false, timeoutMs = requestTimeoutMs, attachmentName, attachmentSize } = {},
  ) {
    const method = options.method ?? 'GET';
    const parsedUrl = new URL(url);
    for (let attempt = 0; ; attempt++) {
      const context = {
        method,
        // Omit URL credentials, query parameters and fragments from diagnostics.
        url: `${parsedUrl.host}${parsedUrl.pathname}`.slice(0, 512),
        attachmentName,
        attachmentSize,
        timeoutMs,
        startedAt: this.now(),
        attempt: attempt + 1,
        maxAttempts: method === 'GET' ? 4 : 1,
      };
      let response;
      try {
        response = await this.fetch(url, { ...options, signal: this.timeoutSignal(timeoutMs) });
      } catch (error) {
        if (method === 'GET' && attempt < 3) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw this.failure('network request failed', context, 'request', error);
      }
      context.status = response.status;
      this.contexts.set(response, context);
      if (missing && response.status === 404) return null;
      if (response.ok) return response;
      // Retrying writes after an ambiguous response can create duplicate assets.
      // A later run lists and validates the existing release before resuming.
      if (method === 'GET' && [429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      throw this.failure(`HTTP ${response.status}`, context, 'http');
    }
  }

  async json(url, options, flags) {
    const response = await this.response(url, options, flags);
    if (!response) return null;
    try {
      return await response.json();
    } catch (error) {
      throw this.failure('JSON response failed', this.contexts.get(response), 'json', error);
    }
  }

  async download(url) {
    // Deliberately omit API authorization, including when the server redirects.
    const response = await this.response(publicUrl(url));
    const limitMessage = 'Release attachment exceeds Gitee limit';
    try {
      const contentLength = Number(response.headers.get('content-length'));
      assert.ok(!contentLength || contentLength <= giteeAttachmentLimit, limitMessage);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > giteeAttachmentLimit) {
          await response.body.cancel().catch(() => {});
          throw new Error(limitMessage);
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw this.failure(
        error?.message === limitMessage ? limitMessage : 'download body failed',
        this.contexts.get(response),
        'download-body',
        error,
      );
    }
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

  async readAssets(release, names) {
    const assets = await this.assets(release);
    const selected = names.map((name) => attachmentByName(assets, name, 'GitHub')).filter(Boolean);
    return Promise.all(
      selected.map(async ({ name, browser_download_url }) => ({
        name,
        bytes: await this.http.download(browser_download_url),
      })),
    );
  }

  async readArtifacts(release, version, publicKey, metadata) {
    const assets = await this.assets(release);
    const selected = selectArtifacts(assets, version);
    if (metadata) {
      const payloads = await Promise.all(
        selected.map(async (entry) => ({
          ...entry,
          bytes: await this.http.download(entry.browser_download_url),
        })),
      );
      return applyReleaseMetadata(
        metadata,
        payloads,
        release.tag_name,
        metadata.releaseCommit,
        publicKey,
      );
    }
    // Older releases kept their signatures as public attachments. Keep that
    // read path for repairs without creating any new .sig attachments.
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

  async prepareArtifacts(release, artifacts, version, publicKey, metadata) {
    const source = metadata
      ? applyReleaseMetadata(
          metadata,
          artifacts,
          release.tag_name,
          metadata.releaseCommit,
          publicKey,
        )
      : verifiedInstallers(artifacts, version, publicKey);
    const assets = await this.assets(release);
    const canonical = [];
    for (const artifact of source) {
      const asset = attachmentByName(assets, artifact.name, 'GitHub');
      if (asset) await this.existingBytes(asset, artifact.bytes);
      // Select legacy signatures before creating the immutable archive. Once
      // archived, metadata takes precedence over any old public signature file.
      const legacy = metadata
        ? undefined
        : attachmentByName(assets, `${artifact.name}.sig`, 'GitHub');
      const signatureBytes = legacy
        ? await this.http.download(legacy.browser_download_url)
        : artifact.signatureBytes;
      const signature = signatureBytes.toString('utf8').trim();
      verifyUpdaterSignature(artifact.bytes, signature, publicKey, {
        version,
        filename: artifact.name,
      });
      canonical.push({ ...artifact, signature, signatureBytes });
    }
    return canonical;
  }

  async uploadAssets(release, entries) {
    uniqueAttachments(entries, 'GitHub');
    const assets = await this.assets(release);
    const urls = {};
    for (const { name, bytes } of entries) {
      let asset = attachmentByName(assets, name, 'GitHub');
      if (asset) await this.existingBytes(asset, bytes);
      else {
        const url = new URL(release.upload_url.replace(/\{.*$/, ''));
        assert.equal(url.origin, 'https://uploads.github.com', 'Unexpected GitHub upload origin');
        url.searchParams.set('name', name);
        asset = await this.http.json(
          url.href,
          {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/octet-stream' },
            body: bytes,
          },
          {
            timeoutMs: attachmentUploadTimeoutMs,
            attachmentName: name,
            attachmentSize: bytes.length,
          },
        );
        assert.equal(asset.name, name, 'GitHub changed attachment name');
        assets.push(asset);
        await this.existingBytes(asset, bytes);
      }
      urls[name] = publicUrl(asset.browser_download_url);
    }
    return urls;
  }

  async publish(release, artifacts, version, publicKey) {
    const verified = verifiedInstallers(artifacts, version, publicKey);
    return { artifacts: verified, urls: await this.uploadAssets(release, verified) };
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
        // This repository contains updater metadata, not the GitHub source.
        // Existing release tags are reused without rewriting their Git history.
        target_commitish: 'updater',
        name: source.name || source.tag_name,
        body: source.body || '',
        prerelease: Boolean(source.prerelease),
      },
    });
  }

  async mirror(source, artifacts) {
    uniqueAttachments(artifacts, 'Gitee');
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
    for (const { name, bytes } of artifacts) {
      let asset = attachmentByName(assets, name, 'Gitee');
      if (!asset) {
        const body = new FormData();
        body.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
        asset = await this.http.json(
          `${this.base}${path}`,
          {
            method: 'POST',
            headers: this.headers,
            body,
          },
          {
            timeoutMs: attachmentUploadTimeoutMs,
            attachmentName: name,
            attachmentSize: bytes.length,
          },
        );
        assert.equal(asset.name, name, 'Gitee changed attachment name');
        assets.push(asset);
      }
      // The API owns the URL format. Never turn a GitHub URL into a guessed
      // Gitee /releases/download URL; attachment paths may contain numeric IDs.
      urls[name] = publicUrl(asset.browser_download_url);
      await this.existingBytes(asset, bytes);
    }
    return urls;
  }
}
