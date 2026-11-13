export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的{source_lang}到{target_lang}的漫画翻译。请只输出翻译后的文本，不要任何解释或额外信息。';
export const DEFAULT_USER_PROMPT = '{text}';

export interface DeepSeekConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  requestMode: 'deepseek' | 'openai';
  systemPrompt: string;
  userPrompt: string;
}
export interface TranslationInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}

function setting(raw: Record<string, unknown>, key: string, fallback = ''): string {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`配置 ${key} 必须是文本`);
  return value;
}

export function resolveConfig(raw: Record<string, unknown>, requireApiKey = true): DeepSeekConfig {
  const apiKey = setting(raw, 'apiKey').trim();
  if (requireApiKey && !apiKey) throw new Error('请先在 DeepSeek 翻译设置中填写 API Key');
  if (/[\r\n]/.test(apiKey)) throw new Error('API Key 不能包含换行');
  const endpoint = setting(raw, 'endpoint', DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('API 地址必须是完整的 HTTPS URL');
  }
  if (url.protocol !== 'https:' || !url.hostname)
    throw new Error('API 地址仅支持 HTTPS，请填写完整的 Chat Completions URL');
  if (url.username || url.password || url.hash)
    throw new Error('API 地址不能包含用户名、密码或 URL 片段');
  const model = setting(raw, 'model', DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const requestMode = setting(raw, 'requestMode', 'deepseek');
  if (requestMode !== 'deepseek' && requestMode !== 'openai')
    throw new Error('请求模式必须是 DeepSeek 或通用 OpenAI 兼容模式');
  const system = setting(raw, 'systemPrompt', DEFAULT_SYSTEM_PROMPT);
  const user = setting(raw, 'userPrompt', DEFAULT_USER_PROMPT);
  const systemPrompt = system.trim() ? system : DEFAULT_SYSTEM_PROMPT;
  const userPrompt = user.trim() ? user : DEFAULT_USER_PROMPT;
  if (!userPrompt.includes('{text}')) throw new Error('用户提示词必须包含 {text} 原文占位符');
  return { apiKey, endpoint, model, requestMode, systemPrompt, userPrompt };
}

const languages: Record<string, string> = {
  english: '英语',
  simplifiedChinese: '简体中文',
  traditionalChinese: '繁体中文',
  japanese: '日本語',
  auto: '自动检测',
};

export function parseTranslationInput(value: unknown): TranslationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('翻译输入格式无效');
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('缺少待翻译原文');
  if (typeof input.sourceLanguage !== 'string' || typeof input.targetLanguage !== 'string')
    throw new Error('缺少翻译的源语言或目标语言');
  return {
    text: input.text,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  };
}

export function renderMessages(config: DeepSeekConfig, input: TranslationInput) {
  const values = {
    source_lang: Object.hasOwn(languages, input.sourceLanguage)
      ? languages[input.sourceLanguage]
      : input.sourceLanguage,
    target_lang: Object.hasOwn(languages, input.targetLanguage)
      ? languages[input.targetLanguage]
      : input.targetLanguage,
    text: input.text,
  };
  const render = (template: string) =>
    template.replace(
      /\{(source_lang|target_lang|text)\}/g,
      (_match, key: keyof typeof values) => values[key],
    );
  return [
    { role: 'system' as const, content: render(config.systemPrompt) },
    { role: 'user' as const, content: render(config.userPrompt) },
  ];
}
