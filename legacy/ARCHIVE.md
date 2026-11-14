# Bubblefish 0.3.0 源码归档

本目录保留原版的源码、配置、文档和构建脚本。正式的 Bubblefish 0.4.0
位于仓库根目录，开发与发布请使用根目录 README 中的 npm 命令。

原版的 `core/`、`desktop/`、`frontend/`、`plugins/` 与 `build.py` 保持原有相对结构。
如需研究旧构建，先进入本目录，再参阅原版 [README](README.md)。原版是独立
Cargo workspace；不应把它加入根目录 workspace，也不应混用两代锁文件或 target。
根目录固定的 Rust toolchain 会向下生效，复现历史环境时需显式选择旧版所需工具链。

此处 `.github/workflows/` 仅为历史资料，不会执行。原版自动更新清单生成与
Gitee updater 同步已停止；历史更新分支和密钥配置没有改动。

旧 OCR 已转换模型及原算法仍可供新版的独立模型打包、数值核对使用。
正常应用构建不依赖旧版业务代码，也不重新转换或提交模型。
