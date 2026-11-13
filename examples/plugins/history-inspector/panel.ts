import { connectPanel, type Disposable } from '../../../src/plugin-sdk';
import type {
  PluginHistoryEntry,
  PluginHistoryPage,
  JsonValue,
} from '../../../src/generated/plugins';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const eventNames = [
  'document.changed',
  'image.added',
  'image.updated',
  'image.removed',
  'images.reordered',
  'marker.added',
  'marker.updated',
  'marker.removed',
  'markers.reordered',
  'translation.changed',
  'assistance.changed',
  'history.changed',
  'transaction.committed',
  'project.opened',
  'project.closed',
];

async function connect(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  let projectId = '',
    observed: PluginHistoryPage | undefined;
  let subscriptions: Disposable[] = [];
  const logs: { event: string; data: JsonValue }[] = [];
  const output = element('result');
  async function run(operation: () => Promise<unknown>) {
    output.dataset.error = 'false';
    try {
      output.textContent = JSON.stringify(await operation(), null, 2) ?? '完成';
    } catch (error) {
      output.dataset.error = 'true';
      output.textContent = String(error);
    }
  }
  function list(id: string, entries: PluginHistoryEntry[], offset: number) {
    const nodes = entries.map((entry) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = entry.label;
      const identity = document.createElement('small');
      identity.textContent = `entryId: ${entry.entryId}`;
      const origin = document.createElement('small');
      origin.textContent = `来源: ${entry.origin?.kind ?? 'user'}${entry.origin?.pluginId ? ` / ${entry.origin.pluginId}` : ''}`;
      const states = document.createElement('small');
      states.textContent = `${entry.beforeStateId} → ${entry.afterStateId}`;
      item.append(title, identity, origin, states);
      return item;
    });
    const target = element<HTMLOListElement>(id);
    target.start = offset + 1;
    if (!nodes.length) {
      const empty = document.createElement('li');
      empty.textContent = '此页为空';
      nodes.push(empty);
    }
    target.replaceChildren(...nodes);
  }
  async function bindEvents() {
    await Promise.all(subscriptions.splice(0).map((subscription) => subscription.dispose()));
    subscriptions = eventNames.map((name) =>
      sdk.events.subscribe(
        name,
        (data) => {
          logs.unshift({ event: name, data });
          logs.length = Math.min(logs.length, 150);
          element('events').textContent = JSON.stringify(logs, null, 2);
          // Updating a list is a read; it does not produce another transaction.
          if (name === 'history.changed')
            void refreshHistory().catch((error) => {
              output.textContent = String(error);
            });
        },
        { ...(projectId ? { projectId } : {}), includeSelf: input('include-self').checked },
      ),
    );
  }
  async function refreshHistory() {
    if (!projectId) throw new Error('请先打开项目');
    const offset = Math.max(0, Math.trunc(Number(input('offset').value) || 0));
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input('limit').value) || 20)));
    // The guard always refers to the real stack top, including on later pages.
    observed = await sdk.history.list({ projectId, offset: 0, limit: 1 });
    const page =
      offset === 0 && limit === 1 ? observed : await sdk.history.list({ projectId, offset, limit });
    list('undo-list', page.undo, offset);
    list('redo-list', page.redo, offset);
    element('revision').textContent =
      `historyRevision ${page.historyRevision} · undo ${page.undoTotal} 条 · redo ${page.redoTotal} 条`;
    return page;
  }
  async function refresh() {
    const current = (await sdk.document.read()) as {
      projectId?: string;
      id?: string;
      name?: string;
    } | null;
    const nextId = current?.projectId ?? current?.id ?? '';
    if (nextId !== projectId) {
      projectId = nextId;
      observed = undefined;
      await bindEvents();
    }
    element('project').textContent = current
      ? `${current.name ?? projectId} · ${projectId}`
      : '请先打开项目';
    if (!projectId) {
      element('undo-list').replaceChildren();
      element('redo-list').replaceChildren();
      element('revision').textContent = '';
      return null;
    }
    return refreshHistory();
  }
  function guard(stack: 'undo' | 'redo') {
    if (!projectId || !observed) throw new Error('请先读取项目历史');
    const top = observed[stack][0];
    if (!top) throw new Error(`${stack} 栈为空`);
    return {
      projectId,
      expectedEntryId: top.entryId,
      expectedHistoryRevision: observed.historyRevision,
    };
  }
  const button = (id: string, operation: () => Promise<unknown>) =>
    element(id).addEventListener('click', () => void run(operation));
  const after = async (operation: () => Promise<unknown>) => {
    const result = await operation();
    await refreshHistory();
    return result;
  };
  button('refresh', refresh);
  button('push', () =>
    after(async () => {
      if (!projectId) throw new Error('请先打开项目');
      const [image] = await sdk.document.images.list({ projectId });
      if (!image) throw new Error('请先为项目添加图片');
      const markerId = sdk.document.createId();
      return sdk.history.push({
        projectId,
        label: '历史检查器压入事务',
        operations: [
          {
            type: 'marker.create',
            imageId: image.id,
            marker: {
              id: markerId,
              geometry: { type: 'point', x: 0.15, y: 0.15 },
              translation: { runs: [] },
              style: { overlayText: false, horizontal: false },
            },
          },
          {
            type: 'translation.set',
            imageId: image.id,
            markerId,
            value: 'history.push transaction',
          },
        ],
      });
    }),
  );
  button('pop-undo', () => after(() => sdk.history.pop({ ...guard('undo'), stack: 'undo' })));
  button('pop-redo', () => after(() => sdk.history.pop({ ...guard('redo'), stack: 'redo' })));
  button('undo', () => after(() => sdk.history.undo(guard('undo'))));
  button('redo', () => after(() => sdk.history.redo(guard('redo'))));
  input('include-self').addEventListener(
    'change',
    () =>
      void run(async () => {
        await bindEvents();
        return `自身事件: ${input('include-self').checked}`;
      }),
  );
  button('clear', async () => {
    logs.splice(0);
    element('events').textContent = '尚无事件';
    return '已清空';
  });
  sdk.events.subscribe('context.changed', () => void run(refresh));
  window.addEventListener('unload', () => sdk.dispose());
  await bindEvents();
  await run(refresh);
}
window.addEventListener('message', connect);
