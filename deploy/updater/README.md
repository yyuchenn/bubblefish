# Bubblefish 自动更新发布

正式更新源保持不变：

- GitHub：`https://raw.githubusercontent.com/yyuchenn/bubblefish/updater/latest.json`
- Gitee：`https://gitee.com/yyuchenn/bubblefish/raw/updater/latest.json`

公钥以 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 为准，沿用 0.3.0 的公钥。不重新生成密钥。沿用仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`GITEE_TOKEN`，以及自动提供的 `GITHUB_TOKEN`。Windows 系统代码签名继续使用可选的 `WINDOWS_CERTIFICATE` 和 `WINDOWS_CERTIFICATE_PASSWORD`；它与更新签名独立。Gitee Token 需对 `yyuchenn/bubblefish` 仓库具有代码和发行版附件写权限。

发布 Release 后，桌面 workflow 构建 Windows x64 的 MSI、NSIS，以及 macOS ARM64 的 DMG 和 app 压缩包。Windows 先完成 Authenticode；macOS 完成最终压缩；随后调用锁定的 Tauri CLI `signer sign --app-version` 对最终字节生成 `.sig`。签名文件保留在 CI 暂存产物中，用于验签，不再作为公开 Release 附件上传。`createUpdaterArtifacts` 保持关闭，避免对后续还会改变的安装器提前签名。

双平台成功后，复用的 `update-manifests.yml` 才开始发布。它使用 Node 的 Ed25519/BLAKE2b 校验原公钥、安装器内容及已签名的版本和文件名，并检查已公开的同名安装器与待发布内容一致，然后在 GitHub `updater` 分支提交 `releases/<tag>.json`，再上传安装器。归档包含 tag、版本、发布 commit，以及四种安装器的文件名、SHA-256 和签名（含 DMG），不包含安装器字节。相同 tag 的发布身份和安装器内容不可改变；同一安装器的有效既有签名可复用，不删除或覆盖历史归档及冲突的已发布文件。

Gitee 仓库只作为下载和更新镜像，不保存 GitHub 源码，也不要求两站同名 tag 指向相同 commit。流水线先在 Gitee 的 `updater` 分支归档签名，再镜像安装器至 Gitee Release；归档中的 `releaseCommit` 始终表示 GitHub 源码来源，不要求对应 Git 对象存在于 Gitee。新建 Gitee Release 时以 `updater` 为 `target_commitish`，已有同名 Release 和 tag 直接复用，不推送源码或改写 tag。Gitee 自动提供的 Source code 归档因此只包含该镜像 tag 对应的内容，不代表应用源码。

两站只新增安装器附件，不新增 `.sig` 附件。下载地址取自 Gitee API 返回的 `browser_download_url`，不靠替换域名猜测；流水线不带凭据下载公开附件并校验完整内容。Gitee 的单个附件上限按普通仓库 100 MB 检查；权限、容量或公开下载失败会阻止更新清单发布。

插件由独立的 `Build Bubblefish plugins` 工作流构建和发布：下载本次构建的五个 Web／示例插件包与两个原生插件包，再调用 `scripts/publish-plugins.mjs`，将七个 `.bfplugin` 附加到同一 tag 的 GitHub 和 Gitee Release。包含 DeepSeek、document-toolbox、history-inspector、edit-guard、Kha Web、Kha Windows x64 和 Kha macOS ARM64；不附加独立 `.bfmodel`。插件发布与桌面发布共用发布锁，避免竞争创建 Gitee Release，但不互相依赖。Gitee 仓库需预先有 `updater` 分支，插件流程不创建源码分支或推送源码 tag。插件失败不会阻止桌面安装器和自动更新发布；重跑插件任务可补齐，已有同名插件必须内容一致才会复用，不覆盖冲突文件。插件脚本不写签名归档或更新清单。

