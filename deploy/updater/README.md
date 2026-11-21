# Bubblefish 自动更新发布

正式更新源保持不变：

- GitHub：`https://raw.githubusercontent.com/yyuchenn/bubblefish/updater/latest.json`
- Gitee：`https://gitee.com/yyuchenn/bubblefish/raw/updater/latest.json`

公钥以 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 为准，沿用 0.3.0 的公钥。不重新生成密钥。沿用仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`GITEE_TOKEN`，以及自动提供的 `GITHUB_TOKEN`。Windows 系统代码签名继续使用可选的 `WINDOWS_CERTIFICATE` 和 `WINDOWS_CERTIFICATE_PASSWORD`；它与更新签名独立。Gitee Token 需对 `yyuchenn/bubblefish` 仓库具有代码和发行版附件写权限。

发布 Release 后，桌面 workflow 构建 Windows x64 的 MSI、NSIS，以及 macOS ARM64 的 DMG 和 app 压缩包。Windows 先完成 Authenticode；macOS 完成最终压缩；随后调用锁定的 Tauri CLI `signer sign --app-version` 对最终字节生成 `.sig`。签名文件保留在 CI 暂存产物中，用于验签，不再作为公开 Release 附件上传。`createUpdaterArtifacts` 保持关闭，避免对后续还会改变的安装器提前签名。

双平台成功后，复用的 `update-manifests.yml` 才开始发布。它使用 Node 的 Ed25519/BLAKE2b 校验原公钥、安装器内容及已签名的版本和文件名，并检查已公开的同名安装器与待发布内容一致，然后在 GitHub `updater` 分支提交 `releases/<tag>.json`，再上传安装器。归档包含 tag、版本、发布 commit，以及四种安装器的文件名、SHA-256 和签名（含 DMG），不包含安装器字节。相同 tag 的发布身份和安装器内容不可改变；同一安装器的有效既有签名可复用，不删除或覆盖历史归档及冲突的已发布文件。

Gitee 仓库只作为下载和更新镜像，不保存 GitHub 源码，也不要求两站同名 tag 指向相同 commit。流水线先在 Gitee 的 `updater` 分支归档签名，再镜像安装器至 Gitee Release；归档中的 `releaseCommit` 始终表示 GitHub 源码来源，不要求对应 Git 对象存在于 Gitee。新建 Gitee Release 时以 `updater` 为 `target_commitish`，已有同名 Release 和 tag 直接复用，不推送源码或改写 tag。Gitee 自动提供的 Source code 归档因此只包含该镜像 tag 对应的内容，不代表应用源码。

桌面流程在两站只新增安装器附件，不新增 `.sig` 附件。下载地址取自 Gitee API 返回的 `browser_download_url`，不靠替换域名猜测；流水线不带凭据下载公开附件并校验完整内容。Gitee 的单个附件上限按普通仓库 100 MB 检查；权限、容量或公开下载失败会阻止更新清单发布。

插件由独立的 `Build Bubblefish plugins` 工作流构建和发布，只将四类正式 `.bfplugin` 附加到同一 tag 的 GitHub 和 Gitee Release：`deepseek-translation-plugin.bfplugin`、`kha-white-ocr-plugin-web.bfplugin`、`kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin` 和 `kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin`。OCR 沿用 Web、Windows x64、macOS ARM64 三个变体；示例插件独立构建和检查，不进入 Release，也不附加独立 `.bfmodel`。

DeepSeek、Kha Web 和双平台原生插件分别构建、检查和上传 CI Artifact，发布任务收集本次运行实际存在的正式包。某个包构建失败不会阻止其他成功包上传，失败的构建任务仍显示失败；运行取消后不发布。`scripts/publish-plugins.mjs` 接受四类正式包中的任意子集，按固定顺序上传，结果列出本次输入的 `packages` 和未包含的 `missingPackages`；缺少暂存目录或没有正式包时返回 `status: "skipped"`，不创建 Release 或上传附件。本地扫描忽略三个已知示例包及非插件文件，重复、未知、空文件或超限的插件包仍会报错。

