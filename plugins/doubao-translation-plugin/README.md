# Doubao Translation Plugin

使用火山方舟 Responses API 翻译漫画文本，同时支持桌面端原生插件和 Web Worker 中的 WASM 插件。

## 配置

在「设置 → 插件」中填写火山方舟 API Key，并在方舟控制台开通所选模型。插件提供以下 Seed 2.1 选项：

| 模型 | Model ID |
| --- | --- |
| Pro（2026-09-15，默认） | `doubao-seed-2-1-pro-260915` |
| Lite（2026-09-15） | `doubao-seed-2-1-lite-260915` |
| Turbo（2026-06-28） | `doubao-seed-2-1-turbo-260628` |
| Pro（2026-06-28） | `doubao-seed-2-1-pro-260628` |

系统提示词可使用 `{source_lang}` 和 `{target_lang}`，留空使用内置翻译提示词。

从 0.1.0 升级时，原有 Seed 1.6、Seed 1.6 Flash、Doubao 1.5 Pro 32K 配置自动迁移到默认 Pro。迁移只修改模型，保留 API Key、自定义提示词及其他配置。Web 和桌面端各自迁移其配置存储；若保存失败，请求仍会使用新默认模型。

每次翻译独立调用 `https://ark.cn-beijing.volces.com/api/v3/responses`，关闭深度思考、流式输出和响应存储。仅将模型返回的最终文本作为译文，失败或未完成的响应会显示错误。请求失败时不会自动切换模型或重试。

## 验证

从仓库根目录执行：

```sh
cargo test -p doubao-translation-plugin --features native --locked
cargo build -p doubao-translation-plugin --features native --locked
wasm-pack build plugins/doubao-translation-plugin --target web --dev -- --features wasm --locked
node --test plugins/doubao-translation-plugin/tests/worker.integration.test.mjs
npm --prefix frontend run test:config-migration
npm --prefix frontend run check
```

Worker 测试使用真实编译的 WASM、模拟 API 响应和测试密钥，不调用线上计费接口。测试环境及限制见 [tests/README.md](tests/README.md)。完整前端检查需要先按根目录 `build.py` 生成 core WASM 资源。

## 官方参考

模型与协议核对日期：2026-09-22。

- [模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)
- [Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)
- [深度思考参数](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh)