GitHub 和 Gitee 的每次安装器或插件附件上传最多等待 15 分钟；普通 API 查询、创建 Release 和下载仍为每次请求 2 分钟。GET 沿用现有重试策略，上传 POST 不自动重放，以免响应丢失后重复创建附件。15 分钟是脚本设置的总时限；Node HTTP 客户端自身的连接、响应头或响应体超时仍可能更早中断请求，日志中的原因码可区分这些情况。延长总时限不会消除 DNS、连接或 TLS 等底层故障。

请求失败时，日志在错误摘要后附带 JSON 诊断信息：`phase` 区分请求、HTTP 状态、JSON 解析或下载正文读取阶段；`method`、`url` 标识请求；附件上传另有 `attachmentName` 和 `attachmentSize`（原文件字节数）。`elapsedMs` 是当前尝试从发起请求到失败的耗时，`timeoutMs` 是该次请求超时，`attempt` 和 `maxAttempts` 表示当前尝试及上限，收到响应时另有 `status`。`causes` 保留异常链和聚合异常中的类型及原因码，例如 `TimeoutError`、`ECONNRESET`、`ENOTFOUND` 或 `UND_ERR_CONNECT_TIMEOUT`。日志长度有限，不输出 URL 凭据及查询参数、请求头、文件内容、原始异常消息或响应正文；CLI 仅打印安全摘要。

两站的安装器均验证成功后，才分别快进提交各自 `updater` 分支上的 `latest.json`，其平台条目继续内嵌签名，客户端更新接口不变。版本归档可以提前写入，但不会推进 `latest.json`。保留分支内其他文件，不强制推送。稳定版更新通用 Windows 键指向 NSIS，以使用 Tauri 自带的 MSI → NSIS 迁移，并兼容旧 NSIS；0.4.0 的 MSI、NSIS 客户端使用各自专用键。macOS 通用键和 app 专用键指向同一 app 压缩包。旧 MSI 迁移可能显示系统卸载确认；发布前需实机验证旧 MSI 与 NSIS 的升级、取消、文件关联和用户数据保留。

默认源只推进稳定版，预发布版可以签名、归档和镜像，但不覆盖稳定清单。PR、push 和普通手动构建不发布更新源。共享发布锁与远端版本比较阻止旧任务回退新版。跨 GitHub/Gitee 无法同时提交：若第二站清单提交失败，第一站保持完整可用的新版、第二站保持原有版本，重试补齐即可。

手动修复时，在 Actions 运行 `Publish Bubblefish updater manifests` 并填写已发布 tag；它优先读取 GitHub 的版本签名归档，再下载并验证已有安装器，不重新签名。无归档的旧 Release 仍兼容读取 `.sig` 附件，已有历史 `.sig` 不删除。只修复 Gitee 时运行 `Repair Bubblefish Gitee mirror`，同样填写 tag；此模式不会补写 GitHub 归档或改动其更新清单。若 GitHub 安装器已完整上传，即使 Gitee 发布中断，也可只凭 GitHub 安装器和签名归档恢复；若 GitHub 安装器尚未上传完整，仍需复用保留期内的 CI 暂存产物，签名归档不能还原安装器字节。重新构建同一版本若产生不同安装器字节会被拒绝，应复用已签名资产或发布新的版本。

发布工作流检出填写的 tag，因此镜像逻辑、签名归档、附件调整、超时和日志改进只对包含相应脚本修改的 tag 生效；重跑旧 tag 仍使用该 tag 中的旧逻辑。删除并重新创建 Release 不会清除两站 `updater/releases/<tag>.json` 的历史归档；同名安装器若重建为不同字节，归档校验仍会拒绝。复用原安装器或发布新版本可以保留既有发布记录；若手工重置未完成的同版本发布，需要另外处理两站该版本的归档和同名附件，不能只删除 Release 页面。

本地回归：`node --test scripts/*.test.mjs`。测试仅用临时密钥、本地 Git 仓库和假的 HTTP 接口，不读取真实 Secret 或写入远端。
