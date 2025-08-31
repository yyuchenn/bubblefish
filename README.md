# Bubblefish

<div align="center">
  <img src="frontend/static/logo.png" alt="Bubblefish Logo" width="128" height="128">
</div>

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/yyuchenn/bubblefish) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/yyuchenn/bubblefish) [![License](https://img.shields.io/badge/license-Apache%202-blue.svg)](LICENSE)

**Bubblefish是一个跨平台的漫画汉化辅助工具**

交流&反馈QQ群：1060743685

## 开发

欢迎提交PR！

### 快速开始

```python
python build.py setup       # 安装相关toolchain和依赖
python build.py web-dev     # 网页端调试
python build.py desktop-dev # 桌面端调试
```

### 构建命令

```python
# Web端构建
python build.py web-build           # 构建Web应用
python build.py plugin-build        # 构建WASM插件

# 桌面端构建（两种版本）
python build.py desktop-build       # 标准版（不含插件）
python build.py desktop-build-bundled # 捆绑版（包含插件）

# 组合构建
python build.py build-all           # 构建所有（标准版）
python build.py build-all-bundled   # 构建所有（捆绑版）

# 插件开发
python build.py plugin-build        # 构建WASM插件
python build.py plugin-build-native # 构建原生插件
python build.py plugin-list         # 列出所有插件
```

### 项目结构

```
bubblefish/
├── core/                    # 核心业务逻辑（Rust）
│   ├── src/
│   │   ├── api/            # API接口层
│   │   ├── bindings/       # Tauri/WASM绑定
│   │   ├── common/         # 公共类型和工具
│   │   ├── service/        # 业务服务层
│   │   └── storage/        # 数据存储层
├── desktop/                # 桌面端应用（Tauri）
│   ├── src/                
│   │   ├── lib.rs              # 主应用逻辑
│   │   └── plugin_loader.rs    # 原生插件加载器
│   ├── tauri.conf.json         # 标准版配置
│   └── tauri.bundled.conf.json # 捆绑版配置（含插件）
├── frontend/                   # 前端界面（SvelteKit）
│   ├── src/
│   │   ├── lib/
│   │   │   ├── components/ # UI组件
│   │   │   ├── services/   # 前端服务
│   │   │   ├── stores/     # 状态管理
│   │   │   ├── core/       # 核心接口
│   │   │   └── workers/    # Web Workers
│   │   └── routes/         # 页面路由
│   └── static/             
│       └── plugins/        # Web端插件资源
├── plugins/                # 插件系统
│   ├── plugin-sdk/         # 插件SDK
├── deploy/                 # 部署配置
│   └── cloudflare/         # Cloudflare部署
├── .github/
│   └── workflows/          # GitHub Actions
│       ├── deploy-cloudflare.yml  # Web端自动部署
│       └── build-desktop.yml      # 桌面端自动构建
├── target/                 # Rust构建输出
│   └── build/              # 统一构建目录
│       ├── wasm/           # WASM构建产物
│       ├── frontend/       # 前端构建产物
│       └── desktop/        # 桌面端构建产物
└── build.py                # 统一构建脚本
```


## Acknowledgement

本项目的灵感来自于[LabelPlus](https://github.com/LabelPlus/LabelPlus)。

本项目主要在以下项目的成果上实现：

- [Tauri](https://tauri.app/)
- [SvelteKit](https://kit.svelte.dev/)
- [Quill](https://quilljs.com/)
- [TailwindCSS](https://tailwindcss.com/)
