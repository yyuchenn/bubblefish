import { connectPanel } from '../../../src/plugin-sdk';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function connect(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  const output = element('result'),
    delay = element<HTMLInputElement>('delay'),
    text = element<HTMLTextAreaElement>('text');
  async function run(operation: () => Promise<unknown>) {
    output.dataset.error = 'false';
    try {
      output.textContent = JSON.stringify(await operation(), null, 2) ?? '完成';
    } catch (error) {
      output.dataset.error = 'true';
      output.textContent = String(error);
    }
  }
  async function target() {
    const current = (await sdk.document.read()) as {
      projectId?: string;
      id?: string;
      selection?: { imageId?: string; markerId?: string };
    } | null;
    const projectId = current?.projectId ?? current?.id;
    if (!projectId) throw new Error('请先打开项目并选择标记');
    const images = await sdk.document.images.list({ projectId });
    const image = images.find((entry) => entry.id === current?.selection?.imageId) ?? images[0];
    if (!image) throw new Error('项目中没有图片');
    const markers = await sdk.document.markers.list({ projectId, imageId: image.id });
    const marker = markers.find((entry) => entry.id === current?.selection?.markerId) ?? markers[0];
    if (!marker) throw new Error('请先新增一个标记');
    element('target').textContent = `${projectId} / ${image.filename} / ${marker.id}`;
    return { projectId, imageId: image.id, markerId: marker.id };
  }
  const button = (id: string, operation: () => Promise<unknown>) =>
    element(id).addEventListener('click', () => void run(operation));
  const updateDelay = async (value: number) => {
    delay.value = String(value);
    await sdk.config.update({ delayMs: value });
    return { delayMs: value };
  };
  button('normalize', async () => {
    text.value = '测试１２３';
    return '点击“写入当前标记”，实际结果为测试123';
  });
  button('reject', async () => {
    text.value = '１２３ [BLOCK]';
    return '拒绝原因将包含前一钩子规范化后的 123 [BLOCK]';
  });
  button('apply', async () => {
    const query = await target();
    const result = await sdk.document.translations.set({
      ...query,
      value: text.value,
      label: '编辑检查示例写入',
    });
    return { result, actual: await sdk.document.translations.get(query) };
  });
  button('read', async () => sdk.document.translations.get(await target()));
  button('config', () => updateDelay(Math.max(0, Math.min(5000, Number(delay.value) || 0))));
  button('timeout', () => updateDelay(400));
  button('reset', () => updateDelay(0));
  button('probe', () => sdk.commands.execute('probe-main'));
  sdk.events.subscribe('context.changed', () => {
    void target().catch(() => {});
  });
  window.addEventListener('unload', () => sdk.dispose());
  await run(async () => {
    const config = (await sdk.config.get()) as Record<string, unknown>;
    delay.value = String(config.delayMs ?? 0);
    await target();
    return '编辑检查插件已连接';
  });
}
window.addEventListener('message', connect);
