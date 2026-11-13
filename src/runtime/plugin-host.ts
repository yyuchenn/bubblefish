import type { AssistanceUpdate, ImageDocument } from '../generated/core';
import type {
  JsonValue,
  PluginOperation,
  PluginTransaction,
  PluginImageRegion,
  PluginMutationOrigin,
} from '../generated/plugins';
import type { PluginHostAdapter } from './plugins/types';
import { RpcError, type RpcResult } from './plugins/rpc';
import { assistanceText } from './assistance';
import { operationsToCommands, stagedHandles } from './document-operations';
import { readImageRegion, encodedImageMime } from './read-image';
import type { Workbench } from './workbench';

function record(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RpcError('invalid_params', '参数必须为对象');
  return value;
}
function string(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string' || !value) throw new RpcError('invalid_params', `缺少 ${name}`);
  return value;
}
function optionalString(value: JsonValue | undefined, name: string): string | undefined {
  return value === undefined ? undefined : string(value, name);
}
function integer(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new RpcError('invalid_params', `${name} 必须是非负整数`);
  return value;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
type HostContext = NonNullable<Parameters<NonNullable<PluginHostAdapter['call']>>[4]>;

function operationKey(value: unknown, depth = 0): string {
  if (depth > 128) throw new RpcError('invalid_params', '操作数据嵌套过深');
  if (Array.isArray(value))
    return `[${value.map((item) => operationKey(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${operationKey(item, depth + 1)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Include removed, inserted and moved operations; untouched image operations retain their authority. */
function changedOperations(before: PluginOperation[], after: PluginOperation[]): PluginOperation[] {
  const indexed = (operations: PluginOperation[]) => {
    const counts = new Map<string, number>();
    return operations.map((operation, index) => {
      const key = operationKey(operation),
        count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      return { key: `${key}#${count}`, operation, index };
    });
  };
  const previous = indexed(before),
    next = indexed(after),
    old = new Map(previous.map((entry) => [entry.key, entry]));
  const current = new Set(next.map((entry) => entry.key));
  const changed = previous
    .filter((entry) => !current.has(entry.key))
    .map((entry) => entry.operation);
  const retained = next.map((entry) => old.get(entry.key)?.index);
  const suffix = new Array<number>(next.length);
  let minimum = Infinity;
  for (let index = next.length - 1; index >= 0; index--) {
    suffix[index] = minimum;
    minimum = Math.min(minimum, retained[index] ?? Infinity);
  }
  let maximum = -1;
  for (let index = 0; index < next.length; index++) {
    const original = retained[index];
    if (original === undefined || original < maximum || original > suffix[index])
      changed.push(next[index].operation);
    if (original !== undefined) maximum = Math.max(maximum, original);
  }
  return changed;
}

