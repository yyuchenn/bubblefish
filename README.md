# Bubblefish

<div align="center">
  <img src="frontend/static/logo.png" alt="Bubblefish Logo" width="128" height="128">
</div>

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/yyuchenn/bubblefish) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/yyuchenn/bubblefish) [![License](https://img.shields.io/badge/license-Apache%202-blue.svg)](LICENSE)

**Bubblefish是一个跨平台的漫画汉化辅助工具**

交流&反馈QQ群：1060743685

## 开发

欢迎提交PR！

### 调试

```python
python build.py setup       # 安装相关toolchain和依赖
python build.py web-dev     # 网页端调试
python build.py desktop-dev # 桌面端调试
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
├── desktop/                 # 桌面端应用（Tauri）
│   ├── src/                # Tauri主进程代码
│   └── tauri.conf.json     # Tauri配置
├── frontend/                # 前端界面（SvelteKit）
│   ├── src/
│   │   ├── lib/
│   │   │   ├── components/ # UI组件
│   │   │   ├── services/   # 前端服务
│   │   │   ├── stores/     # 状态管理
│   │   │   ├── wasm/       # WASM模块
│   │   │   └── workers/    # Web Workers
│   │   └── routes/         # 页面路由
│   └── static/             # 静态资源
├── deploy/                  # 部署配置
│   └── cloudflare/         # Cloudflare部署
└── build.py                # 构建脚本
```


## Acknowledgement

本项目的灵感来自于[LabelPlus](https://github.com/LabelPlus/LabelPlus)。

本项目主要在以下项目的成果上实现：

- [Tauri](https://tauri.app/)
- [SvelteKit](https://kit.svelte.dev/)
- [Quill](https://quilljs.com/)
- [TailwindCSS](https://tailwindcss.com/)
