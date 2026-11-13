export { PluginManager } from './manager';
export type {
  PluginHostAdapter,
  ManagerView,
  PluginView,
  PluginTask,
  PluginLog,
  PluginCommandRun,
  PluginCommandState,
  ProviderEntry,
  CommandEntry,
  PanelEntry,
  InstalledPlugin,
  TaskOptions,
  JsonValue,
  PluginRuntimeRole,
  EventSubscriptionOptions,
} from './types';
export { readPluginPackage, validateManifest } from './package';
