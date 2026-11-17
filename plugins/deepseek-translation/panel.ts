import { connectPanel } from '../../src/plugin-sdk';
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_PROMPT,
  resolveConfig,
  renderMessages,
  type DeepSeekConfig,
} from './config';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fields = {
  apiKey: element<HTMLInputElement>('api-key'),
  endpoint: element<HTMLInputElement>('endpoint'),
  model: element<HTMLInputElement>('model'),
  requestMode: element<HTMLSelectElement>('request-mode'),
  systemPrompt: element<HTMLTextAreaElement>('system-prompt'),
  userPrompt: element<HTMLTextAreaElement>('user-prompt'),
};
const form = element<HTMLFormElement>('settings-form');
const status = element<HTMLParagraphElement>('status');
const secrets = new Set<string>();
let sdk: ReturnType<typeof connectPanel> | undefined;
let saving = false;

function redact(value: string) {
  const currentKey = fields.apiKey.value.trim();
  const knownKeys = new Set(secrets);
  if (currentKey) knownKeys.add(currentKey);
  for (const secret of [...knownKeys].sort((left, right) => right.length - left.length))
    value = value.split(secret).join('[已隐藏]');
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
}

function showError(error: unknown) {
  return redact(error instanceof Error ? error.message : '操作失败，请重试').slice(0, 600);
}

function showStatus(message: string, error = false) {
  status.dataset.error = String(error);
  status.textContent = redact(message);
}

function readForm() {
  const apiKey = fields.apiKey.value;
  return {
    apiKey,
    endpoint: fields.endpoint.value,
    model: fields.model.value,
    requestMode: fields.requestMode.value,
    systemPrompt: fields.systemPrompt.value,
    userPrompt: fields.userPrompt.value,
  };
}

function fillForm(config: Record<string, unknown>) {
  fields.apiKey.value = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (fields.apiKey.value.trim()) secrets.add(fields.apiKey.value.trim());
  fields.endpoint.value = typeof config.endpoint === 'string' ? config.endpoint : DEFAULT_ENDPOINT;
  fields.model.value = typeof config.model === 'string' ? config.model : DEFAULT_MODEL;
  fields.requestMode.value = config.requestMode === 'openai' ? 'openai' : 'deepseek';
  fields.systemPrompt.value =
    typeof config.systemPrompt === 'string' ? config.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  fields.userPrompt.value =
    typeof config.userPrompt === 'string' ? config.userPrompt : DEFAULT_USER_PROMPT;
}

function preview() {
  const errorOutput = element('preview-error');
  const systemOutput = element('system-preview');
  const userOutput = element('user-preview');
  try {
    const config = resolveConfig(readForm(), false);
    const messages = renderMessages(config, {
      text: element<HTMLTextAreaElement>('sample-text').value,
      sourceLanguage: element<HTMLSelectElement>('source-language').value,
      targetLanguage: element<HTMLSelectElement>('target-language').value,
    });
    systemOutput.textContent = redact(messages[0]?.content ?? '');
    userOutput.textContent = redact(messages[1]?.content ?? '');
    errorOutput.hidden = true;
    errorOutput.textContent = '';
  } catch (error) {
    systemOutput.textContent = '';
    userOutput.textContent = '';
    errorOutput.textContent = showError(error);
    errorOutput.hidden = false;
  }
}

fillForm({});
preview();
form.addEventListener('input', () => {
  preview();
  if (sdk && !saving) showStatus('有未保存的更改');
});
form.addEventListener('change', () => {
  preview();
  if (sdk && !saving) showStatus('有未保存的更改');
});
for (const id of ['sample-text', 'source-language', 'target-language']) {
  element(id).addEventListener('input', preview);
  element(id).addEventListener('change', preview);
}

element('restore-prompts').addEventListener('click', () => {
  fields.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
  fields.userPrompt.value = DEFAULT_USER_PROMPT;
  preview();
  showStatus('已恢复默认提示词，保存后生效');
});

function save() {
  if (!sdk || saving) return;
  let config: DeepSeekConfig;
  try {
    config = resolveConfig(readForm());
  } catch (error) {
    showStatus(showError(error), true);
    preview();
    return;
  }
  secrets.add(config.apiKey);
  const submitted = JSON.stringify(readForm());
  const connection = sdk;
  saving = true;
  element<HTMLButtonElement>('save').disabled = true;
  showStatus('正在保存配置…');
  void connection.config
    .update({ ...config })
    .then(() => {
      showStatus(
        JSON.stringify(readForm()) === submitted
          ? '配置已保存，下一次翻译请求生效'
          : '提交时的配置已保存；当前表单还有未保存的更改',
      );
    })
    .catch((error: unknown) => showStatus(showError(error), true))
    .finally(() => {
      saving = false;
      element<HTMLButtonElement>('save').disabled = false;
    });
}

// Panels deliberately lack allow-forms. Save through SDK RPC without native submission.
form.addEventListener('submit', (event) => event.preventDefault());
element('save').addEventListener('click', save);

window.addEventListener('message', async function connect(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  sdk = connectPanel(event.ports[0]);
  try {
    const raw = (await sdk.config.get()) as Record<string, unknown>;
    fillForm(raw);
    const config = resolveConfig(raw, false);
    fillForm({ ...config });
    showStatus(config.apiKey ? '配置已加载' : '请填写 API Key 并保存配置');
  } catch (error) {
    showStatus(showError(error), true);
  } finally {
    element<HTMLFieldSetElement>('config-fields').disabled = false;
    preview();
  }
});

window.addEventListener('unload', () => sdk?.dispose(), { once: true });
