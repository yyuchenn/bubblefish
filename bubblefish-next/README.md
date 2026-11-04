# Bubblefish Next

漫画汉化标注工具的独立重写原型：Tauri 2、Svelte 5、Tailwind CSS 4，以及原生和 WASM 共用的 Rust 文档核心。旧版用于核对功能、交互及文件协议；本目录不导入旧版业务代码，资源复制在本目录内。

支持新建与打开多个项目、图片添加/删除/排序、点和矩形标记、格式化翻译、撤销重做、BF 保存、LabelPlus 导出、本地自动快照，以及可安装的 OCR、翻译和自定义面板插件。桌面和网页共用界面与业务命令；图片继续作为外部文件保存，`.bf` 不打包图片。

## 开发与构建

在本目录执行，Node.js 至少为 22.12，Rust 至少为 1.90；`rust-toolchain.toml` 固定本次验证使用的 1.98.1，并采用 minimal 配置及普通单线程 WASM target。首次构建需要联网下载锁定的依赖及 WASM 工具。桌面构建另需所处平台的 Tauri 原生编译环境。

```powershell
npm ci
npm run dev:web
```

网页开发地址为 `http://127.0.0.1:5174`。桌面开发使用 `npm run dev:desktop`。两者共用开发端口，分别启动即可。浏览器回归测试使用独立的 `5184` 端口，避免与交互开发服务共用 WASM 缓存。

| 命令                            | 用途                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `npm run dev:web`               | 构建开发 WASM，启动网页开发服务器                          |
| `npm run dev:desktop`           | 启动 Vite 和 Tauri，直接使用原生核心                       |
| `npm run build:web`             | 构建发布 WASM 与静态网页至 `dist/web/`                     |
| `npm run build:desktop`         | 构建桌面前端至 `dist/desktop/`，再构建 Tauri 安装包        |
| `npm run types:generate`        | 从 Rust DTO 显式生成核心与插件 TypeScript 类型             |
| `npm run types:check`           | 比较 Rust DTO 与已提交类型，不修改文件                     |
| `npm run check`                 | Svelte 与 TypeScript 静态检查                              |
| `npm run test:core`             | Rust 核心及文件格式回归测试                                |
| `npm run test:host`             | 原生图片探测与桌面文件宿主测试；需要当前平台的桌面编译依赖 |
| `npm run test:plugins`          | Rust 插件协议、帧传输与 SDK 回归测试                       |
| `npm run plugin:pack -- <目录>` | 将插件源码、面板与资源打包为 `.bfplugin`                   |
| `npm run check:wasm`            | 检查普通 `wasm32-unknown-unknown` 目标                     |
| `npm run test:ui`               | 前端单元测试                                               |
| `npm run test:e2e`              | Playwright 浏览器流程测试                                  |
| `npm run verify`                | 顺序执行类型、静态、核心、插件、前端、网页构建及浏览器检查 |
| `npm run format:check`          | 检查格式，不修改文件                                       |
| `npm run format`                | 显式格式化项目                                             |

Playwright 使用本项目独立的 `.cache/ms-playwright` 浏览器缓存。首次安装 Chromium 与 WebKit 时，在 PowerShell 执行：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PWD '.cache/ms-playwright'
npx playwright install chromium webkit
```

在其他 shell 中同样将 `PLAYWRIGHT_BROWSERS_PATH` 指向本目录下的 `.cache/ms-playwright` 后安装。Chromium 执行完整浏览器测试；WebKit 执行 `canvas-hover.spec.ts`，覆盖悬浮气泡排版与点标记定位。Safari 与 macOS 桌面版的合成画面抖动仍需实机视觉验收。

npm 与 Cargo 分别使用本目录的独立锁文件。构建脚本在首个失败处停止；WASM 按源文件内容缓存。网页开发时监听 Rust 源码，重新构建成功后刷新页面；桌面开发直接链接原生核心。

网页产物可部署到普通静态站点，使用 ES module 和单线程 WASM，不需要跨源隔离响应头。通过 HTTP(S) 提供 `dist/web/`，不要直接以 `file://` 打开。桌面包需在对应平台构建；macOS/Linux 的实机验收状态见 [验收记录](docs/ACCEPTANCE.md)。本原型没有配置 `.github` CI/CD。

## 使用

新建时输入名称并选择或拖入图片，可预览、自然排序、手动调整顺序和移除图片。打开 BF 或 LabelPlus 后关联原图；桌面会先寻找项目同目录的图片，网页需选择文件。缺图时停留在匹配界面，所有页面关联完成后才加入工作区。图片名称与校验值用于辅助匹配，支持旧版带 `md5:` 前缀的校验值。

