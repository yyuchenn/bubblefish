import manifest from './model-manifest.json';
export const MODEL = manifest;
export const EXPECTED_TEXT = '今日はいい天気ですね。';
export const CHUNK_SIZE = 4 * 1024 * 1024;
export function validateModel(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('模型包清单无效');
  const candidate = value as typeof MODEL;
  if (
    candidate.format !== MODEL.format ||
    candidate.version !== 1 ||
    candidate.id !== MODEL.id ||
    !Array.isArray(candidate.files) ||
    candidate.files.length !== MODEL.files.length
  )
    throw new Error('需要已验证的 Kha White FP32 模型包');
  for (const expected of MODEL.files) {
    const matches = candidate.files.filter((file) => file.path === expected.path);
    if (
      matches.length !== 1 ||
      matches[0].byteLength !== expected.byteLength ||
      matches[0].sha256 !== expected.sha256
    )
      throw new Error(`模型文件与已验证版本不一致：${expected.path}`);
  }
  return MODEL;
}
