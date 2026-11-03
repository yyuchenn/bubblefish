import { connectPanel } from '../../../src/plugin-sdk';
import type {
  PluginGeometry,
  PluginImage,
  PluginMarker,
  PluginRichText,
} from '../../../src/generated/plugins';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
const text = (id: string) => element<HTMLTextAreaElement>(id);
const numeric = (id: string) => Number(input(id).value);

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
    images: PluginImage[] = [],
    previewUrl = '';
  const output = element<HTMLPreElement>('result');
  const imageQuery = () => {
    if (!projectId || !select('images').value) throw new Error('请先打开含有图片的项目');
    return { projectId, imageId: select('images').value };
  };
  const markerQuery = () => {
    if (!select('markers').value) throw new Error('请先选择或新增标记');
    return { ...imageQuery(), markerId: select('markers').value };
  };
  const geometry = (): PluginGeometry =>
    select('geometry').value === 'point'
      ? { type: 'point', x: numeric('x'), y: numeric('y') }
      : {
          type: 'rectangle',
          x: numeric('x'),
          y: numeric('y'),
          width: numeric('width'),
          height: numeric('height'),
        };
  const style = () => ({
    overlayText: input('overlay').checked,
    horizontal: input('horizontal').checked,
  });
  const richText = () => JSON.parse(text('richtext').value) as PluginRichText;
  const selectedImage = () => images.find((image) => image.id === select('images').value)!;
  async function run(operation: () => Promise<unknown>) {
    output.dataset.error = 'false';
    try {
      output.textContent = JSON.stringify(await operation(), null, 2) ?? '完成';
    } catch (error) {
      output.dataset.error = 'true';
      output.textContent = String(error);
    }
  }
  async function refresh(preferredImage?: string, preferredMarker?: string) {
    const current = (await sdk.document.read()) as {
      projectId?: string;
      id?: string;
      name?: string;
      selection?: { imageId?: string; markerId?: string };
    } | null;
    if (!current) {
      projectId = '';
      images = [];
      select('images').replaceChildren();
      select('markers').replaceChildren();
      element('project').textContent = '请先打开项目';
      return;
    }
    const previousProject = projectId;
    projectId = current.projectId ?? current.id ?? '';
    const oldImage =
      preferredImage ?? (previousProject === projectId ? select('images').value : '') ?? '';
    images = await sdk.document.images.list({ projectId });
    select('images').replaceChildren(
      ...images.map((image) => new Option(image.filename, image.id)),
    );
    const imageId = [oldImage, current.selection?.imageId, images[0]?.id].find((id) =>
      images.some((image) => image.id === id),
    );
    select('images').value = imageId ?? '';
    element('project').textContent = `${current.name ?? projectId} · ${images.length} 张图片`;
    await refreshMarkers(preferredMarker);
  }
  async function refreshMarkers(preferredMarker?: string) {
    const image = selectedImage();
    const oldMarker = preferredMarker ?? select('markers').value;
    const markers = image ? await sdk.document.markers.list(imageQuery()) : [];
    select('markers').replaceChildren(
      ...markers.map((marker, index) => new Option(`#${index + 1} · ${marker.id}`, marker.id)),
    );
    select('markers').value = markers.some((marker) => marker.id === oldMarker)
      ? oldMarker
      : (markers[0]?.id ?? '');
    input('filename').value = image?.filename ?? '';
    const marker = markers.find((entry) => entry.id === select('markers').value);
    if (marker) showMarker(marker);
  }
  function showMarker(marker: PluginMarker) {
    select('geometry').value = marker.geometry.type;
    input('x').value = String(marker.geometry.x);
    input('y').value = String(marker.geometry.y);
    if (marker.geometry.type === 'rectangle') {
      input('width').value = String(marker.geometry.width);
      input('height').value = String(marker.geometry.height);
    }
    input('overlay').checked = marker.style.overlayText;
    input('horizontal').checked = marker.style.horizontal;
    text('translation').value = marker.translation.runs.map((run) => run.text).join('');
    text('richtext').value = JSON.stringify(marker.translation, null, 2);
    const cache = marker.bunnyCache as Record<string, unknown> | undefined;
    text('original-text').value = typeof cache?.originalText === 'string' ? cache.originalText : '';
    text('machine-text').value =
      typeof cache?.machineTranslation === 'string' ? cache.machineTranslation : '';
  }
  async function preview(cropped: boolean) {
    const result = await sdk.document.images.read({
      ...imageQuery(),
      ...(cropped
        ? {
            region: {
              x: numeric('crop-x'),
              y: numeric('crop-y'),
              width: numeric('crop-width'),
              height: numeric('crop-height'),
            },
          }
        : {}),
    });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([result.binary], { type: result.metadata.mimeType }));
    const image = element<HTMLImageElement>('preview');
    image.src = previewUrl;
    image.hidden = false;
    return result.metadata;
  }
  async function uploaded() {
    if (!projectId) throw new Error('请先打开项目');
    const file = input('upload').files?.[0];
    if (!file) throw new Error('请先选择一张图片');
    return sdk.document.images.stage({ projectId, filename: file.name }, await file.arrayBuffer());
  }
  async function mutate(operation: () => Promise<unknown>) {
    const result = await operation();
    await refresh();
    return result;
  }
  function button(id: string, operation: () => Promise<unknown>) {
    element(id).addEventListener('click', () => void run(operation));
  }
  button('refresh', async () => {
    await refresh();
    return '已刷新';
  });
  select('images').addEventListener(
    'change',
    () =>
      void run(async () => {
        await refreshMarkers();
        return selectedImage();
      }),
  );
  select('markers').addEventListener(
    'change',
    () =>
      void run(async () => {
        const marker = await sdk.document.markers.get(markerQuery());
        if (marker) showMarker(marker);
        return marker;
      }),
  );
  button('image-get', () => sdk.document.images.get(imageQuery()));
  button('original', () => preview(false));
  button('crop', () => preview(true));
  button('image-create', async () => {
    const staged = await uploaded();
    const result = await sdk.document.images.create({
      projectId,
      stagedResource: staged.stagedResource,
      label: '工具箱新增图片',
    });
    await refresh(result.id);
    return result;
  });
  button('image-replace', () =>
    mutate(async () => {
      const query = imageQuery(),
        staged = await uploaded();
      return sdk.document.images.update({
        ...query,
        stagedResource: staged.stagedResource,
        label: '工具箱替换像素',
      });
    }),
  );
  button('image-copy', async () => {
    const query = imageQuery(),
      image = selectedImage();
    const { binary } = await sdk.document.images.read(query);
    const staged = await sdk.document.images.stage(
      { projectId, filename: `copy-${image.filename}` },
      binary,
    );
    const result = await sdk.document.images.create({
      projectId,
      stagedResource: staged.stagedResource,
      label: '工具箱复制原图',
    });
    await refresh(result.id);
    return result;
  });
  button('image-rename', () =>
    mutate(() =>
      sdk.document.images.update({
        ...imageQuery(),
        filename: input('filename').value,
        label: '工具箱修改图片名',
      }),
    ),
  );
  button('image-remove', () =>
    mutate(() => sdk.document.images.remove({ ...imageQuery(), label: '工具箱删除图片' })),
  );
  button('image-reorder', () =>
    mutate(() =>
      sdk.document.images.reorder({
        projectId,
        imageIds: images.map((image) => image.id).reverse(),
        label: '工具箱反转图片顺序',
      }),
    ),
  );
  button('marker-create', async () => {
    const result = await sdk.document.markers.create({
      ...imageQuery(),
      label: '工具箱新增标记',
      marker: {
        geometry: geometry(),
        style: style(),
        translation: { runs: [] },
        bunnyCache: { toolboxField: { preserved: true } },
      },
    });
    await refresh(undefined, result.id);
    return result;
  });
  button('marker-get', () => sdk.document.markers.get(markerQuery()));
  button('marker-update', () =>
    mutate(() =>
      sdk.document.markers.update({
        ...markerQuery(),
        geometry: geometry(),
        style: style(),
        label: '工具箱调整标记',
      }),
    ),
  );
  button('marker-remove', () =>
    mutate(() => sdk.document.markers.remove({ ...markerQuery(), label: '工具箱删除标记' })),
  );
  button('marker-reorder', () =>
    mutate(async () =>
      sdk.document.markers.reorder({
        ...imageQuery(),
        markerIds: (await sdk.document.markers.list(imageQuery()))
          .map((marker) => marker.id)
          .reverse(),
        label: '工具箱反转标记顺序',
      }),
    ),
  );
  button('translation-get', () => sdk.document.translations.get(markerQuery()));
  button('translation-set', () =>
    mutate(() =>
      sdk.document.translations.set({
        ...markerQuery(),
        value: text('translation').value,
        label: '工具箱写入纯文本',
      }),
    ),
  );
  button('translation-rich', () =>
    mutate(() =>
      sdk.document.translations.set({
        ...markerQuery(),
        value: richText(),
        label: '工具箱写入富文本',
      }),
    ),
  );
  button('translation-clear', () =>
    mutate(() => sdk.document.translations.clear({ ...markerQuery(), label: '工具箱清空译文' })),
  );
  button('assistance-get', () => sdk.document.assistance.get(markerQuery()));
  button('assistance-update', () =>
    mutate(() =>
      sdk.document.assistance.update({
        ...markerQuery(),
        patch: {
          originalText: text('original-text').value,
          machineTranslation: text('machine-text').value,
          lastOcrModel: 'example.document-toolbox',
          lastTranslationService: 'example.document-toolbox',
        },
        label: '工具箱更新辅助文本',
      }),
    ),
  );
  button('assistance-clear', () =>
    mutate(() => sdk.document.assistance.clear({ ...markerQuery(), label: '工具箱清空辅助文本' })),
  );
  button('batch', async () => {
    const query = imageQuery(),
      source = selectedImage();
    const { binary } = await sdk.document.images.read(query);
    const staged = await sdk.document.images.stage(
      { projectId, filename: `batch-${source.filename}` },
      binary,
    );
    const imageId = sdk.document.createId(),
      markerId = sdk.document.createId();
    const result = await sdk.document.transaction({
      projectId,
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
    await refresh(imageId, markerId);
    return result;
  });
  sdk.events.subscribe(
    'context.changed',
    () =>
      void run(async () => {
        await refresh();
        return '选择已同步';
      }),
  );
  window.addEventListener('unload', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    sdk.dispose();
  });
  await run(async () => {
    await refresh();
    return '工具箱已连接';
  });
}
window.addEventListener('message', connect);
