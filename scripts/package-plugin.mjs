import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { zipSync, strToU8 } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args[0])
  throw new Error(
    'Usage: npm run plugin:pack -- <plugin-directory> [--native <target>=<binary>] [--out <path>]',
  );
const source = resolve(args[0]);
const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
const files = {};
async function visit(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'target', 'dist'].includes(entry.name))
      continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
    if (entry.isDirectory()) await visit(join(directory, entry.name), path);
    else if (!path.endsWith('.ts') && !path.endsWith('.md'))
      files[path] = new Uint8Array(await readFile(join(directory, entry.name)));
  }
}
await visit(source);
async function bundle(entry) {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((part) => part.type === 'chunk');
  if (chunks.length !== 1 || output.some((part) => part.type === 'asset'))
    throw new Error(
      'Plugin code must bundle to one JS module; load external assets with the resource API.',
    );
  return chunks[0].code;
}
if (manifest.entrypoints.web)
  files[manifest.entrypoints.web] = strToU8(await bundle(join(source, 'web.ts')));
for (const panel of manifest.contributes.panels ?? []) {
  const html = await readFile(join(source, panel.entry), 'utf8');
  if (html.includes('<!-- plugin:script -->')) {
    const script = await bundle(join(source, panel.entry.replace(/\.html$/, '.ts')));
    files[panel.entry] = strToU8(
      html.replace(
        '<!-- plugin:script -->',
        `<script type="module">${script.replaceAll('</script', '<\\/script')}</script>`,
      ),
    );
  }
}
for (let index = 1; index < args.length; index++) {
  if (args[index] === '--native') {
    const spec = args[++index] ?? '',
      separator = spec.indexOf('=');
    if (separator < 1) throw new Error('--native expects target=executable');
    const target = spec.slice(0, separator),
      executable = resolve(spec.slice(separator + 1));
    const path = `native/${target}/${basename(executable)}`;
    manifest.entrypoints.native ??= {};
    manifest.entrypoints.native[target] = path;
    files[path] = new Uint8Array(await readFile(executable));
  }
}
files['plugin.json'] = strToU8(JSON.stringify(manifest, null, 2));
const outIndex = args.indexOf('--out');
const destination =
  outIndex < 0
    ? join(root, 'dist/plugins', `${manifest.id}.bfplugin`)
    : resolve(args[outIndex + 1]);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, zipSync(files));
console.log(destination);
