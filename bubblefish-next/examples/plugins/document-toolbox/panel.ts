import { connectPanel } from '../../../src/plugin-sdk';
import type {
  JsonValue,
  PluginGeometry,
  PluginImage,
  PluginRichText,
} from '../../../src/generated/plugins';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
const imageFields = ['filename', 'crop-x', 'crop-y', 'crop-width', 'crop-height'];
const markerFields = [
  'geometry',
  'x',
  'y',
  'width',
  'height',
  'overlay',
  'horizontal',
  'translation',
  'richtext',
  'original-text',
  'machine-text',
];
const geometryFields = ['geometry', 'x', 'y', 'width', 'height', 'overlay', 'horizontal'];
const translationFields = ['translation', 'richtext'];
const assistanceFields = ['original-text', 'machine-text'];
const fields = [...imageFields, ...markerFields];
type Value = string | boolean;
type Values = Record<string, Value>;
interface Target {
  projectId: string;
  imageId: string;
  markerId: string;
}
interface Draft {
  value: Value;
}
interface DraftScope {
  target: Target;
  values: Map<string, Draft>;
}
interface Snapshot {
  target: Target;
  epoch: number;
  fields: Values;
  drafts: Map<string, Draft | undefined>;
  images: PluginImage[];
  file?: File;
}
const emptyTarget = (): Target => ({ projectId: '', imageId: '', markerId: '' });
const key = (target: Target) => JSON.stringify([target.projectId, target.imageId, target.markerId]);
const imageKey = (target: Target) => JSON.stringify([target.projectId, target.imageId]);
const record = (value: JsonValue): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const contextTarget = (value: JsonValue): Target => {
  const context = record(value);
  const id = (name: string) => (typeof context[name] === 'string' ? (context[name] as string) : '');
  return { projectId: id('projectId'), imageId: id('imageId'), markerId: id('markerId') };
};
function fieldValue(id: string): Value {
  const control = element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
  return control instanceof HTMLInputElement && control.type === 'checkbox'
    ? control.checked
    : control.value;
}
function setField(id: string, value: Value) {
  const control = element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    control.checked = value === true;
  } else if (control.value !== String(value)) control.value = String(value);
}
function options(id: string, values: Array<{ id: string; title: string }>, selected: string) {
  const control = select(id);
  if (
    control.options.length !== values.length ||
    values.some(
      (value, index) =>
        control.options[index].value !== value.id || control.options[index].text !== value.title,
    )
  )
    control.replaceChildren(...values.map((value) => new Option(value.title, value.id)));
  control.value = selected;
}

