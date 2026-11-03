import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : resolve(args[at + 1]);
};
const source = option('--model-dir', resolve(root, '../plugins/kha-white-ocr-plugin/onnx_model'));
const destination = option('--out', join(root, 'dist/models/kha-white-manga-ocr-fp32.bfmodel'));
const manifest = JSON.parse(await readFile(join(directory, 'model-manifest.json'), 'utf8'));
manifest.licenseText = await readFile(resolve(root, '../LICENSE'), 'utf8');
const description = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const files = [
  { name: 'model.json', bytes: description, size: description.length, crc: crc32(description) },
];
for (const file of manifest.files) {
  const path = join(source, file.path);
  if ((await stat(path)).size !== file.byteLength)
    throw new Error(`Wrong model size: ${file.path}`);
  const hash = createHash('sha256');
  let crc = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk);
    crc = crc32(chunk, crc);
  }
  if (hash.digest('hex') !== file.sha256)
    throw new Error(`Model SHA-256 differs from the verified conversion: ${file.path}`);
  files.push({ name: file.path, path, size: file.byteLength, crc });
}
await mkdir(dirname(destination), { recursive: true });
const output = await open(`${destination}.tmp`, 'w');
let offset = 0;
async function write(bytes) {
  let position = 0;
  while (position < bytes.length) {
    const { bytesWritten } = await output.write(bytes, position, bytes.length - position, null);
    if (!bytesWritten) throw new Error('Failed to write the model archive');
    position += bytesWritten;
    offset += bytesWritten;
  }
}
const central = [];
try {
  for (const file of files) {
    const name = Buffer.from(file.name);
    const start = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(file.crc, 14);
    header.writeUInt32LE(file.size, 18);
    header.writeUInt32LE(file.size, 22);
    header.writeUInt16LE(name.length, 26);
    await write(header);
    await write(name);
    if (file.bytes) await write(file.bytes);
    else
      for await (const chunk of createReadStream(file.path, { highWaterMark: 4 * 1024 * 1024 }))
        await write(chunk);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(file.crc, 16);
    record.writeUInt32LE(file.size, 20);
    record.writeUInt32LE(file.size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(start, 42);
    central.push(record, name);
  }
  const start = offset;
  for (const bytes of central) await write(bytes);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  await write(end);
} finally {
  await output.close();
}
const { rename } = await import('node:fs/promises');
await rename(`${destination}.tmp`, destination);
console.log(`Verified original FP32 model bundle: ${destination} (${offset} bytes)`);
