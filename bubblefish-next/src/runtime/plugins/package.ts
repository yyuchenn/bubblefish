import { unzipSync, strFromU8 } from 'fflate';
import type { PluginManifest, PluginFiles, JsonValue } from './types';

const MAX_PACKAGE = 256 * 1024 * 1024;
export function resourcePath(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]+:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid plugin resource path: ${path}`);
  return path;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function label(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error(`Invalid plugin ${field}`);
}
export function validateManifest(value: unknown): PluginManifest {
  if (!record(value)) throw new Error('plugin.json must contain an object');
  label(value.id, 'id');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id))
    throw new Error('Plugin id must use lowercase letters, digits, dots, dashes or underscores');
  label(value.name, 'name');
  label(value.version, 'version');
  if (value.apiVersion !== 1) throw new Error('This plugin requires an unsupported API version');
  if (!record(value.entrypoints) || !record(value.contributes))
    throw new Error('Plugin entrypoints and contributes are required');
  if (!value.entrypoints.web && !value.entrypoints.native)
    throw new Error('Plugin needs a web or native entrypoint');
  if (value.entrypoints.web !== undefined) {
    label(value.entrypoints.web, 'web entrypoint');
    resourcePath(value.entrypoints.web);
  }
  if (value.entrypoints.native !== undefined) {
    if (!record(value.entrypoints.native) || !Object.keys(value.entrypoints.native).length)
      throw new Error('Invalid native entrypoints');
    for (const [target, path] of Object.entries(value.entrypoints.native)) {
      label(target, 'native target');
      label(path, 'native entrypoint');
      resourcePath(path);
    }
  }
  if (
    value.permissions !== undefined &&
    (!Array.isArray(value.permissions) ||
      value.permissions.some((permission) => typeof permission !== 'string'))
  )
    throw new Error('Invalid plugin permissions');
  if (
    value.activationEvents !== undefined &&
    (!Array.isArray(value.activationEvents) ||
      value.activationEvents.some(
        (event) =>
          typeof event !== 'string' ||
          !(event === 'startup' || /^event:[a-z][a-z0-9_.-]*$/.test(event)),
      ))
  )
    throw new Error('Unsupported plugin activation event');
  for (const kind of [
    'ocr',
    'translation',
    'commands',
    'panels',
    'configuration',
    'beforeCommitHooks',
  ]) {
    const entries = value.contributes[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid ${kind} contributions`);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!record(entry)) throw new Error(`Invalid ${kind} contribution`);
      const key = kind === 'configuration' ? 'key' : 'id';
      label(entry[key], `${kind} ${key}`);
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry[key] as string) ||
        ids.has(entry[key] as string)
      )
        throw new Error(`Duplicate or invalid ${kind} identifier`);
      ids.add(entry[key] as string);
      if (kind === 'beforeCommitHooks') {
        if (
          entry.priority !== undefined &&
          (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority))
        )
          throw new Error('Invalid hook priority');
        if (
          entry.operations !== undefined &&
          (!Array.isArray(entry.operations) ||
            entry.operations.some((type) => typeof type !== 'string'))
        )
          throw new Error('Invalid hook operation filter');
        continue;
      }
      label(
        entry[
          kind === 'configuration'
            ? 'label'
            : kind === 'ocr' || kind === 'translation'
              ? 'name'
              : 'title'
        ],
        `${kind} label`,
      );
      if (kind === 'panels') {
        label(entry.entry, 'panel entry');
        resourcePath(entry.entry);
      }
      if (
        kind === 'configuration' &&
        !['string', 'number', 'boolean', 'secret'].includes(String(entry.type))
      )
        throw new Error('Invalid configuration field type');
      if (
        (kind === 'ocr' || kind === 'translation') &&
        entry.languages !== undefined &&
        (!Array.isArray(entry.languages) ||
          entry.languages.some((language) => typeof language !== 'string'))
      )
        throw new Error('Invalid provider languages');
    }
  }
  return value as unknown as PluginManifest;
}
export async function readPluginPackage(blob: Blob): Promise<PluginFiles> {
  if (blob.size > MAX_PACKAGE)
    throw new Error('Plugin package exceeds 256 MiB; download model weights separately');
  let expanded = 0;
  const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
    filter(file) {
      if (file.name.endsWith('/')) return false;
      resourcePath(file.name);
      expanded += file.originalSize;
      if (expanded > MAX_PACKAGE) throw new Error('Expanded plugin package exceeds 256 MiB');
      return true;
    },
  });
  const manifestBytes = unzipped['plugin.json'];
  if (!manifestBytes || manifestBytes.length > 1024 * 1024)
    throw new Error('Package must contain plugin.json at its root');
  const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)));
  const files = new Map(Object.entries(unzipped));
  const referenced = [
    manifest.entrypoints.web,
    ...Object.values(manifest.entrypoints.native ?? {}),
    ...(manifest.contributes.panels ?? []).map((panel) => panel.entry),
  ].filter((path): path is string => !!path);
  for (const path of referenced)
    if (!files.has(path)) throw new Error(`Missing plugin resource: ${path}`);
  return { manifest, files };
}
export function defaultConfig(manifest: PluginManifest): Record<string, JsonValue> {
  return Object.fromEntries(
    (manifest.contributes.configuration ?? [])
      .filter((field) => field.default !== undefined)
      .map((field) => [field.key, field.default!]),
  );
}
export function validateConfig(manifest: PluginManifest, config: Record<string, JsonValue>) {
  for (const [key, value] of Object.entries(config)) {
    const field = manifest.contributes.configuration?.find((entry) => entry.key === key);
    if (!field) throw new Error(`Unknown plugin configuration field: ${key}`);
    if (
      typeof value !== (field.type === 'secret' ? 'string' : field.type) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error(`Invalid value for ${field.label}`);
  }
}
