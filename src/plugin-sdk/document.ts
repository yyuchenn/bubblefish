import type {
  JsonValue,
  PluginOperation,
  PluginTransaction,
  PluginStagedImage,
  PluginImage,
  PluginMarker,
  PluginRichText,
  PluginHistoryPage,
  PluginImageRead,
} from '../generated/plugins';
import type { RpcPeer } from '../runtime/plugins/rpc';
import { newId } from '../runtime/plugins/types';

type Operation<T extends PluginOperation['type']> = Extract<PluginOperation, { type: T }>;
type Input<T extends PluginOperation['type']> = Omit<Operation<T>, 'type'> & {
  projectId: string;
  label?: string;
  expectedStateId?: string;
};
type Query = { projectId: string };
type ImageQuery = Query & { imageId: string };
type MarkerQuery = ImageQuery & { markerId: string };
type ImageResourceQuery = Query &
  ({ imageId: string; stagedResource?: never } | { stagedResource: string; imageId?: never });
export type HistoryOptions = Query & {
  stack?: 'undo' | 'redo';
  offset?: number;
  limit?: number;
  expectedEntryId?: string;
  expectedHistoryRevision?: number;
};
const json = (value: unknown) => value as JsonValue;

/** Public operations are independent of the host's editor, stores and command implementation. */
export function createDocumentApi(peer: RpcPeer) {
  const call = async (method: string, params: unknown) =>
    (await peer.request(method, json(params), { timeout: 0 })).result;
  const transaction = (proposal: PluginTransaction) => call('document.transaction', proposal);
  const apply = <T extends PluginOperation['type']>(type: T, input: Input<T>) => {
    const { projectId, label = type, expectedStateId, ...values } = input;
    return transaction({
      projectId,
      label,
      ...(expectedStateId === undefined ? {} : { expectedStateId }),
      operations: [{ type, ...values } as unknown as PluginOperation],
    });
  };
  return {
    /** Allocate an entity ID before a transaction so later operations can refer to it. */
    createId: newId,
    read: (query: JsonValue = null) => call('document.read', query),
    apply: (command: JsonValue) => call('document.apply', command),
    transaction,
    images: {
      list: (query: Query) =>
        call('document.images.list', query) as unknown as Promise<PluginImage[]>,
      get: (query: ImageResourceQuery) =>
        call('document.images.get', query) as unknown as Promise<PluginImage | null>,
      async read(
        query: ImageResourceQuery & {
          region?: { x: number; y: number; width: number; height: number };
        },
      ) {
        const response = await peer.request('document.images.read', json(query));
        if (!response.binary) throw new Error('Missing image data');
        return { metadata: response.result as unknown as PluginImageRead, binary: response.binary };
      },
      async stage(query: Query & { filename?: string }, binary: ArrayBuffer) {
        return (await peer.request('document.images.stage', json(query), { binary }))
          .result as unknown as PluginStagedImage;
      },
      async create(input: Omit<Input<'image.create'>, 'id'> & { id?: string }) {
        const id = input.id ?? newId();
        return { id, result: await apply('image.create', { ...input, id }) };
      },
      update: (input: Input<'image.update'>) => apply('image.update', input),
      remove: (input: Input<'image.remove'>) => apply('image.remove', input),
      reorder: (input: Input<'image.reorder'>) => apply('image.reorder', input),
    },
    markers: {
      list: (query: ImageQuery) =>
        call('document.markers.list', query) as unknown as Promise<PluginMarker[]>,
      get: (query: MarkerQuery) =>
        call('document.markers.get', query) as unknown as Promise<PluginMarker | null>,
      async create(
        input: Omit<Input<'marker.create'>, 'marker'> & {
          marker: Omit<PluginMarker, 'id'> & { id?: string };
        },
      ) {
        const id = input.marker.id ?? newId();
        return {
          id,
          result: await apply('marker.create', { ...input, marker: { ...input.marker, id } }),
        };
      },
      update: (input: Input<'marker.update'>) => apply('marker.update', input),
      remove: (input: Input<'marker.remove'>) => apply('marker.remove', input),
      reorder: (input: Input<'marker.reorder'>) => apply('marker.reorder', input),
    },
    translations: {
      get: (query: MarkerQuery) =>
        call('document.translations.get', query) as unknown as Promise<PluginRichText>,
      set: (input: Input<'translation.set'>) => apply('translation.set', input),
      clear: (input: Input<'translation.clear'>) => apply('translation.clear', input),
    },
    assistance: {
      get: (query: MarkerQuery) => call('document.assistance.get', query),
      update: (input: Input<'assistance.update'>) => apply('assistance.update', input),
      clear: (input: Input<'assistance.clear'>) => apply('assistance.clear', input),
    },
  };
}
export function createHistoryApi(peer: RpcPeer) {
  const pop = (query: HistoryOptions & { stack: 'undo' | 'redo' }) =>
    peer.request('history.pop', json(query), { timeout: 0 }).then((value) => value.result);
  return {
    list: (query: HistoryOptions) =>
      peer
        .request('history.list', json(query))
        .then((value) => value.result as unknown as PluginHistoryPage),
    push: (proposal: PluginTransaction) =>
      peer
        .request('document.transaction', json(proposal), { timeout: 0 })
        .then((value) => value.result),
    pop,
    undo: (query: Omit<HistoryOptions, 'stack'>) => pop({ ...query, stack: 'undo' }),
    redo: (query: Omit<HistoryOptions, 'stack'>) => pop({ ...query, stack: 'redo' }),
  };
}
