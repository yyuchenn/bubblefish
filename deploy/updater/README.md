# Bubblefish 自动更新发布

正式更新源保持不变：

- GitHub：`https://raw.githubusercontent.com/yyuchenn/bubblefish/updater/latest.json`
- Gitee：`https://gitee.com/yyuchenn/bubblefish/raw/updater/latest.json`

公钥以 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 为准，沿用 0.3.0 的公钥。不重新生成密钥。沿用仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`GITEE_TOKEN`，以及自动提供的 `GITHUB_TOKEN`。Windows 系统代码签名继续使用可选的 `WINDOWS_CERTIFICATE` 和 `WINDOWS_CERTIFICATE_PASSWORD`；它与更新签名独立。Gitee Token 需对 `yyuchenn/bubblefish` 仓库具有代码和发行版附件写权限。

发布 Release 后，桌面 workflow 构建 Windows x64 的 MSI、NSIS，以及 macOS ARM64 的 DMG 和 app 压缩包。Windows 先完成 Authenticode；macOS 完成最终压缩；随后调用锁定的 Tauri CLI `signer sign --app-version` 对最终字节生成 `.sig`。`createUpdaterArtifacts` 保持关闭，避免对后续还会改变的安装器提前签名。

双平台成功后，复用的 `update-manifests.yml` 才开始发布。它使用 Node 的 Ed25519/BLAKE2b 校验原公钥、安装器内容及已签名的版本和文件名，再上传安装器和签名至 GitHub。相同文件名若已存在，必须内容一致；同一安装器的有效既有签名可复用。不会删除或覆盖冲突的已发布文件。

接着将相同 tag、安装器和签名镜像至 Gitee Release。下载地址取自 Gitee API 返回的 `browser_download_url`，不靠替换域名猜测。流水线不带凭据下载公开附件并校验完整内容；插件和模型不属于应用安装器镜像。Gitee 的单个附件上限按普通仓库 100 MB 检查；权限、容量或公开下载失败会阻止更新清单发布。

GitHub 和 Gitee 的每次附件上传（含 `.sig`）最多等待 15 分钟；普通 API 查询、创建 Release 和下载仍为每次请求 2 分钟。GET 沿用现有重试策略，上传 POST 不自动重放，以免响应丢失后重复创建附件。15 分钟是脚本设置的总时限；Node HTTP 客户端自身的连接、响应头或响应体超时仍可能更早中断请求，日志中的原因码可区分这些情况。延长总时限不会消除 DNS、连接或 TLS 等底层故障。

请求失败时，日志在错误摘要后附带 JSON 诊断信息：`phase` 区分请求、HTTP 状态、JSON 解析或下载正文读取阶段；`method`、`url` 标识请求；附件上传另有 `attachmentName` 和 `attachmentSize`（原文件字节数）。`elapsedMs` 是当前尝试从发起请求到失败的耗时，`timeoutMs` 是该次请求超时，`attempt` 和 `maxAttempts` 表示当前尝试及上限，收到响应时另有 `status`。`causes` 保留异常链和聚合异常中的类型及原因码，例如 `TimeoutError`、`ECONNRESET`、`ENOTFOUND` 或 `UND_ERR_CONNECT_TIMEOUT`。日志长度有限，不输出 URL 凭据及查询参数、请求头、文件内容、原始异常消息或响应正文；CLI 仅打印安全摘要。

两站的安装器均验证成功后，才分别快进提交各自 `updater` 分支上的 `latest.json`。保留分支内其他文件，不强制推送。稳定版更新通用 Windows 键指向 NSIS，以使用 Tauri 自带的 MSI → NSIS 迁移，并兼容旧 NSIS；0.4.0 的 MSI、NSIS 客户端使用各自专用键。macOS 通用键和 app 专用键指向同一 app 压缩包。旧 MSI 迁移可能显示系统卸载确认；发布前需实机验证旧 MSI 与 NSIS 的升级、取消、文件关联和用户数据保留。

默认源只推进稳定版，预发布版可以签名和镜像，但不覆盖稳定清单。PR、push 和普通手动构建不发布更新源。共享发布锁与远端版本比较阻止旧任务回退新版。跨 GitHub/Gitee 无法同时提交：若第二站清单提交失败，第一站保持完整可用的新版、第二站保持原有版本，重试补齐即可。

手动修复时，在 Actions 运行 `Publish Bubblefish updater manifests` 并填写已发布 tag；它读取和验证已有安装器，不重新签名。只修复 Gitee 时运行 `Repair Bubblefish Gitee mirror`，同样填写 tag。重新构建同一版本若产生不同安装器字节会被拒绝；修复发布应复用已签名的 Release 资产，或发布新的版本。

发布工作流检出填写的 tag，因此超时和日志改进只对包含相应脚本修改的后续 tag 生效；重跑现有 `v0.4.0` 仍使用该 tag 中的旧逻辑。

本地回归：`node --test scripts/*.test.mjs`。测试仅用临时密钥、本地 Git 仓库和假的 HTTP 接口，不读取真实 Secret 或写入远端。