画布点击创建点，拖动创建矩形；小范围拖动按点处理。选中后输入翻译，支持加粗、斜体、删除线、着重点，以及复杂背景/覆盖文字和横排属性。标记编号与翻译列表顺序一致。

| 操作                 | Windows/Linux                            | macOS                    |
| -------------------- | ---------------------------------------- | ------------------------ |
| 新建项目             | 桌面 `Ctrl+N`；网页 `Ctrl+Alt+N`         | 桌面 `⌘N`；网页 `⌘⌥N`    |
| 打开 / 保存 / 另存为 | `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S`     | `⌘O` / `⌘S` / `⌘⇧S`      |
| 撤销 / 重做          | `Ctrl+Z` / `Ctrl+Shift+Z`，兼容 `Ctrl+Y` | `⌘Z` / `⌘⇧Z`，兼容 `⌘Y`  |
| 前后图片             | `Ctrl+←/→`                               | `⌘←/→`                   |
| 前后标记             | `Shift+Tab` / `Tab`                      | `⇧Tab` / `Tab`           |
| 平移 / 缩放          | 滚轮或 `Ctrl+拖动` / `Ctrl+滚轮`         | 滚轮或 `⌘拖动` / `⌘滚轮` |
| 横向平移             | `Shift+滚轮`                             | `⇧滚轮`                  |

选中标记时，Tab 导航按页跨越，到项目边界停止。输入法组合输入、普通表单和模态框有独立快捷键上下文。触屏支持双指缩放与平移；Escape 取消当前画布预览。

图片标记平时半透明，悬浮标记、对应翻译项或选中时恢复不透明。鼠标悬浮图片标记可预览译文，默认纵排，勾选“横排”后横向显示；长译文会显示省略提示。翻译列表长按一秒进入排序，浮动卡片随鼠标移动，其他条目实时让位，松手后确认；Escape 或在列表外松手取消。

“项目配置 → 图片管理”同样长按图片一秒进入排序，显示带阴影的缩略卡片和实时让位预览，并支持边缘自动滚动。拖拽不会切换当前图片，页码在排序确认后更新；普通图片面板仍用于点击切页。

“设置与外观 → 编辑器体验”提供悬浮气泡预览和自动定位开关，分别默认开启与关闭，修改后立即生效并在本机保留。自动定位开启时，Tab／Shift+Tab 或翻译列表切换标记会居中定位；在图片上点选标记保持当前视图。“定位标记”按钮始终可用。

Windows 桌面使用 32px 标题栏和 46px 宽的窗口控件；macOS 使用 28px 内容标题栏，左侧为系统交通灯留出 70px，采用系统深浅色，操作菜单保留在系统菜单栏。网页和 Linux 保持 49px 布局。桌面项目名称居中，未保存时显示 `[*]`，右侧提供面板开关；窗口关闭仍经过输入提交和未保存确认。

桌面保存回原路径；另存为会选择新路径。网页保存通过浏览器下载。导出 LabelPlus 不代表 BF 已保存；矩形会降级为上边中点。

自动快照保存完整的内部标注文档，恢复为新项目后需要重新关联原图。即使某些文字无法由旧 BF 格式表达，快照仍可恢复；这种快照会禁用 BF 下载并显示原因。快照使用当前应用/站点的 IndexedDB，总容量默认 50 MiB，不包含图片。

## 插件、OCR 与机器翻译

真实的 Kha White OCR 已迁移到 next，支持网页单线程 WASM 和 macOS ARM64 原生推理，另提供 Windows x64 构建流程。安装 `dist/plugins/` 中的 Kha 插件包，再从插件面板导入独立 `.bfmodel` 模型包即可本地识别日文。构建、安装、自检和验证范围见 [Kha White OCR](plugins/kha-white-ocr/README.md)。

[DeepSeek 翻译](plugins/deepseek-translation/README.md) 提供网页／桌面共用的在线翻译插件，支持 API Key、自定义系统与用户提示词，以及 HTTPS OpenAI 兼容地址。执行 `npm run plugin:deepseek:build` 生成安装包，在插件设置面板配置后即可通过现有“机器翻译”工作流使用。

点击侧栏的“插件管理”，或从工作区菜单打开同名入口，选择本地 `.bfplugin` 或 `.zip` 包安装。安装后点击“启用”；普通插件在首次调用其 OCR、翻译、命令或面板时启动。管理界面可编辑插件声明的配置、运行命令、打开面板、查看日志、停用或卸载插件。启用状态与配置会在本机保留；自动化插件还可通过 `activationEvents` 声明启动或公开事件触发。Next 使用新的插件协议，旧版原生动态库需要按新 SDK 迁移。

