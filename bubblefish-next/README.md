# Bubblefish Next

漫画汉化标注工具的独立重写原型：Tauri 2、Svelte 5、Tailwind CSS 4，以及原生和 WASM 共用的 Rust 文档核心。旧版用于核对功能、交互及文件协议；本目录不导入旧版业务代码，资源复制在本目录内。

支持新建与打开多个项目、图片添加/删除/排序、点和矩形标记、格式化翻译、撤销重做、BF 保存、LabelPlus 导出与本地自动快照。桌面和网页共用界面与业务命令；图片继续作为外部文件保存，`.bf` 不打包图片。

## 开发与构建

在本目录执行，Node.js 至少为 22.12，Rust 至少为 1.90；`rust-toolchain.toml` 固定本次验证使用的 1.98.1，并采用 minimal 配置及普通单线程 WASM target。首次构建需要联网下载锁定的依赖及 WASM 工具。桌面构建另需所处平台的 Tauri 原生编译环境。

```powershell
npm ci
npm run dev:web
```

网页开发地址为 `http://127.0.0.1:5174`。桌面开发使用 `npm run dev:desktop`。两者共用开发端口，分别启动即可。浏览器回归测试使用独立的 `5184` 端口，避免与交互开发服务共用 WASM 缓存。

| 命令                     | 用途                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `npm run dev:web`        | 构建开发 WASM，启动网页开发服务器                          |
| `npm run dev:desktop`    | 启动 Vite 和 Tauri，直接使用原生核心                       |
| `npm run build:web`      | 构建发布 WASM 与静态网页至 `dist/web/`                     |
| `npm run build:desktop`  | 构建桌面前端至 `dist/desktop/`，再构建 Tauri 安装包        |
| `npm run types:generate` | 从 Rust DTO 显式生成 `src/generated/core.ts`               |
| `npm run types:check`    | 比较 Rust DTO 与已提交类型，不修改文件                     |
| `npm run check`          | Svelte 与 TypeScript 静态检查                              |
| `npm run test:core`      | Rust 核心及文件格式回归测试                                |
| `npm run test:host`      | 原生图片探测与桌面文件宿主测试；需要当前平台的桌面编译依赖 |
| `npm run check:wasm`     | 检查普通 `wasm32-unknown-unknown` 目标                     |
| `npm run test:ui`        | 前端单元测试                                               |
| `npm run test:e2e`       | Playwright 浏览器流程测试                                  |
| `npm run verify`         | 顺序执行类型、静态、核心、前端、网页构建及浏览器检查       |
| `npm run format:check`   | 检查格式，不修改文件                                       |
| `npm run format`         | 显式格式化项目                                             |

Playwright 使用本项目独立的 `.cache/ms-playwright` 浏览器缓存。首次安装 Chromium 时，在 PowerShell 执行：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PWD '.cache/ms-playwright'
npx playwright install chromium
```

在其他 shell 中同样将 `PLAYWRIGHT_BROWSERS_PATH` 指向本目录下的 `.cache/ms-playwright` 后安装。npm 与 Cargo 分别使用本目录的独立锁文件。构建脚本在首个失败处停止；WASM 按源文件内容缓存。网页开发时监听 Rust 源码，重新构建成功后刷新页面；桌面开发直接链接原生核心。

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

2026-10-28 的本地验证已通过：14 个核心测试、17 个格式测试、28 个前端单元测试、6 个宿主/图片探测测试和 28 个 Chromium/WASM 场景。300 页、每页 50 标记的真实 UI 场景也已通过。Windows 原生烟测已确认最小化/最大化/还原、标题栏双击、新建项目、未保存确认与取消保存，以及原生保存后干净退出；真实拖动、安装后的系统文件关联及 macOS/Linux 实机仍需补验。跨平台标题栏夹具截图不代表对应 OS 实机，完整结果见 [验证记录](docs/ACCEPTANCE.md)。

## 文件兼容与扩展

BF 保持 1.0 的 gzip/tar + JSON 协议，保留项目名称、语言、页面和标记顺序、几何、样式及旧富文本语法。LabelPlus 接受 UTF-8 BOM 和常见换行，导出 UTF-8、CRLF 和连续编号。无法无损表达的文本会指出具体标记，不静默丢失格式。未知扩展导入会报告并要求另存。

应用插件、OCR、机器翻译、词库、PWA 和自动更新暂不实现。未来扩展应读取文档投影、提交公开命令并调用平台端口，沿用同一历史和校验机制。结构与不变量见 [ARCHITECTURE.md](ARCHITECTURE.md)，完整手动检查见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

源码与资源许可参见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [资源来源说明](src-tauri/resources/ASSETS.md)。
