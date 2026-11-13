import type { PluginContext } from '../../src/plugin-sdk';
import { DeepSeekClient } from './client';
import { parseTranslationInput, resolveConfig } from './config';

let client: DeepSeekClient | undefined;

export function activate(ctx: PluginContext) {
  if (ctx.runtimeRole !== 'main') return;
  const runtime = (client = new DeepSeekClient());
  ctx.subscriptions.add({ dispose: () => runtime.dispose() });
  ctx.subscriptions.add(
    ctx.translation.register(
      { id: 'deepseek-translation', name: 'DeepSeek 翻译' },
      async (input, task) => {
        task.signal.throwIfAborted();
        const parsed = parseTranslationInput(input);
        const config = resolveConfig(await ctx.config.get());
        return runtime.translate(config, parsed, task);
      },
    ),
  );
}

export function deactivate() {
  client?.dispose();
  client = undefined;
}
