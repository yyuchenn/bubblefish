# Cloudflare Pages 部署

## 快速开始

### 1. 安装 wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. 创建项目
```bash
wrangler pages project create bubblefish
```

### 3. 部署
```bash
cd deploy/cloudflare
chmod +x deploy.sh
./deploy.sh          # 预览环境
./deploy.sh main     # 生产环境
```

## GitHub Actions 自动部署

在仓库设置中添加 Secret：
- `CLOUDFLARE_API_TOKEN` - [创建 Token](https://dash.cloudflare.com/profile/api-tokens)
  - 使用 "Cloudflare Pages — Edit" 模板
  - 或创建自定义 Token，权限：`Cloudflare Pages:Edit`

推送到 `main` 分支会自动部署。

## 访问地址
- 预览：`https://<branch>.bubblefish.pages.dev`
- 生产：`https://bubblefish.pages.dev`