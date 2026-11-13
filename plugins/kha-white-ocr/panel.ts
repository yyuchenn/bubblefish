import { connectPanel } from '../../src/plugin-sdk';
import { MODEL, EXPECTED_TEXT } from './model';
import { importModel } from './import-model';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
window.addEventListener('message', async function connect(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  const output = element<HTMLPreElement>('result'),
    status = element('model-state');
  let busy = false,
    importing: AbortController | undefined;
  function state(value: boolean) {
    busy = value;
    for (const button of document.querySelectorAll<HTMLButtonElement>('button:not(#cancel)'))
      button.disabled = value;
    element<HTMLInputElement>('file').disabled = value;
  }
  async function refresh() {
    const sets = await sdk.resources.local.list();
    const installed = sets.find((entry) => entry.id === MODEL.id);
    const runtime = (await sdk.commands.execute('model-status')) as {
      backend?: string;
      ready?: boolean;
    };
    status.textContent = `${installed ? '模型已导入 · SHA-256 校验通过' : '尚未导入模型'} · ${runtime?.backend ?? '未知后端'} · ${runtime?.ready ? '推理会话已就绪' : '首次识别时加载会话'}`;
  }
  async function run(operation: () => Promise<unknown>) {
    if (busy) return;
    state(true);
    output.dataset.error = 'false';
    try {
      const result = await operation();
      output.textContent = JSON.stringify(result, null, 2) ?? '完成';
    } catch (error) {
      output.dataset.error = 'true';
      output.textContent = String(error);
    } finally {
      state(false);
    }
  }
  element('import').onclick = () =>
    void run(async () => {
      const file = element<HTMLInputElement>('file').files?.[0];
      if (!file) throw new Error('请先选择 .bfmodel 离线模型包');
      importing = new AbortController();
      const controller = importing;
      const meter = element<HTMLProgressElement>('progress'),
        label = element('import-status');
      meter.hidden = false;
      element('cancel').hidden = false;
      try {
        await importModel(file, sdk.resources.local, controller.signal, (done, total) => {
          meter.max = total;
          meter.value = done;
          label.textContent = `正在导入并校验 ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`;
        });
        await sdk.commands.execute('reset-model');
        label.textContent = '模型导入成功，已持久保存';
        await refresh();
        return { imported: MODEL.id };
      } catch (error) {
        label.textContent = controller.signal.aborted
          ? '导入已取消，原有模型保持可用'
          : '导入失败，原有模型保持可用';
        throw error;
      } finally {
        importing = undefined;
        element('cancel').hidden = true;
      }
    });
  element('cancel').onclick = () => importing?.abort();
  element('refresh').onclick = () =>
    void run(async () => {
      await refresh();
      return '状态已更新';
    });
  element('test').onclick = () =>
    void run(async () => {
      output.textContent = '正在加载模型并识别内置日文样例…';
      const result = (await sdk.commands.execute('self-test')) as {
        text?: string;
        passed?: boolean;
      };
      await refresh();
      if (!result.passed || result.text !== EXPECTED_TEXT)
        throw new Error(`OCR 自检失败：${JSON.stringify(result)}`);
      return result;
    });
  element('reset').onclick = () =>
    void run(async () => {
      await sdk.commands.execute('reset-model');
      await refresh();
      return '推理会话已释放';
    });
  element('remove').onclick = () =>
    void run(async () => {
      await sdk.resources.local.remove({ id: MODEL.id });
      await sdk.commands.execute('reset-model');
      await refresh();
      return '模型已清除';
    });
  window.addEventListener('unload', () => {
    importing?.abort();
    sdk.dispose();
  });
  await run(async () => {
    await refresh();
    return '模型管理已连接';
  });
});