插件面板在网页和桌面跟随软件的海洋、果实和夜间主题，同步文字、背景、字体及基础控件。宿主更新后，已安装的旧面板也会生效，无需卸载插件或重新导入模型。切换主题不会重载面板，未保存输入和正在导入的模型保持连续；主题初始化超过 5 秒时可点击“重试加载”。主题仅属于界面状态，不写入项目、插件配置或历史。开发用法见 [面板主题变量](docs/PLUGINS.md#主题与基础样式)。

右侧翻译面板的“OCR 与机器翻译”区域提供插件选择。选中标记后选择 OCR 插件并点击“识别原文”；矩形使用对应图像区域，点使用附近的局部区域。勾选“整页标记”会逐项处理当前页已有标记，不会自动检测或创建新标记。

可以直接修改“原文”，每次输入都会进入现有命令队列，保存、切换和撤销沿用同一套提交与历史机制。选择翻译插件并点击“机器翻译”后，结果先保存在“机器译文”；点击“采用机器译文”才替换当前人工译文，这一步可以撤销。批量任务显示进度并支持取消；任务期间变更原图、标记区域、原文或相关语言时，过期结果不会覆盖新输入。

原文、机器译文及来源标识跟随标记保存到 BF，并进入撤销历史和项目快照。插件程序、启用状态、配置和模型缓存保存在应用或站点本地，不写入 BF；复制项目不会同时复制这些内容。网页版在独立 Worker 中运行 JS 或 Rust/WASM 插件；桌面优先运行包内匹配当前平台的原生可执行程序，没有对应原生入口时可使用 Web 入口。二进制图片通过独立附件传输，推理后端由插件选择。

同一插件可以组合 provider、文档 CRUD、历史控制和事件订阅。SDK 支持完整图片与裁剪读取、暂存上传、图片和标记增删改排、富文本译文和辅助字段，以及一次撤销的原子事务。`history.push/pop/list/undo/redo` 提供带冲突校验的历史控制；独立 hooks 实例可在提交前改写或拒绝编辑，故障时暂停检查并提供恢复入口。文件菜单的“导出项目资源包”将同一提交点的 BF 和当前原图打成 ZIP。

三个可安装的完整示例位于 `examples/plugins/document-toolbox`、`history-inspector` 和 `edit-guard`。打包命令与逐步验收见 [示例说明](examples/plugins/README.md)。

```sh
npm run plugin:pack -- examples/plugins/document-toolbox
npm run plugin:pack -- examples/plugins/history-inspector
npm run plugin:pack -- examples/plugins/edit-guard
```

产物位于 `dist/plugins/`。Rust SDK 的双端示例通过 `node crates/plugin-sdk/examples/build-example.mjs` 构建，输出 `.cache/plugin-sdk-example/example.echo.bfplugin`；其中 OCR 仅返回收到的图片字节数。包格式、开发接口及更多用法见 [插件文档](docs/PLUGINS.md)、[示例说明](examples/plugins/README.md) 和 [Rust SDK](crates/plugin-sdk/README.md)。

Rust SDK 的 echo 示例已在当前开发主机完成原生 stdio 和真实 WASM 的握手、注册、图片二进制、进度及翻译烟测。这些检查不代表真实 ONNX 模型的兼容性、速度或所有操作系统的桌面 UI 已通过验收。

2026-10-28 的本地验证已通过：14 个核心测试、17 个格式测试、28 个前端单元测试、6 个宿主/图片探测测试和 28 个 Chromium/WASM 场景。300 页、每页 50 标记的真实 UI 场景也已通过。Windows 原生烟测已确认最小化/最大化/还原、标题栏双击、新建项目、未保存确认与取消保存，以及原生保存后干净退出；真实拖动、安装后的系统文件关联及 macOS/Linux 实机仍需补验。跨平台标题栏夹具截图不代表对应 OS 实机，完整结果见 [验证记录](docs/ACCEPTANCE.md)。

## 文件兼容与扩展

BF 保持 1.0 的 gzip/tar + JSON 协议，保留项目名称、语言、页面和标记顺序、几何、样式及旧富文本语法。LabelPlus 接受 UTF-8 BOM 和常见换行，导出 UTF-8、CRLF 和连续编号。无法无损表达的文本会指出具体标记，不静默丢失格式。未知扩展导入会报告并要求另存。

插件通过文档投影、公开命令和宿主能力扩展应用，沿用同一历史和校验机制；词库、PWA 和自动更新暂未实现。结构与不变量见 [ARCHITECTURE.md](ARCHITECTURE.md)，完整手动检查见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

源码与资源许可参见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [资源来源说明](src-tauri/resources/ASSETS.md)。
