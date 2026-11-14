# DeepSeek 翻译

Bubblefish 的在线漫画翻译插件。网页和桌面使用同一份 TypeScript Worker，通过 DeepSeek Chat Completions API 或 HTTPS OpenAI 兼容网关翻译。参考了原版豆包插件的语言映射与漫画翻译提示词，使用当前版本的插件 SDK。

## 构建与安装

在仓库根目录执行：

```sh
npm run plugin:deepseek:check
npm run plugin:deepseek:build
```

生成 `dist/plugins/deepseek-translation-plugin.bfplugin`。也可以执行 `npm run plugin:pack -- plugins/deepseek-translation`。构建使用项目已锁定的 Vite，不需要新增 npm 依赖或原生推理运行库。

1. 在应用的“插件管理”安装这个包，点击“启用”。
2. 打开“DeepSeek 翻译设置”面板，填写 API Key，保存配置。
3. 新建或打开项目，在项目配置中设定源语言和目标语言。
4. 选中标记，填写或通过 OCR 得到“原文”，在“翻译插件”选择“DeepSeek 翻译”，点击“机器翻译”。
5. 返回的内容先进入“机器译文”；点击“采用机器译文”才更新人工译文。两者均沿用宿主的保存与撤销。

“整页标记”按现有工作流逐项翻译，成功结果原子写入。取消、删除目标、修改相关原文或语言后，旧结果不会覆盖新输入。设置每次翻译前读取，修改配置不需要停用插件。

设置面板在网页和桌面跟随软件当前的海洋、果实和夜间主题，使用宿主提供的文字、背景、字体及控件样式。切换主题不会重载面板，尚未保存的 Key、提示词、焦点和滚动保持不变。主题初始化超过 5 秒时会显示“重试加载”。旧安装包由更新后的宿主自动适配，无需卸载或重新填写配置；主题本身不进入插件配置、项目或历史。开发约定见 [面板主题变量](../../docs/PLUGINS.md#主题与基础样式)。

## 接口与模型

| 设置       | 默认值与说明                                                                |
| ---------- | --------------------------------------------------------------------------- |
| API Key    | 必填，以 Bearer 方式鉴权，界面使用密码输入框                                |
| API 地址   | 完整 URL：`https://api.deepseek.com/chat/completions`，不会自动追加路径     |
| 请求模式   | `deepseek` 显式发送 `thinking: {type: "disabled"}`；`openai` 省略该扩展字段 |
| 模型       | `deepseek-flash`；另提供 `deepseek-v4-pro` 预设，可输入网关自己的模型名     |
| 系统提示词 | 可编辑的多行漫画翻译规则                                                    |
| 用户提示词 | 默认 `{text}`，必须包含原文占位符                                           |

模型及非思考模式参数依据 [DeepSeek 官方 Chat Completions 文档](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。使用非流式文本响应，采样与最大输出长度使用服务端默认值。插件只取正常完成的最终 `content`，不会把思考内容当作译文。

自定义地址仅支持 HTTPS，不支持本机 HTTP 代理。网关需支持 Chat Completions 的 system/user 消息、Bearer 鉴权、`stream: false` 和标准 `choices[0].message.content`／`finish_reason` 响应。请选择适合网关的请求模式；插件不会在失败后自动删参数重试。

网页与桌面 Worker 均直接请求配置的地址。网关需要允许应用来源的 CORS 请求，包括 POST、Authorization 和 Content-Type；仅在命令行能请求成功不代表浏览器可以访问。API Key 和待翻译原文会发送至你配置的地址。

API Key 保存在宿主现有的插件配置中：网页为本站 IndexedDB，桌面为应用数据目录的 JSON。密码遮罩不代表系统密钥链加密。配置不进入 BF、文档历史或项目快照；插件不会记录 Key、完整请求、原文或译文。

## 自定义提示词

默认系统提示词：

```text
你是一个专业的{source_lang}到{target_lang}的漫画翻译。请只输出翻译后的文本，不要任何解释或额外信息。
```

两个模板均支持 `{source_lang}`、`{target_lang}`、`{text}`。例如系统提示词写风格和用词要求，用户提示词写：

```text
请把下面的{source_lang}漫画对白译成{target_lang}，保留换行：
{text}
```

语言名称映射为：`english → 英语`、`simplifiedChinese → 简体中文`、`traditionalChinese → 繁体中文`、`japanese → 日本語`、`auto → 自动检测`，未知代码保持原样。替换仅进行一次，原文中出现的占位符不会再次展开，其他花括号内容保持原样。

提示词留空时使用默认值。“恢复默认提示词”只重置两个提示词，需要保存后生效；API Key、地址、模式和模型保持当前输入。面板可以用示例原文和语言预览最终两条消息，预览完全在本地执行，不调用 API。

## 错误与取消

请求等待最多 120 秒，不自动重试。取消或停用会中止本地请求；已经到达服务端的请求可能仍被计算或计费。

- 401：检查 Key 和接口地址；402：检查账户余额。
- 400／422：检查模型名、请求模式和兼容网关支持的参数。
- 429：稍后重试，或降低其他客户端的并发。
- 500／503：服务故障或繁忙，稍后手动重试。
- 网络失败：检查网络、HTTPS 证书和网关 CORS 设置。
- 输出截断、过滤、被中断、空内容或异常 JSON：报告失败，保留原有机器译文。

## 验证

```sh
npx vitest run tests/deepseek-translation.test.ts
npx playwright test tests/deepseek-translation.spec.ts
```

浏览器测试安装实际插件包，用测试 Key 拦截 HTTPS API，检查请求、配置持久化、译文保存／撤销、取消与过期结果。它不代表真实付费接口验收。

真实 API 检查需显式提供 `DEEPSEEK_API_KEY`，运行 `npm run plugin:deepseek:smoke`。可选环境变量为 `DEEPSEEK_API_ENDPOINT`、`DEEPSEEK_MODEL` 和 `DEEPSEEK_REQUEST_MODE`（`deepseek` 或 `openai`）。该检查会发送固定日文样例并可能产生费用；脚本只报告完整非空响应是否成功，不输出 Key 或译文。未设置 Key 时明确输出 `SKIP`，不发请求。

插件 ID 为 `deepseek-translation-plugin`，provider ID 为 `deepseek-translation`。它只注册翻译计算能力和设置面板，不申请文档或图片读写权限。
