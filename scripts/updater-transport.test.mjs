import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { Agent } from 'undici';
import { ReleaseHttp } from './updater-api.mjs';

// Undici 7's parser timers use a coarse clock. Wait long enough for the
// deliberately short control timer to fire without using minute-long tests.
const delayedResponseMs = 1_500;
const allowedResponseMs = 3_000;

function diagnostics(error) {
  return JSON.parse(error.message.slice(error.message.indexOf('{')));
}

function multipart() {
  const body = new FormData();
  body.append('file', new Blob([Buffer.from('compiled package bytes')]), 'transport.bfplugin');
  return body;
}

async function serverFixture(t, handle) {
  const requests = [],
    failures = [];
  const server = createServer((request, response) => {
    requests.push(request.method);
    void Promise.resolve(handle(request, response)).catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(failures, [], 'Loopback server must not hide request handler failures');
  });
  return { url: `http://127.0.0.1:${server.address().port}/attachments`, requests };
}

async function fileFrom(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const form = await new Response(Buffer.concat(chunks), {
    headers: { 'Content-Type': request.headers['content-type'] },
  }).formData();
  return form.get('file');
}

function nativeClient(t, options) {
  const http = new ReleaseHttp(options);
  t.after(() => http.close());
  return http;
}

test('native multipart uploads override a shorter default response-header transport timeout', async (t) => {
  const files = [];
  const { url, requests } = await serverFixture(t, async (request, response) => {
    const file = await fileFrom(request);
    files.push({ name: file.name, bytes: await file.text() });
    await sleep(delayedResponseMs);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  const shortDefault = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
  t.after(() => shortDefault.close());
  await assert.rejects(
    fetch(url, { method: 'POST', body: multipart(), dispatcher: shortDefault }),
    (error) => {
      assert.equal(error.cause.code, 'UND_ERR_HEADERS_TIMEOUT');
      return true;
    },
  );

  const profiles = [];
  const http = nativeClient(t, {
    // Without ReleaseHttp's explicit dispatcher, this real fetch would inherit
    // the shorter transport budget and reproduce the original failure.
    fetchImpl: (input, options) => fetch(input, { dispatcher: shortDefault, ...options }),
    agentFactory: (options) => {
      profiles.push(options);
      return new Agent(options);
    },
  });
  assert.deepEqual(
    await http.json(url, { method: 'POST', body: multipart() }, { timeoutMs: allowedResponseMs }),
    { ok: true },
  );
  assert.deepEqual(profiles, [
    { headersTimeout: allowedResponseMs, bodyTimeout: allowedResponseMs, connectTimeout: 10_000 },
  ]);
  assert.deepEqual(requests, ['POST', 'POST']);
  assert.deepEqual(files, [
    { name: 'transport.bfplugin', bytes: 'compiled package bytes' },
    { name: 'transport.bfplugin', bytes: 'compiled package bytes' },
  ]);
});

test('native response bodies use the configured transport budget after headers arrive', async (t) => {
  const { url, requests } = await serverFixture(t, async (request, response) => {
    await fileFrom(request);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    await sleep(delayedResponseMs);
    response.end('true}');
  });
  const shortDefault = new Agent({ headersTimeout: 1_000, bodyTimeout: 50 });
  t.after(() => shortDefault.close());
  await assert.rejects(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        body: multipart(),
        dispatcher: shortDefault,
      });
      await response.json();
    },
    (error) => {
      assert.equal(error.cause.code, 'UND_ERR_BODY_TIMEOUT');
      return true;
    },
  );
  const http = nativeClient(t, {
    fetchImpl: (input, options) => fetch(input, { dispatcher: shortDefault, ...options }),
  });
  assert.deepEqual(
    await http.json(url, { method: 'POST', body: multipart() }, { timeoutMs: allowedResponseMs }),
    { ok: true },
  );
  assert.deepEqual(requests, ['POST', 'POST']);
});