插件发布与桌面发布共用发布锁，并使用 `queue: max` 排队，避免竞争创建 Gitee Release 或替换等待中的发布任务，但不互相依赖。Gitee 仓库需预先有 `updater` 分支，插件流程不创建源码分支或推送源码 tag。插件失败不会阻止桌面安装器和自动更新发布；重跑插件任务可补齐，已有同名插件必须内容一致才会复用，不覆盖冲突文件。插件脚本不写签名归档或更新清单；真实上传或校验失败仍会让发布任务失败。

GitHub 和 Gitee 的每次安装器或插件附件上传，其总时限、响应头超时和响应体超时都显式设置为 15 分钟；普通 API 查询、创建 Release 和下载均为 2 分钟。共享 `ReleaseHttp` 为原生 `fetch` 指定锁定版本的 Undici Agent，覆盖原有独立的 300 秒响应头／正文限制，连接超时保持 10 秒；发布任务通过锁定的 `npm ci` 安装依赖。GET 沿用现有重试策略，上传 POST 不自动重放，以免响应丢失后重复创建附件。响应头／正文超时与总时限分别计算，日志会列出实际配置；耗时包含上传和等待响应，不能用它与附件大小直接推算上传带宽。发布结束或失败后统一关闭连接池，不修改全局 dispatcher。

请求失败时，日志在错误摘要后附带 JSON 诊断信息：`phase` 区分请求、HTTP 状态、JSON 解析或下载正文读取阶段；`method`、`url` 标识请求；附件上传另有 `attachmentName` 和 `attachmentSize`（原文件字节数）。`elapsedMs` 是当前尝试从发起请求到失败的耗时；`timeoutMs`、`headersTimeoutMs`、`bodyTimeoutMs` 和 `connectTimeoutMs` 分别表示总时限、响应头、响应体和连接超时。`attempt` 和 `maxAttempts` 表示当前尝试及上限，收到响应时另有 `status`。`causes` 保留异常链和聚合异常中的类型及原因码，例如 `TimeoutError`、`ECONNRESET`、`ENOTFOUND`、`UND_ERR_CONNECT_TIMEOUT` 或 `UND_ERR_HEADERS_TIMEOUT`。日志长度有限，不输出 URL 凭据及查询参数、请求头、文件内容、原始异常消息或响应正文；CLI 仅打印安全摘要。

两站的安装器均验证成功后，才分别快进提交各自 `updater` 分支上的 `latest.json`，其平台条目继续内嵌签名，客户端更新接口不变。版本归档可以提前写入，但不会推进 `latest.json`。保留分支内其他文件，不强制推送。稳定版更新通用 Windows 键指向 NSIS，以使用 Tauri 自带的 MSI → NSIS 迁移，并兼容旧 NSIS；0.4.0 的 MSI、NSIS 客户端使用各自专用键。macOS 通用键和 app 专用键指向同一 app 压缩包。旧 MSI 迁移可能显示系统卸载确认；发布前需实机验证旧 MSI 与 NSIS 的升级、取消、文件关联和用户数据保留。

默认源只推进稳定版，预发布版可以签名、归档和镜像，但不覆盖稳定清单。PR、push 和普通手动构建不发布更新源。共享发布锁与远端版本比较阻止旧任务回退新版。跨 GitHub/Gitee 无法同时提交：若第二站清单提交失败，第一站保持完整可用的新版、第二站保持原有版本，重试补齐即可。

手动修复时，在 Actions 运行 `Publish Bubblefish updater manifests` 并填写已发布 tag；它优先读取 GitHub 的版本签名归档，再下载并验证已有安装器，不重新签名。无归档的旧 Release 仍兼容读取 `.sig` 附件，已有历史 `.sig` 不删除。只修复 Gitee 时运行 `Repair Bubblefish Gitee mirror`，同样填写 tag；此模式不会补写 GitHub 归档或改动其更新清单。若 GitHub 安装器已完整上传，即使 Gitee 发布中断，也可只凭 GitHub 安装器和签名归档恢复；若 GitHub 安装器尚未上传完整，仍需复用保留期内的 CI 暂存产物，签名归档不能还原安装器字节。重新构建同一版本若产生不同安装器字节会被拒绝，应复用已签名资产或发布新的版本。