async function connect(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  const output = element<HTMLPreElement>('result');
  let current = emptyTarget(),
    desired = emptyTarget(),
    host: Target | undefined;
  let images: PluginImage[] = [],
    projectName = '',
    previewUrl = '';
  let viewEpoch = 0,
    refreshEpoch = 0,
    previewEpoch = 0,
    busy = 0;
  let refreshing = false,
    disposed = false;
  const drafts = new Map<string, DraftScope>();
  const scopeKey = (id: string, target: Target) =>
    imageFields.includes(id) ? imageKey(target) : key(target);
  const getDraft = (id: string, target = current) =>
    drafts.get(scopeKey(id, target))?.values.get(id);
  function clearPreview() {
    previewEpoch++;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    const preview = element<HTMLImageElement>('preview');
    preview.removeAttribute('src');
    preview.hidden = true;
    input('upload').value = '';
  }
  function prune(projectId: string, available: PluginImage[] | null) {
    for (const [id, scope] of drafts) {
      if (scope.target.projectId !== projectId) continue;
      const image = available?.find((entry) => entry.id === scope.target.imageId);
      if (
        !available ||
        (scope.target.imageId && !image) ||
        (scope.target.markerId &&
          !image?.markers.some((marker) => marker.id === scope.target.markerId))
      )
        drafts.delete(id);
    }
  }
  function forget(target: Target, markerOnly = false) {
    for (const [id, scope] of drafts)
      if (
        scope.target.projectId === target.projectId &&
        scope.target.imageId === target.imageId &&
        (!markerOnly || scope.target.markerId === target.markerId)
      )
        drafts.delete(id);
  }
  function availability() {
    const image = images.find((entry) => entry.id === current.imageId);
    const marker = image?.markers.find((entry) => entry.id === current.markerId);
    const transitioning = refreshing && key(current) !== key(desired);
    const canProject = !!current.projectId && !transitioning;
    const canImage = canProject && !!image;
    const canMarker = canImage && !!marker;
    const file = !!input('upload').files?.length;
    const requirements: Record<string, boolean> = {
      refresh: true,
      'image-create': canProject && file,
      'image-replace': canImage && file,
      'image-reorder': canProject && images.length > 0,
    };
    for (const id of [
      'image-get',
      'original',
      'crop',
      'image-copy',
      'image-rename',
      'image-remove',
      'marker-create',
      'marker-reorder',
      'batch',
    ])
      requirements[id] = canImage;
    for (const id of [
      'marker-get',
      'marker-update',
      'marker-remove',
      'translation-get',
      'translation-set',
      'translation-clear',
      'translation-rich',
      'assistance-get',
      'assistance-update',
      'assistance-clear',
    ])
      requirements[id] = canMarker;
    for (const [id, allowed] of Object.entries(requirements))
      element<HTMLButtonElement>(id).disabled = refreshing || busy > 0 || !allowed;
    select('images').disabled = !canProject || !images.length;
    select('markers').disabled = !canImage || !image?.markers.length;
    input('upload').disabled = !canProject;
    for (const id of imageFields) element<HTMLInputElement>(id).disabled = !canImage;
    for (const id of markerFields)
      element<HTMLInputElement>(id).disabled = geometryFields.includes(id) ? !canImage : !canMarker;
    document.body.setAttribute('aria-busy', String(refreshing || busy > 0));
  }
  function render() {
    const image = images.find((entry) => entry.id === current.imageId);
    const marker = image?.markers.find((entry) => entry.id === current.markerId);
    options(
      'images',
      images.map((entry) => ({ id: entry.id, title: entry.filename })),
      current.imageId,
    );
    options(
      'markers',
      (image?.markers ?? []).map((entry, index) => ({
        id: entry.id,
        title: `#${index + 1} · ${entry.id}`,
      })),
      current.markerId,
    );
    element('project').textContent = current.projectId
      ? `${projectName} · ${images.length} 张图片`
      : '请先打开项目';
    element('target').textContent = image
      ? `${image.filename} · ${marker ? `标记 #${image.markers.indexOf(marker) + 1}` : '未选择标记'}`
      : current.projectId
        ? '未选择图片'
        : '请先打开项目';
    const cache = record(marker?.bunnyCache ?? null);
    const baseline: Values = {
      filename: image?.filename ?? '',
      'crop-x': '0.2',
      'crop-y': '0.2',
      'crop-width': '0.5',
      'crop-height': '0.5',
      geometry: marker?.geometry.type ?? 'point',
      x: String(marker?.geometry.x ?? 0.2),
      y: String(marker?.geometry.y ?? 0.2),
      width: String(marker?.geometry.type === 'rectangle' ? marker.geometry.width : 0.3),
      height: String(marker?.geometry.type === 'rectangle' ? marker.geometry.height : 0.2),
      overlay: marker?.style.overlayText ?? false,
      horizontal: marker?.style.horizontal ?? false,
      translation: marker?.translation.runs.map((run) => run.text).join('') ?? '',
      richtext: JSON.stringify(marker?.translation ?? { runs: [] }, null, 2),
      'original-text': typeof cache.originalText === 'string' ? cache.originalText : '',
      'machine-text': typeof cache.machineTranslation === 'string' ? cache.machineTranslation : '',
    };
    for (const id of fields) setField(id, getDraft(id)?.value ?? baseline[id]);
    availability();
  }
  function follow(target: Target) {
    viewEpoch++;
    if (imageKey(desired) !== imageKey(target)) clearPreview();
    desired = { ...target };
  }
  async function refresh(target?: Target) {
    const epoch = ++refreshEpoch;
    refreshing = true;
    availability();
    try {
      const document = (await sdk.document.read(
        target ? { projectId: target.projectId } : null,
      )) as {
        projectId: string;
        name: string;
        selection: { imageId: string | null; markerId: string | null };
      } | null;
      if (disposed || epoch !== refreshEpoch) return;
      if (!document) {
        if (target?.projectId) prune(target.projectId, null);
        if (current.projectId) viewEpoch++;
        if (imageKey(current) !== imageKey(emptyTarget())) clearPreview();
        current = desired = emptyTarget();
        images = [];
        projectName = '';
        render();
        return;
      }
      const available = await sdk.document.images.list({ projectId: document.projectId });
      if (disposed || epoch !== refreshEpoch) return;
      const requested = target ?? {
        projectId: document.projectId,
        imageId: document.selection.imageId ?? '',
        markerId: document.selection.markerId ?? '',
      };
      const image =
        available.find((entry) => entry.id === requested.imageId) ??
        available.find((entry) => entry.id === document.selection.imageId);
      const requestedMarker =
        image?.id === requested.imageId ? requested.markerId : document.selection.markerId;
      const marker = image?.markers.find((entry) => entry.id === requestedMarker);
      const next = {
        projectId: document.projectId,
        imageId: image?.id ?? '',
        markerId: marker?.id ?? '',
      };
      if (target && key(next) !== key(requested)) viewEpoch++;
      const previousImage = images.find((entry) => entry.id === current.imageId);
      if (imageKey(current) !== imageKey(next) || previousImage?.assetId !== image?.assetId)
        clearPreview();
      current = desired = next;
      images = available;
      projectName = document.name;
      prune(current.projectId, available);
      render();
    } catch (error) {
      if (!disposed && epoch === refreshEpoch) throw error;
    } finally {
      if (!disposed && epoch === refreshEpoch) {
        refreshing = false;
        availability();
      }
    }
  }
  const visible = (snapshot: Snapshot) => !disposed && snapshot.epoch === viewEpoch;
  const sameTarget = (snapshot: Snapshot) =>
    visible(snapshot) && key(current) === key(snapshot.target);
  function capture(): Snapshot {
    return {
      target: { ...current },
      epoch: viewEpoch,
      fields: Object.fromEntries(fields.map((id) => [id, fieldValue(id)])),
      drafts: new Map(fields.map((id) => [id, getDraft(id)])),
      images: structuredClone(images),
      file: input('upload').files?.[0],
    };
  }
  async function run(operation: (snapshot: Snapshot) => Promise<unknown>) {
    const snapshot = capture();
    busy++;
    availability();
    output.dataset.error = 'false';
    try {
      const result = await operation(snapshot);
      if (visible(snapshot)) output.textContent = JSON.stringify(result, null, 2) ?? '完成';
    } catch (error) {
      if (visible(snapshot)) {
        output.dataset.error = 'true';
        output.textContent = String(error);
      }
    } finally {
      busy--;
      if (!disposed) availability();
    }
  }
  function background(operation: Promise<void>) {
    void operation.catch((error) => {
      if (!disposed) {
        output.dataset.error = 'true';
        output.textContent = String(error);
      }
    });
  }
  function clearSubmitted(snapshot: Snapshot, submitted: string[]) {
    for (const id of submitted) {
      const values = drafts.get(scopeKey(id, snapshot.target))?.values;
      if (values?.get(id) === snapshot.drafts.get(id)) values?.delete(id);
    }
  }
  async function refreshAfter(snapshot: Snapshot, preferred = snapshot.target) {
    if (!disposed && desired.projectId === snapshot.target.projectId)
      await refresh(sameTarget(snapshot) ? preferred : { ...desired });
  }
  async function mutate(
    snapshot: Snapshot,
    operation: () => Promise<unknown>,
    submitted: string[] = [],
  ) {
    const result = await operation();
    clearSubmitted(snapshot, submitted);
    await refreshAfter(snapshot);
    return result;
  }
  function imageQuery(snapshot: Snapshot) {
    if (!snapshot.target.projectId || !snapshot.target.imageId)
      throw new Error('请先打开含有图片的项目');
    return { projectId: snapshot.target.projectId, imageId: snapshot.target.imageId };
  }
  function markerQuery(snapshot: Snapshot) {
    if (!snapshot.target.markerId) throw new Error('请先选择或新增标记');
    return { ...imageQuery(snapshot), markerId: snapshot.target.markerId };
  }
  const number = (snapshot: Snapshot, id: string) => Number(snapshot.fields[id]);
  const geometry = (snapshot: Snapshot): PluginGeometry =>
    snapshot.fields.geometry === 'point'
      ? { type: 'point', x: number(snapshot, 'x'), y: number(snapshot, 'y') }
      : {
          type: 'rectangle',
          x: number(snapshot, 'x'),
          y: number(snapshot, 'y'),
          width: number(snapshot, 'width'),
          height: number(snapshot, 'height'),
        };
  const style = (snapshot: Snapshot) => ({
    overlayText: snapshot.fields.overlay === true,
    horizontal: snapshot.fields.horizontal === true,
  });
  async function uploaded(snapshot: Snapshot) {
    if (!snapshot.target.projectId) throw new Error('请先打开项目');
    if (!snapshot.file) throw new Error('请先选择一张图片');
    return sdk.document.images.stage(
      { projectId: snapshot.target.projectId, filename: snapshot.file.name },
      await snapshot.file.arrayBuffer(),
    );
  }
  async function preview(snapshot: Snapshot, cropped: boolean) {
    const epoch = ++previewEpoch;
    const result = await sdk.document.images.read({
      ...imageQuery(snapshot),
      ...(cropped
        ? {
            region: {
              x: number(snapshot, 'crop-x'),
              y: number(snapshot, 'crop-y'),
              width: number(snapshot, 'crop-width'),
              height: number(snapshot, 'crop-height'),
            },
          }
        : {}),
    });
    if (
      sameTarget(snapshot) &&
      epoch === previewEpoch &&
      images.find((image) => image.id === current.imageId)?.assetId ===
        snapshot.images.find((image) => image.id === snapshot.target.imageId)?.assetId
    ) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(
        new Blob([result.binary], { type: result.metadata.mimeType }),
      );
      const image = element<HTMLImageElement>('preview');
      image.src = previewUrl;
      image.hidden = false;
    }
    return result.metadata;
  }
  function button(id: string, operation: (snapshot: Snapshot) => Promise<unknown>) {
    element(id).addEventListener('click', () => void run(operation));
  }
  for (const id of fields) {
    const remember = () => {
      if (!current.projectId) return;
      const scope = scopeKey(id, current);
      const values = drafts.get(scope)?.values ?? new Map<string, Draft>();
      values.set(id, { value: fieldValue(id) });
      drafts.set(scope, {
        target: { ...current, ...(imageFields.includes(id) ? { markerId: '' } : {}) },
        values,
      });
    };
    element(id).addEventListener('input', remember);
    element(id).addEventListener('change', remember);
  }
  input('upload').addEventListener('change', availability);
  button('refresh', async (snapshot) => {
    for (const id of fields) drafts.get(scopeKey(id, snapshot.target))?.values.delete(id);
    await refresh(snapshot.target.projectId ? snapshot.target : undefined);
    return '已刷新';
  });
  select('images').addEventListener('change', () => {
    const image = images.find((entry) => entry.id === select('images').value);
    follow({
      projectId: current.projectId,
      imageId: image?.id ?? '',
      markerId: image?.markers[0]?.id ?? '',
    });
    background(refresh(desired));
  });
  select('markers').addEventListener('change', () => {
    follow({ ...current, markerId: select('markers').value });
    background(refresh(desired));
  });
  button('image-get', (snapshot) => sdk.document.images.get(imageQuery(snapshot)));
  button('original', (snapshot) => preview(snapshot, false));
  button('crop', (snapshot) => preview(snapshot, true));
  button('image-create', async (snapshot) => {
    const staged = await uploaded(snapshot);
    const result = await sdk.document.images.create({
      projectId: snapshot.target.projectId,
      stagedResource: staged.stagedResource,
      label: '工具箱新增图片',
    });
    await refreshAfter(snapshot, { ...snapshot.target, imageId: result.id, markerId: '' });
    return result;
  });
  button('image-replace', (snapshot) =>
    mutate(snapshot, async () => {
      const query = imageQuery(snapshot),
        staged = await uploaded(snapshot);
      return sdk.document.images.update({
        ...query,
        stagedResource: staged.stagedResource,
        label: '工具箱替换像素',
      });
    }),
  );
  button('image-copy', async (snapshot) => {
    const query = imageQuery(snapshot),
      source = snapshot.images.find((image) => image.id === query.imageId)!;
    const { binary } = await sdk.document.images.read(query);
    const staged = await sdk.document.images.stage(
      { projectId: query.projectId, filename: `copy-${source.filename}` },
      binary,
    );
    const result = await sdk.document.images.create({
      projectId: query.projectId,
      stagedResource: staged.stagedResource,
      label: '工具箱复制原图',
    });
    await refreshAfter(snapshot, { ...snapshot.target, imageId: result.id, markerId: '' });
    return result;
  });
  button('image-rename', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.images.update({
          ...imageQuery(snapshot),
          filename: String(snapshot.fields.filename),
          label: '工具箱修改图片名',
        }),
      ['filename'],
    ),
  );
  button('image-remove', (snapshot) =>
    mutate(snapshot, async () => {
      const result = await sdk.document.images.remove({
        ...imageQuery(snapshot),
        label: '工具箱删除图片',
      });
      forget(snapshot.target);
      return result;
    }),
  );
  button('image-reorder', (snapshot) =>
    mutate(snapshot, () =>
      sdk.document.images.reorder({
        projectId: snapshot.target.projectId,
        imageIds: snapshot.images.map((image) => image.id).reverse(),
        label: '工具箱反转图片顺序',
      }),
    ),
  );
  button('marker-create', async (snapshot) => {
    const result = await sdk.document.markers.create({
      ...imageQuery(snapshot),
      label: '工具箱新增标记',
      marker: {
        geometry: geometry(snapshot),
        style: style(snapshot),
        translation: { runs: [] },
        bunnyCache: { toolboxField: { preserved: true } },
      },
    });
    await refreshAfter(snapshot, { ...snapshot.target, markerId: result.id });
    return result;
  });
  button('marker-get', (snapshot) => sdk.document.markers.get(markerQuery(snapshot)));
  button('marker-update', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.markers.update({
          ...markerQuery(snapshot),
          geometry: geometry(snapshot),
          style: style(snapshot),
          label: '工具箱调整标记',
        }),
      geometryFields,
    ),
  );
  button('marker-remove', (snapshot) =>
    mutate(snapshot, async () => {
      const result = await sdk.document.markers.remove({
        ...markerQuery(snapshot),
        label: '工具箱删除标记',
      });
      forget(snapshot.target, true);
      return result;
    }),
  );
  button('marker-reorder', (snapshot) =>
    mutate(snapshot, () =>
      sdk.document.markers.reorder({
        ...imageQuery(snapshot),
        markerIds: snapshot.images
          .find((image) => image.id === snapshot.target.imageId)!
          .markers.map((marker) => marker.id)
          .reverse(),
        label: '工具箱反转标记顺序',
      }),
    ),
  );
  button('translation-get', (snapshot) => sdk.document.translations.get(markerQuery(snapshot)));
  button('translation-set', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.translations.set({
          ...markerQuery(snapshot),
          value: String(snapshot.fields.translation),
          label: '工具箱写入纯文本',
        }),
      translationFields,
    ),
  );
  button('translation-rich', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.translations.set({
          ...markerQuery(snapshot),
          value: JSON.parse(String(snapshot.fields.richtext)) as PluginRichText,
          label: '工具箱写入富文本',
        }),
      translationFields,
    ),
  );
  button('translation-clear', (snapshot) =>
    mutate(
      snapshot,
      () => sdk.document.translations.clear({ ...markerQuery(snapshot), label: '工具箱清空译文' }),
      translationFields,
    ),
  );
  button('assistance-get', (snapshot) => sdk.document.assistance.get(markerQuery(snapshot)));
  button('assistance-update', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.assistance.update({
          ...markerQuery(snapshot),
          patch: {
            originalText: String(snapshot.fields['original-text']),
            machineTranslation: String(snapshot.fields['machine-text']),
            lastOcrModel: 'example.document-toolbox',
            lastTranslationService: 'example.document-toolbox',
          },
          label: '工具箱更新辅助文本',
        }),
      assistanceFields,
    ),
  );
  button('assistance-clear', (snapshot) =>
    mutate(
      snapshot,
      () =>
        sdk.document.assistance.clear({ ...markerQuery(snapshot), label: '工具箱清空辅助文本' }),
      assistanceFields,
    ),
  );
  button('batch', async (snapshot) => {
    const query = imageQuery(snapshot),
      source = snapshot.images.find((image) => image.id === query.imageId)!;
    const { binary } = await sdk.document.images.read(query);
    const staged = await sdk.document.images.stage(
      { projectId: query.projectId, filename: `batch-${source.filename}` },
      binary,
    );
    const imageId = sdk.document.createId(),
      markerId = sdk.document.createId();
    const result = await sdk.document.transaction({
      projectId: query.projectId,
      label: '工具箱图片与标记原子事务',
      operations: [
        { type: 'image.create', id: imageId, stagedResource: staged.stagedResource },
        {
          type: 'marker.create',
          imageId,
          marker: {
            id: markerId,
            geometry: { type: 'rectangle', x: 0.2, y: 0.2, width: 0.3, height: 0.2 },
            translation: { runs: [] },
            style: { overlayText: true, horizontal: true },
            bunnyCache: { toolboxField: 'unknown field remains' },
          },
        },
        {
          type: 'translation.set',
          imageId,
          markerId,
          value: { runs: [{ text: '原子事务１２３', marks: ['bold', 'emphasis'] }] },
        },
        {
          type: 'assistance.update',
          imageId,
          markerId,
          patch: { originalText: 'Transaction source', machineTranslation: '批事务机器译文' },
        },
      ],
    });
    await refreshAfter(snapshot, { projectId: query.projectId, imageId, markerId });
    return result;
  });
  sdk.events.subscribe('context.changed', (value) => {
    const next = contextTarget(value);
    if (host && key(host) === key(next)) return;
    host = next;
    follow(next);
    output.dataset.error = 'false';
    output.textContent = '选择已同步';
    if (!next.projectId) {
      refreshEpoch++;
      refreshing = false;
      current = emptyTarget();
      images = [];
      projectName = '';
      render();
    } else background(refresh(next));
  });
  sdk.events.subscribe('document.changed', (change) => {
    for (const entry of change.changes)
      if (entry.kind === 'image.removed' || entry.kind === 'marker.removed')
        forget(
          {
            projectId: change.projectId,
            imageId: entry.imageId ?? '',
            markerId: entry.markerId ?? '',
          },
          entry.kind === 'marker.removed',
        );
    if (change.projectId === desired.projectId) background(refresh({ ...desired }));
  });
  sdk.events.subscribe('project.closed', (value) => {
    const closed = record(value).projectId;
    if (typeof closed === 'string') prune(closed, null);
  });
  window.addEventListener(
    'unload',
    () => {
      disposed = true;
      refreshEpoch++;
      clearPreview();
      drafts.clear();
      sdk.dispose();
    },
    { once: true },
  );
  await run(async () => {
    await refresh();
    return '工具箱已连接';
  });
}
window.addEventListener('message', connect);
