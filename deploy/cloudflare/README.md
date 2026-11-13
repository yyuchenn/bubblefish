# Bubblefish 网页部署

正式网页使用仓库根目录的 `dist/web/`，由 `npm run build:web` 生成。Node、npm 和 Rust 版本分别以 `.node-version`、`package.json` 的 `packageManager` 和 `rust-toolchain.toml` 为准。安装依赖使用 `npm ci`。构建不需要 Python、Yarn、nightly Rust 或跨源隔离响应头。

本地部署前执行 `npx wrangler login` 登录 Cloudflare，然后在仓库根目录执行：

```sh
bash deploy/cloudflare/deploy.sh          # preview 分支
bash deploy/cloudflare/deploy.sh main     # 正式站点
```

项目名称保持 `bubblefish`。首次使用先执行 `npx wrangler pages project create bubblefish`；Cloudflare Pages 项目的生产分支应设为 `main`。

GitHub Actions 的 `deploy-cloudflare.yml` 先运行完整 `npm run verify`（类型、核心、插件、界面、网页构建和浏览器流程），再部署同一份已验证产物。配置仓库 Secret `CLOUDFLARE_API_TOKEN`，赋予目标账户的 Cloudflare Pages 编辑权限；账户有多个候选时另外配置 Secret 或 Variable `CLOUDFLARE_ACCOUNT_ID`。

- 发布 Release 或手动选择 `production`：部署生产分支 `main`。
- 推送 `main` 或手动选择 `preview`：部署预览分支；`main` 对应 `preview`。
- `preview_*` 和仓库内 PR：部署相应预览分支；分支名的特殊字符替换为短横线。
- Fork PR 和 Dependabot：只验证，不读取部署凭据或部署。

部署不发布 PR 评论。下载 CI 的 `bubblefish-web` artifact 也可交给普通静态站点托管。

`_headers` 仅对 Vite 的哈希资源开启长期缓存，HTML 和 `/sw.js` 不缓存。`/sw.js` 用于退役原版 0.3.0 的 Workbox；新版没有新增 PWA。预览地址为 `https://<branch>.bubblefish.pages.dev`，正式地址为 `https://bubblefish.pages.dev`。

旧版构建和部署资料保存在 `legacy/`。桌面安装包与自动更新发布见 [自动更新说明](../updater/README.md)，继续使用既有签名密钥和更新源。
