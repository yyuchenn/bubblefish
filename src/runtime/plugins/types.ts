import type {
  JsonValue,
  PluginManifest,
  ProviderInfo,
  CommandInfo,
  PanelInfo,
  PluginMutationProposal,
  PluginOperation,
} from '../../generated/plugins';
export type { JsonValue, PluginManifest, ProviderInfo } from '../../generated/plugins';

export type PluginRuntimeRole = 'main' | 'hooks';
export interface EventSubscriptionOptions {
  projectId?: string;
  includeSelf?: boolean;
}
export type PluginState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed';
export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  config: Record<string, JsonValue>;
}
export interface PluginView extends InstalledPlugin {
  state: PluginState;
  backend: 'web' | 'native' | null;
  error?: string;
  hooksState?: 'inactive' | 'warming' | 'ready' | 'paused';
  hooksError?: string;
}
export interface ProviderEntry {
  id: string;
  pluginId: string;
  kind: 'ocr' | 'translation';
  info: ProviderInfo;
}
export interface CommandEntry {
  id: string;
  pluginId: string;
  info: CommandInfo;
}
export interface PanelEntry {
  id: string;
  pluginId: string;
  info: PanelInfo;
}
export interface PluginTask {
  id: string;
  pluginId: string;
  providerId: string;
  kind: 'ocr' | 'translation';
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  progress: JsonValue | null;
  error?: string;
}
export interface PluginLog {
  pluginId: string;
  level: string;
  message: string;
  time: number;
}
export type PluginCommandState =
  | 'queued'
  | 'activating'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export interface PluginCommandRun {
  id: string;
  pluginId: string;
  commandId: string;
  title: string;
  source: 'manager' | 'menu';
  state: PluginCommandState;
  progress: JsonValue | null;
  summary?: string;
  result?: JsonValue;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}
export interface ManagerView {
  ready: boolean;
  plugins: PluginView[];
  providers: ProviderEntry[];
  commands: CommandEntry[];
  panels: PanelEntry[];
  activePanel: { pluginId: string; panelId: string } | null;
  tasks: PluginTask[];
  logs: PluginLog[];
  commandRuns: PluginCommandRun[];
  commandNotice: { runId: string; pluginId: string } | null;
}
export interface PluginHostAdapter {
  readDocument(pluginId: string, query: JsonValue): Promise<JsonValue>;
  applyDocument(pluginId: string, command: JsonValue): Promise<JsonValue>;
  call?(
    pluginId: string,
    method: string,
    params: JsonValue,
    binary?: ArrayBuffer,
    context?: {
      runtimeRole: PluginRuntimeRole;
      instanceId: string;
      proposal?: PluginMutationProposal;
    },
  ): Promise<import('./rpc').RpcResult>;
  validateOperations?(
    pluginId: string,
    proposal: PluginMutationProposal,
    operations: PluginOperation[],
  ): Promise<void>;
  releaseInstance?(pluginId: string, instanceId: string): void | Promise<void>;
  notify?(message: string): void;
}
export interface PluginFiles {
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
}
export interface PluginStorage {
  list(): Promise<InstalledPlugin[]>;
  install(pkg: PluginFiles): Promise<InstalledPlugin>;
  remove(pluginId: string): Promise<void>;
  read(pluginId: string, path: string): Promise<ArrayBuffer>;
  update(
    pluginId: string,
    patch: { enabled?: boolean; config?: Record<string, JsonValue> },
  ): Promise<void>;
}
export interface TaskOptions {
  signal?: AbortSignal;
  onProgress?: (progress: JsonValue) => void;
}
export const object = (value: JsonValue): Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
