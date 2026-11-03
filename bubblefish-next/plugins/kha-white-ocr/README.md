# Kha White OCR for Bubblefish next

真实的本地日文漫画 OCR 插件。网页在插件 Worker 中使用 ONNX Runtime Web 1.22.0 的单线程 WASM，桌面优先使用新 SDK 的 Rust 原生 stdio 进程。两端共用 Rust 图像处理、token 选择和文本解码代码，不需要 Python、OCR 服务或 CDN。

## 构建和安装

从 `bubblefish-next` 目录执行。需要项目要求的 Node.js、Rust、`wasm32-unknown-unknown` target，以及与 Cargo.lock 匹配的 wasm-bindgen CLI。`npm run build:web` 可生成项目已有的 wasm-bindgen CLI 缓存；也可通过 `BUBBLEFISH_WASM_BINDGEN` 指定 CLI。

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run plugin:kha-white:check
npm run plugin:kha-white:build -- --web-only
npm run plugin:kha-white:models
```

生成 `dist/plugins/kha-white-ocr-plugin-web.bfplugin` 和 `dist/models/kha-white-manga-ocr-fp32.bfmodel`。后者约 440 MiB，读取并校验原版已经转换好的 `plugins/kha-white-ocr-plugin/onnx_model/` 四个文件，不重新转换或量化。自定义模型目录：

没有现成模型文件时，先按照[原版转换说明](../../../plugins/kha-white-ocr-plugin/snippet/README.md)准备。构建插件本身不会下载或重转模型。

```sh
npm run plugin:kha-white:models -- --model-dir /path/to/verified/onnx_model
```

1. 在 next 的“插件管理”中安装 `.bfplugin` 并启用。
2. 打开“Kha White OCR 模型管理”，选择 `.bfmodel` 并点击“导入模型”。导入使用 4 MiB 分块、增量 SHA-256 和原子提交；可以取消，失败不会替换原有有效模型。
3. 点击“运行内置样例自检”，正确文字应为 **今日はいい天気ですね。**。
4. 打开图片项目，框选文字区域，在“OCR 插件”中选择“Kha White OCR（日文）”，点击“识别原文”。结果进入标记的原文辅助字段，可撤销、重做和保存。

模型保存在当前应用或站点的插件资源存储中。刷新后可以继续使用，清除模型和卸载插件会删除相应资源；不会写进 BF、项目历史或自动快照。浏览器存储配额不足时导入失败，需要释放空间后重试。离线指模型和运行库不需要联网；应用本身未增加 PWA，仍需能打开应用静态资源。

模型管理面板在网页和桌面跟随软件当前主题，同步文字、背景、字体和基础控件。宿主通过独立主题通道更新样式，不重载 iframe；切换主题时，文件选择、进度和正在进行的模型导入保持连续。初始化超过 5 秒时可点击“重试加载”。此主题修复仅需更新应用，已安装的旧插件也会生效，**无需卸载插件或重新导入模型**；主题不写入模型资源、插件配置、项目或历史。开发约定见 [面板主题变量](../../docs/PLUGINS.md#主题与基础样式)。

本插件尚未发布，版本保持 `0.1.0`，已接入宿主命令任务：在插件管理点击状态、自检或释放会话后，卡片显示运行阶段、结果摘要和可展开的完整返回数据。自检可在加载、编码及逐 token 生成步骤之间协作取消；取消后等待插件确认结束，再允许下一条命令。查询状态会说明模型是否导入、实际后端和会话是否就绪；自检仅在识别出内置准确文字后报告通过。面板内部的状态刷新仍在面板内反馈，不额外产生卡片提示。替换已安装的开发包需先卸载并重装；卸载前保留配置和模型包，重装后重新导入，模型包无需重新转换或生成。

## macOS ARM64 原生包

原生包必须携带 ONNX Runtime 1.22.0 动态库。当前已验证转换环境的 Python wheel 内包含可复用的 macOS 运行库，构建脚本会自动发现；也可显式指定：

```sh
npm run plugin:kha-white:build -- --ort-runtime /path/to/libonnxruntime.1.22.0.dylib
npm run plugin:kha-white:smoke
```

生成 `dist/plugins/kha-white-ocr-plugin-aarch64-apple-darwin.bfplugin`。包内同时保留 Web 后端。原生程序根据自身安装位置定位运行库，不依赖 `ORT_DYLIB_PATH` 或开发目录。第一次识别读取本地模型并创建两份 Session；后续复用，释放会话后再按需加载。

原生 smoke 会解压实际发布包到临时目录，移除 ORT／DYLD 环境变量，在无关工作目录运行真正 stdio 插件。它检查激活不加载模型、缺模型报错、准确文字与 tokens、命令进度和摘要、真实解码阶段取消后同进程重试、会话复用、reset 后重载、直接 OCR、停用和正常退出。可用 `--package`、`--models`、`--report` 指定输入或证据位置。

## Windows x64 构建

在安装 Rust MSVC 工具链与 Visual Studio C++ Build Tools 的 Windows x64 环境中运行，准备官方 **CPU 版 ONNX Runtime 1.22.0** 的 `onnxruntime.dll`：

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugin:kha-white:build -- --target x86_64-pc-windows-msvc --ort-runtime C:\onnxruntime-1.22.0\lib\onnxruntime.dll
```