上述更新／镜像工作流在桌面步骤成功后，也会读取 GitHub Release 中已有的正式插件并补齐 Gitee，允许部分或零个插件；晚完成的独立插件任务仍自行发布。单独修复插件可在对应 tag 的检出目录执行 `node scripts/publish-plugins.mjs --tag <tag> --mirror-only`，沿用 `GITHUB_REPOSITORY`、`GITHUB_TOKEN`、`GITEE_REPOSITORY` 和 `GITEE_TOKEN`。省略 `--artifacts` 时下载 GitHub 已有的正式插件内容；`--mirror-only` 不上传或修改 GitHub 附件。保有本次 CI 产物时，用 `--artifacts <directory>` 指定暂存目录，将成功包发布至两站，无需重新编译；若同时指定 `--mirror-only`，每个本地包必须与 GitHub 已发布的同名附件字节一致才会上传至 Gitee。

手动发布／修复工作流将工具和应用源码分开：从所选工作流 commit 检出工具并安装依赖，另将发布 tag 解析为固定 SHA 后检出到 `.cache/release-source`。两个发布 CLI 的可选 `--source <目录>` 从该目录读取应用版本、公钥及来源 commit，源码 HEAD 必须与本地和远端 tag 一致，避免主分支升版或移动 tag 导致来源混淆。桌面 Release 在双平台构建前检查两站归档身份，并将同一 SHA 传入构建及发布；发布前仍会复查。普通 push、PR 和手动平台构建保持各自行为。

将修复合并到 `main` 后，在 Actions 的 `Publish Bubblefish updater manifests` 选择 `main` 分支，即可用新版工具处理既有 tag。可选 `artifact_run_id` 指定此前的桌面 Release 运行，工作流先验证仓库、工作流路径、来源 SHA、双平台成功构建和两份未过期 Artifact，再下载安装器和签名，不要求原发布任务成功，也不重新编译。未填写时仍从现有 GitHub Release 读取安装器。旧运行的直接重跑仍执行其原有工作流，不能自动获得新工具。

删除并重新创建 Release 不会清除 `updater/releases/<tag>.json` 的归档。普通发布继续拒绝来源 commit、安装器哈希和签名冲突，不会自动删除归档或覆盖附件。

## 恢复未完成的 v0.4.0

本次恢复保持 GitHub `v0.4.0` 指向 `ea5c14d324c44e8dfae7078f94ba18197c68985b`，复用已经签名的桌面运行 `44687676350`，保留 Release 页面、tags 和内容一致的插件。将修复合并到 `main` 后，从 `main` 手动运行 `Publish Bubblefish updater manifests`，填写：

```text
tag: v0.4.0
artifact_run_id: 44687676350
reset_unpublished: true
expected_archived_commit: 47adeb6ede2cb12469b8c6d5ca06f2be65197cea
```

`reset_unpublished` 默认关闭，只允许手动恢复并要求提供已签名产物的运行号与旧归档 commit。流程在共享发布锁内重新审计两站归档、附件和更新源，验签暂存产物，再将远端快照、当前附件和恢复输入保存成 `release-recovery-<tag>-<run>-<attempt>` Artifact，保留 90 天。备份上传成功后，还会下载并核验已持久保存的备份内容，才允许清理旧归档。

仅当归档属于明确指定的旧 commit、更新源尚未引用冲突版本、远端状态与备份快照一致，才通过条件快进提交移除该版本旧归档；不强推、不删除或重新创建 Release、不改写 tag，也不删除插件或冲突安装器。遇到意外状态或与新产物不一致的已有安装器时停止，需重新审计。当前审计中只有 GitHub 的旧 `v0.4.0` 归档需要移除，Gitee 归档不存在；执行时以再次核验结果为准。

之后仍调用正常严格发布流程，写入当前来源的新归档、补齐两站安装器并推进清单，再从 GitHub 补齐 Gitee 插件。中途失败可用同一批产物续跑；已经正确建立的新归档不再重置。若 Artifact 已过期、tag 被移动、备份未持久保存或更新源已引用旧冲突内容，流程会拒绝清理。

本地回归：`node --test scripts/*.test.mjs`。测试使用临时密钥、本地 Git 仓库、模拟接口和 loopback HTTP 服务，不读取真实 Secret 或写入远端。真实传输用例需要允许监听本机地址；它们以缩短的时限验证响应头、响应体和总超时，不等待实际的 5／15 分钟。