for (const phase of ['headers', 'body'])
  test(`native ${phase} parser timeout is enforced independently of the outer signal`, async (t) => {
    const { url, requests } = await serverFixture(t, async (request, response) => {
      await fileFrom(request);
      if (phase === 'body') {
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.write('{"ok":');
      }
      await sleep(delayedResponseMs);
      response.end(phase === 'body' ? 'true}' : '{"ok":true}');
    });
    const http = nativeClient(t, {
      // Give the real parser its own shorter deadline so this test proves the
      // Agent settings are active, rather than testing AbortSignal alone.
      timeoutSignal: () => AbortSignal.timeout(5_000),
    });
    await assert.rejects(
      http.json(url, { method: 'POST', body: multipart() }, { timeoutMs: 80 }),
      (error) => {
        const detail = diagnostics(error);
        assert.equal(detail.phase, phase === 'headers' ? 'request' : 'json');
        assert.equal(detail.timeoutMs, 80);
        assert.equal(detail.headersTimeoutMs, 80);
        assert.equal(detail.bodyTimeoutMs, 80);
        assert.equal(detail.connectTimeoutMs, 10_000);
        assert.ok(
          detail.causes.some(
            ({ code }) => code === `UND_ERR_${phase === 'headers' ? 'HEADERS' : 'BODY'}_TIMEOUT`,
          ),
        );
        return true;
      },
    );
    assert.deepEqual(requests, ['POST'], 'Parser timeouts must never replay an upload');
  });

test('the outer deadline still aborts an active response body without replaying the upload', async (t) => {
  const { url, requests } = await serverFixture(t, async (request, response) => {
    await fileFrom(request);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    for (let index = 0; index < 20 && !response.destroyed; index++) {
      response.write(' ');
      await sleep(20);
    }
    response.end('true}');
  });
  let signal;
  const http = nativeClient(t, {
    timeoutSignal: (timeoutMs) => (signal = AbortSignal.timeout(timeoutMs)),
  });
  await assert.rejects(
    http.json(url, { method: 'POST', body: multipart() }, { timeoutMs: 100 }),
    (error) => {
      const detail = diagnostics(error);
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason.name, 'TimeoutError');
      assert.equal(detail.phase, 'json');
      assert.equal(detail.status, 201);
      assert.equal(detail.timeoutMs, 100);
      assert.ok(
        detail.causes.every(
          ({ code }) => !['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code),
        ),
      );
      return true;
    },
  );
  assert.deepEqual(requests, ['POST']);
});

test('owned agent shutdown waits for an in-flight response body to finish', async (t) => {
  const { url } = await serverFixture(t, async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    await sleep(200);
    response.end('true}');
  });
  const http = nativeClient(t);
  const response = await http.response(url, {}, { timeoutMs: 1_000 });
  let closed = false;
  const closing = http.close().then(() => {
    closed = true;
  });
  await sleep(20);
  assert.equal(closed, false);
  assert.deepEqual(await response.json(), { ok: true });
  await closing;
  assert.equal(closed, true);
});

test(
  'missing and failed response bodies are discarded before retry and shutdown',
  { timeout: 2_000 },
  async (t) => {
    const responsesClosed = [];
    const { url, requests } = await serverFixture(t, async (request, response) => {
      responsesClosed.push(once(response, 'close'));
      response.writeHead(request.url.endsWith('/missing') ? 404 : 503, {
        'Content-Type': 'text/html',
      });
      // Leave a response body open. Shutdown would wait for the ten-second outer
      // budget if ReleaseHttp did not explicitly cancel these unread bodies.
      response.write('<html>unfinished response');
    });
    const http = nativeClient(t, { sleep: async () => {} });
    assert.equal(await http.json(`${url}/missing`, {}, { missing: true, timeoutMs: 10_000 }), null);
    await assert.rejects(http.json(`${url}/unavailable`, {}, { timeoutMs: 10_000 }), /HTTP 503/);
    await http.close();
    await Promise.all(responsesClosed);
    assert.equal(requests.length, 5, 'The missing request plus the original four GET attempts');
  },
);