生成对应 `kha-white-ocr-plugin-x86_64-pc-windows-msvc.bfplugin`。构建不需要模型，因为权重通过独立 `.bfmodel` 导入。Windows 本轮仅提供构建／打包／smoke 脚本，未进行 Windows 实机推理验收；不能以 macOS 或 Web 结果替代。macOS Intel、Linux 原生包不在本轮交付范围，没有匹配 native 入口的桌面仍可使用 Web 后端。

已在当前主机通过 `cargo check --target x86_64-pc-windows-msvc --features native -p bubblefish-kha-white-ocr --bin kha-white-ocr` 交叉检查 Windows 专用源码；它不能替代 Windows 上的链接和推理验收。

## 算法与模型契约

来源为 `kha-white/manga-ocr-base`，固定 revision `aa6573bd10b0d446cbf622e29c3e084914df9741`，Apache-2.0；模型文件校验值记录在 `model-manifest.json`。使用已验证 FP32、opset 14、自包含 ONNX，不加入量化、GPU 或 KV cache。

预处理与旧 Rust 插件一致：图片解码、`to_luma8` 后转 RGB、Triangle 拉伸至 224×224、NCHW FP32、`(pixel * rescale_factor - .5) / .5`，其中 rescale_factor 使用配置中的 FP32 值。Pillow 和 Canvas 的灰度／缩放算法不能替代它。Encoder 产生 `[1,197,768]`；Decoder 接收 int64 token 序列、encoder 输出和全 1 mask，产生 `[1,L,6144]` logits。起始 token 为 2，每步取最后位置最大值，平局取最先索引；遇 3 停止，最多 300 步。

词表跳过五种特殊 token，移除 `##`、Unicode 空白，替换省略号。旧 Rust 对连续 `・`／`.` 使用 UTF-8 字节长度的行为被保留，例如 `・・` 变成六个点，与 Python 参考的字符长度处理有差别。

网页在解码步骤间让出事件循环并检查取消。原生由独立控制线程接收取消，在当前同步 ORT 运算结束后的检查点停止后续步骤；不会强行打断正在执行的 ORT 调用。宿主立即停止采纳取消后的结果，在确认执行结束前显示“正在取消”，并在输入改变后丢弃过期结果。取消不会关闭整个实例，其他任务及再次识别仍可使用；停用强制结束执行器时，该实例的模型内存随之释放。

## 验证

```sh
cargo test -p bubblefish-kha-white-ocr
npm run plugin:kha-white:check
npm run plugin:kha-white:smoke
node plugins/kha-white-ocr/verify-numerics.mjs
npx playwright test tests/local-resources.spec.ts tests/kha-white.spec.ts
```

真实 OCR 浏览器用例需要本地已验证模型或生成后的模型包；缺失时明确跳过，不用 mock 或 echo 冒充成功。测试实际安装 `.bfplugin`、取消和重新导入完整模型、原文写回／保存／撤销、取消／过期结果、刷新后的模型持久化和断网识别。数值检查使用相同 Rust tensor 比较 native ORT 与同版 ORT Web WASM 的 encoder 和多种 decoder 序列长度，证据输出到忽略的 `.cache/`。

模型、运行库、生成 WASM 和构建产物不提交到 Git；模型包携带完整模型来源与 Apache-2.0 许可证，插件包携带 ONNX Runtime MIT 许可证及归属说明。
