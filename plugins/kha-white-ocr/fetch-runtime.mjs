import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function layout(target, version) {
  if (target === 'x86_64-pc-windows-msvc')
    return {
      prefix: 'runtimes/win-x64/native/',
      library: 'onnxruntime.dll',
      required: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'],
    };
  if (target === 'aarch64-apple-darwin')
    return {
      prefix: 'runtimes/osx-arm64/native/',
      library: `libonnxruntime.${version}.dylib`,
      required: ['libonnxruntime.dylib'],
    };
  throw new Error(`Unsupported ONNX Runtime target: ${target}`);
}

export function extractRuntimeEntries(archive, target, version) {
  const { prefix, library, required } = layout(target, version);
  let files;
  try {
    files = unzipSync(archive, {
      filter: ({ name }) =>
        name.startsWith(prefix) &&
        !/[\\/]/.test(name.slice(prefix.length)) &&
        (target.includes('windows') ? /\.dll$/i.test(name) : name === `${prefix}${required[0]}`),
    });
  } catch (cause) {
    throw new Error('Invalid ONNX Runtime NuGet ZIP archive', { cause });
  }
  for (const name of required)
    if (!files[`${prefix}${name}`]?.length)
      throw new Error(`ONNX Runtime NuGet package is missing ${prefix}${name}`);
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      target.includes('windows') ? name.slice(prefix.length) : library,
      bytes,
    ]),
  );
}

async function downloadPackage(url, archive, validate, fetchImpl, sleep) {
  const temporary = `${archive}.${process.pid}.partial`;
  for (let attempt = 0; ; attempt++) {
    let retryable = true;
    try {
      // The CPU package contains every platform and can exceed 150 MiB.
      const signal = AbortSignal.timeout(600_000);
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`ONNX Runtime download failed: HTTP ${response.status} (${url})`);
      }
      if (!response.body) throw new Error('ONNX Runtime download returned an empty response');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary), { signal });
      retryable = false;
      const entries = validate(new Uint8Array(await readFile(temporary)));
      await rename(temporary, archive);
      return entries;
    } catch (cause) {
      if (!retryable || attempt >= 3)
        throw new Error(`Unable to fetch ONNX Runtime: ${cause.message}`, { cause });
    } finally {
      await rm(temporary, { force: true });
    }
    await sleep(500 * 2 ** attempt);
  }
}

export async function fetchRuntime({
  target,
  root = repositoryRoot,
  env = process.env,
  fetchImpl = fetch,
  sleep = delay,
} = {}) {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies?.[
    'onnxruntime-web'
  ];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('Expected an exact onnxruntime-web version in package.json');
  const { library } = layout(target, version);
  const cache = resolve(root, '.cache/ort', version);
  const archive = join(cache, `microsoft.ml.onnxruntime.${version}.nupkg`);
  const validate = (bytes) => extractRuntimeEntries(bytes, target, version);
  await mkdir(cache, { recursive: true });
  let entries;
  try {
    entries = validate(new Uint8Array(await readFile(archive)));
  } catch (error) {
    if (error.code !== 'ENOENT') await rm(archive, { force: true });
  }
  if (!entries)
    entries = await downloadPackage(
      `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${version}/microsoft.ml.onnxruntime.${version}.nupkg`,
      archive,
      validate,
      fetchImpl,
      sleep,
    );
  const directory = join(cache, target, 'lib');
  // Replace the target directory so a previous package cannot leave stale DLLs.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(entries))
    await writeFile(join(directory, name), bytes);
  const runtime = join(directory, library);
  if (env.GITHUB_ENV)
    await appendFile(env.GITHUB_ENV, `BUBBLEFISH_ORT_RUNTIME=${runtime}\n`, 'utf8');
  return runtime;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--target') {
    console.error('Usage: node plugins/kha-white-ocr/fetch-runtime.mjs --target <Rust target>');
    process.exitCode = 1;
  } else {
    try {
      console.log(`Fetching the official ONNX Runtime CPU package for ${args[1]}`);
      console.log(await fetchRuntime({ target: args[1] }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
