import type { JsonValue, PluginDocumentChangeEvent } from '../generated/plugins';
import type { EventSubscriptionOptions } from '../runtime/plugins/types';
import type { Disposable } from './index';

export interface PluginEventMap {
  'image.added': PluginDocumentChangeEvent;
  'image.updated': PluginDocumentChangeEvent;
  'image.removed': PluginDocumentChangeEvent;
  'images.reordered': PluginDocumentChangeEvent;
  'marker.added': PluginDocumentChangeEvent;
  'marker.updated': PluginDocumentChangeEvent;
  'marker.removed': PluginDocumentChangeEvent;
  'markers.reordered': PluginDocumentChangeEvent;
  'translation.changed': PluginDocumentChangeEvent;
  'assistance.changed': PluginDocumentChangeEvent;
  'project.updated': PluginDocumentChangeEvent;
  'document.changed': PluginDocumentChangeEvent;
  'history.changed': PluginDocumentChangeEvent & { historyRevision?: number };
  'transaction.committed': PluginDocumentChangeEvent;
  'context.changed': JsonValue;
  'config.changed': JsonValue;
  'project.opened': JsonValue;
  'project.closed': JsonValue;
}
export interface PluginEvents {
  /** Mutation events never replay. State events may deliver the current value immediately. */
  subscribe<Name extends string>(
    event: Name,
    callback: (
      data: Name extends keyof PluginEventMap ? PluginEventMap[Name] : JsonValue,
    ) => unknown,
    options?: EventSubscriptionOptions,
  ): Disposable;
}