/** All identities come from the bound runtime connection, never plugin-supplied params. */
export function createPluginHost(
  workbench: Workbench,
  permissions: (pluginId: string) => readonly string[] = () => [],
): PluginHostAdapter {
  const requirePermission = (pluginId: string, permission: string) => {
    if (!permissions(pluginId).includes(permission))
      throw new RpcError('permission', `Plugin has not declared ${permission}`);
  };
  const projectFor = (params: Record<string, JsonValue>, context?: HostContext) => {
    const projectId =
      typeof params.projectId === 'string'
        ? params.projectId
        : (context?.proposal?.projectId ?? workbench.value.activeId);
    if (
      context?.runtimeRole === 'hooks' &&
      context.proposal &&
      projectId !== context.proposal.projectId
    )
      throw new RpcError('hook_scope', '钩子只能读取当前提案的项目');
    const project = workbench.value.projects.find((entry) => entry.id === projectId);
    if (!project) throw new RpcError('project_closed', '项目已关闭');
    if (
      context?.runtimeRole === 'hooks' &&
      context.proposal &&
      project.stateId !== context.proposal.baseStateId
    )
      throw new RpcError('state_conflict', '钩子基准状态已经变化');
    return structuredClone(project);
  };
  const readLegacy = (query: JsonValue, context?: HostContext) => {
    const params = query === null ? {} : record(query);
    let project: ReturnType<typeof projectFor>;
    try {
      project = projectFor(params, context);
    } catch (error) {
      if (error instanceof RpcError && error.code === 'project_closed') return null;
      throw error;
    }
    return json({
      projectId: project.id,
      stateId: project.stateId,
      historyRevision: project.historyRevision,
      name: project.name,
      sourceLanguage: project.sourceLanguage,
      targetLanguage: project.targetLanguage,
      selection: {
        imageId: project.id === workbench.value.activeId ? workbench.value.imageId : null,
        markerId: project.id === workbench.value.activeId ? workbench.value.markerId : null,
      },
      images: project.images.map((image) => ({
        ...image,
        markers: image.markers.map((marker) => ({
          id: marker.id,
          geometry: marker.geometry,
          translation: marker.translation.runs.map((run) => run.text).join(''),
          originalText: assistanceText(marker, 'originalText'),
          machineTranslation: assistanceText(marker, 'machineTranslation'),
        })),
      })),
    });
  };
  const validate = (pluginId: string, operations: PluginOperation[]) => {
    requirePermission(pluginId, 'document.write');
    if (!Array.isArray(operations)) throw new RpcError('invalid_params', 'operations 必须为数组');
    if (operations.some((operation) => operation?.type?.startsWith('image.')))
      requirePermission(pluginId, 'images.write');
  };
  const commit = async (pluginId: string, transaction: PluginTransaction, owner: string) => {
    string(transaction.projectId, 'projectId');
    optionalString(transaction.causationId, 'causationId');
    const ownedHandles = new Set<string>();
    if (Array.isArray(transaction.operations))
      for (const operation of transaction.operations) {
        if (
          !operation ||
          typeof operation !== 'object' ||
          !('stagedResource' in operation) ||
          typeof operation.stagedResource !== 'string'
        )
          continue;
        try {
          workbench.resources.resolve(operation.stagedResource, owner, transaction.projectId);
          ownedHandles.add(operation.stagedResource);
        } catch {
          /* Never release another instance's handles. */
        }
      }
    try {
      const project = projectFor({ projectId: transaction.projectId });
      if (
        typeof transaction.label !== 'string' ||
        !transaction.label.trim() ||
        transaction.label.length > 256
      )
        throw new RpcError('invalid_params', '事务标签不能为空且最多 256 字符');
      if (
        transaction.expectedStateId !== undefined &&
        typeof transaction.expectedStateId !== 'string'
      )
        throw new RpcError('invalid_params', 'expectedStateId 必须为字符串');
      validate(pluginId, transaction.operations);
      const commands = operationsToCommands(transaction.operations, (handle) =>
        workbench.resources.resolve(handle, owner, project.id),
      );
      if (!workbench.transport.preview) throw new RpcError('unsupported', '当前核心不支持事务预检');
      await workbench.transport.preview(
        project.id,
        commands,
        transaction.expectedStateId ?? project.stateId,
      );
      const origin: PluginMutationOrigin = {
        kind: 'plugin',
        pluginId,
        label: transaction.label,
        ...(transaction.causationId ? { causationId: transaction.causationId } : {}),
      };
      const result = await workbench.commitOperations(
        project.id,
        transaction.label,
        transaction.operations,
        owner,
        origin,
        transaction.expectedStateId,
      );
      return json(result ?? { applied: true });
    } catch (error) {
      workbench.resources.release(ownedHandles);
      workbench.releaseStagedAssets();
      throw error;
    }
  };

  const legacyApply = async (pluginId: string, input: JsonValue, owner: string) => {
    const command = record(input),
      projectId = string(command.projectId, 'projectId');
    let operations: PluginOperation[];
    if (command.type === 'setTranslation') {
      if (typeof command.text !== 'string')
        throw new RpcError('invalid_params', 'text 必须为字符串');
      operations = [
        {
          type: 'translation.set',
          imageId: string(command.imageId, 'imageId'),
          markerId: string(command.markerId, 'markerId'),
          value: command.text,
        },
      ];
    } else if (command.type === 'updateAssistance') {
      if (!Array.isArray(command.updates) || !command.updates.length)
        throw new RpcError('invalid_params', 'updates 必须为非空数组');
      operations = command.updates.map((item) => {
        const value = record(item),
          patch: Omit<AssistanceUpdate, 'imageId' | 'markerId' | 'expected'> = {};
        for (const key of [
          'originalText',
          'machineTranslation',
          'lastOcrModel',
          'lastTranslationService',
        ] as const) {
          if (key in value) {
            if (value[key] !== null && typeof value[key] !== 'string')
              throw new RpcError('invalid_params', `${key} 必须为字符串或 null`);
            patch[key] = value[key] as string | null;
          }
        }
        return {
          type: 'assistance.update',
          imageId: string(value.imageId, 'imageId'),
          markerId: string(value.markerId, 'markerId'),
          patch,
        };
      });
    } else throw new RpcError('unsupported', '此插件文档操作不受支持');
    await commit(pluginId, { projectId, label: '插件修改文档', operations }, owner);
    return { applied: true };
  };
  return {
    notify: (text) => workbench.notice(text),
    readDocument: async (pluginId, query) => {
      requirePermission(pluginId, 'document.read');
      return readLegacy(query);
    },
    applyDocument: (pluginId, input) => legacyApply(pluginId, input, `legacy:${pluginId}`),
    releaseInstance(_pluginId, instanceId) {
      workbench.resources.releaseOwner(instanceId);
      workbench.releaseStagedAssets();
    },
    async validateOperations(pluginId, proposal, operations) {
      requirePermission(pluginId, 'document.intercept');
      const maxOperations = Math.max(10000, proposal.operations.length);
      if (!Array.isArray(operations) || operations.length > maxOperations)
        throw new RpcError('invalid_params', `operations 必须为数组，最多${maxOperations}项`);
      const changes = changedOperations(proposal.operations, operations);
      if (changes.length) validate(pluginId, changes);
      const project = projectFor(
        { projectId: proposal.projectId },
        { runtimeRole: 'hooks', instanceId: `validate:${pluginId}`, proposal },
      );
      const commands = operationsToCommands(
        operations,
        (handle) =>
          workbench.resources.resolve(
            handle,
            `validate:${pluginId}`,
            project.id,
            stagedHandles(proposal.operations),
          ),
        maxOperations,
      );
      if (!workbench.transport.preview) throw new RpcError('unsupported', '当前核心不支持事务预检');
      await workbench.transport.preview(project.id, commands, proposal.baseStateId);
    },
    async call(pluginId, method, params, binary, context): Promise<RpcResult> {
      const args = params === null ? {} : record(params),
        owner = context?.instanceId ?? `legacy:${pluginId}`;
      const readOnly = [
        'document.read',
        'document.images.list',
        'document.images.get',
        'document.images.read',
        'document.markers.list',
        'document.markers.get',
        'document.translations.get',
        'document.assistance.get',
        'history.list',
      ];
      if (context?.runtimeRole === 'hooks' && !readOnly.includes(method))
        throw new RpcError('hook_readonly', '钩子执行器只能查询基准状态');
      if (method === 'document.read') {
        requirePermission(pluginId, 'document.read');
        return { result: readLegacy(params, context) };
      }
      if (method === 'document.apply')
        return { result: await legacyApply(pluginId, params, owner) };
      if (method === 'document.transaction' || method === 'history.push')
        return { result: await commit(pluginId, args as unknown as PluginTransaction, owner) };
      const project = projectFor(args, context);
      if (method === 'history.list') {
        requirePermission(pluginId, 'history.read');
        return {
          result: json(
            await workbench.historyList(project.id, {
              offset: integer(args.offset, 'offset'),
              limit: integer(args.limit, 'limit'),
            }),
          ),
        };
      }
      if (['history.pop', 'history.undo', 'history.redo'].includes(method)) {
        requirePermission(pluginId, 'history.control');
        const direction =
          method === 'history.undo' ? 'undo' : method === 'history.redo' ? 'redo' : args.stack;
        if (direction !== 'undo' && direction !== 'redo')
          throw new RpcError('invalid_params', 'stack 必须是 undo 或 redo');
        const result = await workbench.history(
          direction,
          project.id,
          {
            expectedEntryId: optionalString(args.expectedEntryId, 'expectedEntryId'),
            expectedHistoryRevision: integer(
              args.expectedHistoryRevision,
              'expectedHistoryRevision',
            ),
          },
          { kind: 'history', pluginId },
        );
        return { result: json(result ?? { applied: true }) };
      }
      if (method === 'document.images.stage') {
        requirePermission(pluginId, 'images.write');
        if (!binary?.byteLength) throw new RpcError('missing_image', '图片暂存需要独立二进制附件');
        try {
          const staged = await workbench.resources.stage(
            owner,
            project.id,
            typeof args.filename === 'string' ? args.filename : 'plugin-image.png',
            binary,
          );
          return { result: json({ ...staged, mimeType: encodedImageMime(binary) }) };
        } catch (error) {
          workbench.releaseStagedAssets();
          throw error;
        }
      }
      requirePermission(pluginId, 'document.read');
      if (method === 'document.images.read') requirePermission(pluginId, 'images.read');
      if (method === 'document.images.list') return { result: json(project.images) };
      let image: ImageDocument | undefined;
      if (typeof args.stagedResource === 'string') {
        const shared = context?.proposal ? stagedHandles(context.proposal.operations) : [];
        image = workbench.resources.resolve(args.stagedResource, owner, project.id, shared);
      } else image = project.images.find((entry) => entry.id === args.imageId);
      if (method === 'document.images.get') return { result: json(image ?? null) };
      if (!image) throw new RpcError('missing_image', '图片不存在');
      if (method === 'document.images.read') {
        const release = workbench.assets.pin([image.assetId]);
        try {
          const file = await workbench.assets.file(image.assetId);
          const region =
            args.region === undefined
              ? undefined
              : (record(args.region) as unknown as PluginImageRegion);
          const crop = region ? await readImageRegion(file, region) : undefined;
          const bytes = crop?.bytes ?? (await file.arrayBuffer());
          return {
            result: json({
              image,
              mimeType: crop ? 'image/png' : encodedImageMime(bytes),
              byteLength: bytes.byteLength,
              ...(region ? { region } : {}),
              ...(crop ? { width: crop.width, height: crop.height } : {}),
            }),
            binary: bytes,
          };
        } finally {
          release();
          workbench.releaseStagedAssets();
        }
      }
      if (method === 'document.markers.list') return { result: json(image.markers) };
      const marker = image.markers.find((entry) => entry.id === args.markerId);
      if (method === 'document.markers.get') return { result: json(marker ?? null) };
      if (!marker) throw new RpcError('missing_marker', '标记不存在');
      if (method === 'document.translations.get') return { result: json(marker.translation) };
      if (method === 'document.assistance.get') return { result: json(marker.bunnyCache ?? {}) };
      throw new RpcError('unknown_host_method', `Unknown host method: ${method}`);
    },
  };
}
