# 架构与维护约定

## 分层和数据流

```text
Svelte 界面 + ProseMirror
          │ 文档命令、编辑提交屏障
          ▼
Workbench + MutationCoordinator + CommandQueue + AssetStore
          │ CoreTransport
          ├──────── Desktop invoke ── Mutex<Engine>
          └──────── Web Worker ───── WASM Engine
                                      │
                          bubblefish-core / bubblefish-formats
```

`crates/core` 只依赖 serde、serde_json 和 ts-rs。核心不知道文件路径、浏览器、Tauri、系统时钟和图片二进制。`crates/formats` 只负责旧协议编解码和导出损失校验。`crates/wasm` 提供 WASM 边界及两端共用的图片探测；`src-tauri` 负责文件选择、权限范围、读写、窗口、系统打开事件、最近文件、原生菜单，以及插件安装存储和原生子进程管理。`crates/plugin-protocol` 定义跨平台插件 DTO，`crates/plugin-sdk` 提供独立于文档核心的 Rust 插件 SDK。

前端的 `runtime` 管理工作区、命令排队、保存、资源关联与快照。`App.svelte` 负责组合子系统、模态流程和全局操作；`WorkspaceHeader`、`ImageSidebar`、`TranslationPanel`、`Canvas` 和 `TranslationEditor` 分别管理菜单、图片、译文、画布及编辑器。组件通过 props/callbacks 协作，保留焦点、选择、缩放、拖动等瞬时状态。界面没有可独立修改的第二套文档历史，也不直接读写磁盘。

网页核心常驻 Dedicated Worker 内，使用普通单线程 WASM。桌面核心常驻原生宿主的互斥锁内。两者都使用同一个 Rust Engine 和 DTO，平台差异集中在 transport 与 platform 端口。

`MutationCoordinator` 按项目串行准备持久化编辑和历史操作。提交前钩子在核心队列与锁之外运行，使用独立 hooks 角色并只读已提交基准；改写后通过带状态 guard 的原子批命令提交。输入先本地显示，实际确认后回放等待期间的新差异，拒绝时保留完整恢复草稿。后置领域事件从命令确认边界产生，含事务、来源、状态和实体差异；ACK 丢失时沿用同一命令 ID 重试，不重复执行钩子或发布事件。

图片暂存句柄绑定实例与项目，上传完成前同步建立资源租约；事务、历史和资源包导出分别固定持有所需版本。替换生成新 assetId，旧资源保留至项目关闭。资源包先原子捕获文档与资源版本，再在队列外生成 ZIP，重命名仅作用于导出副本，不改变保存路径或 savedStateId。历史栈只公开稳定条目身份和元数据，不能直接修改快照。

## 原生窗口与标题栏

主窗口配置 `create: false`，由 Rust 在 setup 中通过 `WebviewWindowBuilder::from_config` 创建。创建前按平台设置样式：Windows 关闭系统装饰；macOS 保留系统交通灯，使用 overlay 和 hidden title；Linux 保留原有系统装饰。窗口样式在创建和显示前确定，不等前端挂载后再切换装饰。

首次渲染前通过原生 `windowInfo` 获取可靠平台和窗口状态，网页返回 null。`WindowChromeState` 包含 platform、maximized、fullscreen、focused、revision；挂载后的观察器先订阅再查询，只接受较新的 revision，迟到的初始查询不能覆盖新事件。卸载时清理监听，订阅尚未返回就卸载时也立即清理其迟到的解绑函数。初始化失败会提供重新加载和关闭入口。

`WorkspaceHeader` 根据 chrome props 渲染 Windows 32px 标题栏及 46px 控件、macOS 28px 标题栏及左侧 70px 原生交通灯占位。macOS 不绘制假交通灯或 HTML 主菜单，颜色跟随系统深浅；网页/Linux 维持 49px 布局。项目标题和独立的 `[*]` 未保存标记保持居中，面板和窗口按钮使用明确的不拖动区域。拖动及双击交给锁定 Tauri 运行时的 drag-region 脚本，不叠加另一套双击处理。

自定义关闭按钮、系统窗口关闭和应用级退出共用关闭屏障，提交输入并等待几何/命令队列后确认未保存内容。Rust 的 `core_started` 区分前端核心已启动与尚未启动，确保初始化失败时仍可关闭应用。macOS 原生菜单由 `NativeMenuState` 同步可用状态：模态打开时禁用相应动作，撤销/重做标题与项目状态联动，面板使用勾选项，最近文件及“更多”动作复用同一应用入口。

## 核心协议和历史

公开 Rust API 为 `Engine::new()`、`dispatch(Envelope) -> Reply` 和 `document(projectId) -> Result<ProjectDocument, CoreError>`。所有 DTO 使用 camelCase；Rust 定义是事实来源，`tools/typegen` 显式生成 `core.ts` 与 `plugins.ts`。测试和类型检查同时检查两份契约，不会重写生成文件。

`ProjectDocument` 包含稳定的项目、图片和标记 ID。图片元数据记录 assetId、文件名、尺寸和可选校验值；`Geometry` 是 0..1 的点或矩形；`RichText` 是文字 run 与四种行内 mark。未知旧富文本保存在 `raw`，未编辑时可原样导出。缺图的宽高可以为零，几何仍按归一化坐标保存。

每个 Envelope 携带 sessionId 和 commandId。相同会话中的相同命令 ID 返回最初的 Reply，因此网络或 IPC 失败后的重试沿用原 Envelope。新命令应使用新 ID。核心失败同样结构化返回；输错参数不会使图片、历史、redo 分支或内容状态部分更新。

每个 Reply 有单调的 eventRevision；重复命令返回原来的 revision。文档内容另有 stateId，撤销重做恢复原内容的 stateId。savedStateId 标识实际保存的内容版本，二者不同即存在未保存修改。markSaved 可以确认此前写出的状态，保存期间的新编辑仍保持未保存。

每个项目独立维护 undo/redo。历史前后快照共享未修改图片的 `Arc<ImageDocument>`；修改一个标记只复制该页的标记集合。历史与幂等回复也共享这些图片节点。图片字节从不进入历史。patch 只返回变化的图片、被删除 ID 和完整的图片顺序/项目元数据。

只有相同非空 groupId 且没有屏障或 redo 分支的相邻修改会合并。UI 决定输入组；核心不使用计时器推断用户意图。图片整批添加、删图、标记拖动和排序各使用一个命令。重排必须包含全部现有 ID、每个恰好一次。所有图像与标记 ID 在项目内唯一，几何必须有限且在图内。

## 输入、选择和异步边界

ProseMirror 不启用自身 history 插件。每次内容事务立即更新本地编辑器并提交翻译命令；核心确认不会重设当前编辑器。切换标记或执行撤销重做时才从文档加载外部内容，避免异步回复覆盖光标。

历史 bookmark 保存 imageId、markerId、anchor、head 和 storedMarks。anchor/head 使用 ProseMirror 文档位置，保持反向选区、emoji 与跨格式内容的选择语义。核心只保存并回传，不把它转换成 DOM 文本偏移。几何、图片和删除操作可携带 `focusEditor: false`，使历史恢复跨页定位而不抢编辑器焦点；文本历史省略该字段并恢复选区及输入样式。

浏览器 DOM 选区的变化可能先于 ProseMirror 的选择事务。`beforeinput`、粘贴及 composition 开始前会将当前 DOM anchor/head 同步到编辑模型，Home/End 使用模型内的选择命令，避免紧接着输入时使用旧光标位置。

相邻同类输入在一秒内合并，移动选区、粘贴、格式修改、失焦或导航结束输入组。一次 composition 使用独立组。保存、切页、切项目、撤销和关闭先等待 composition 结束及编辑器最终事务，再 drain 串行队列并结束历史组。

撤销/重做在原生/WASM 中执行期间，新输入仍即时显示。编辑器按事务保留各自的基准文档、steps 和选择，在历史回复应用后逐事务建立位置映射并重放，不能只用最初一次差异映射整组输入。如果对象被历史操作移除或无法可靠重放，输入保留为可复制的恢复草稿；用户可在对应图片恢复后将草稿恢复为新标记。

CommandQueue 一次仅发送一个请求。成功 Reply 在队列作业内部应用到投影，随后才开始下一个作业。传输失败后请求保留在队首，后续操作等待用户重试；草稿仍在编辑器中。重试继续使用同一 commandId，因此宿主已执行但确认丢失时不会执行两次。业务校验和格式导出失败在作业出队后报告，不阻塞后续合法操作。

导出也占用同一队列，在作业开始时捕获 stateId，与导出的内容对应；实际平台写入在队列外执行，因此保存期间可继续编辑。写入完成只 markSaved 被写出的 stateId。同一项目的保存请求串行执行，避免较早的慢写入覆盖较新的文件。

画布只在拖动中维护局部预览；pointerup 才提交最终几何。Escape、pointercancel 与切换到双指手势取消相应预览，不产生零碎历史。缩放、手势、标记位置共享同一图像坐标变换。

松手时，`commitGeometry` 同步登记仅用于 UI 的 pending geometry，再清除局部手势预览。记录固定项目/图片/标记 ID 和递增 token；渲染优先使用当前手势、最新 pending、核心文档。权威 patch 应用并完成一次 Svelte tick 后才清理对应 token，旧 ACK 无权清除后一次拖动，pending 不写入文档、历史或导出。

几何操作串接到独立的 tail；保存、导航、撤销和关闭捕获进入屏障时的 tail 并等待。tail 内部仅调用编辑器/命令队列的底层 flush，不能调用会等待自身的公开 barrier；历史恢复已占有编辑器 transition 时也要允许内部 flush。确定的业务拒绝回退至权威几何、报告失败且不污染后续 tail；传输结果不确定时保留 pending 与原命令，等待同 ID 重试确认。

点标记为固定 24 × 32px SVG，白色外轮廓的尖端朝下，内层使用当前颜色。根元素 `translate(-50%, -100%)` 使 SVG 的 `(12, 32)` 精确落在归一化坐标对应的图像位置，编号文字保持水平；缩放、平移、选中和悬停只改变视图、颜色或透明度，不改变锚点。

标记强调复用画布和翻译列表共享的 hover ID，悬浮气泡单独跟踪图片标记的鼠标悬浮。气泡在画布视口内按屏幕像素布局，读取 RichText runs 和横排样式，不随图片缩放。编辑器偏好保存在 `bubblefish-next.editor`，默认开启气泡、关闭自动定位。App 仅在列表选择和标记导航完成后定位，并以请求标识与当前选择校验阻止旧异步定位覆盖较新的操作。

翻译排序在组件内维护候选 ID 顺序、等高占位和固定浮动卡片，FLIP 仅影响视觉位置；插入计算扣除动画位移，自动滚动后重新计算。松手只提交一次原有 `reorderMarkers` 命令；等待确认或传输重试期间保留候选顺序，权威 patch 完成渲染后再清除。候选排序、气泡与偏好均不进入项目文档和撤销历史。

图片排序仅在项目配置的图片管理中启用，使用相同的一秒长按、占位、阴影和让位规则。图片 ID 保持 keyed，浮动卡片只引用源行已加载的缩略图，不解码原图或分配新 Blob URL。异步 `onreorder(projectId, imageIds)` 携带捕获的项目和完整候选顺序，App 返回一次 `reorderImages` 命令的 Promise；组件在确认后清除候选，排序预览不改变当前图片选择和文档页码。原生排序 drag/drop 已移除，外部文件拖入继续交给 App 导入。

所有工作区菜单由同一个 `PopupController` 管理，任一时刻只保留一个带 token 和项目/图片 scope 的弹层。触发按钮和弹层共同注册点击边界，菜单之间切换直接替换当前项。外击普通控件先关闭弹层，再允许控件本身的操作；外击画布空白的首个主指针序列及其合成 click 只用于关闭菜单，不能穿透创建标记，同序列第二触点也被消费，下一次独立点击才进行画布操作。

Escape 在适用时把焦点还给触发器；Tab、项目/图片切换、模态操作、宿主移除、失焦、窗口尺寸改变及弹层外的用户 wheel 操作都会关闭当前菜单。程序性的 `scrollIntoView` 不关闭菜单，避免选中标记后翻译项自动滚动误关刚打开的上下文菜单。弹层和被消费的指针状态均为 UI 状态，不进入项目历史。

## 文件、图片和持久化

BF 1.0 保持 gzip/tar + JSON，LabelPlus 保持文本协议；内部稳定 ID 在边界转换为旧协议索引。bunny_cache 数据绑定标记对象，重排/删除/撤销后按当前索引重新导出。未知扩展不参与核心业务模型，导入报告要求另存以保护来源文件。

导入在解析及全部图片匹配完成后才加入工作区；缺图时留在匹配界面，当前原型不支持跳过缺图继续打开。重新关联由 assetId 映射到实际资源，校验值在边界统一去除可选 `md5:` 前缀并归一化大小写。AssetStore 持有浏览器 File/Blob URL 或桌面路径及缩略图；文档和历史只持有元数据。关闭项目或取消导入后释放无项目使用的资源，同时删图撤销所需的资源仍由该项目保留。

画布只显示当前原图。缩略图按可见区域请求，统一解码调度器最多并发两张原图；缩至 160px 后释放临时图片、画布缓冲与临时 Blob URL。永久原图 URL 在项目关闭时统一撤销。DOM 图片数量和 URL 生命周期有浏览器规模测试，解码器及浏览器进程的实际内存另需测量。

桌面文件访问限于系统选择、系统打开或同目录扫描授权的路径。保存先写同目录临时文件、同步并替换目标。网页由用户选择文件、下载导出结果。数据目录与旧版通过独立应用标识隔离。

自动快照在有修改且距上次快照满 30 秒，或历史深度增加 20 项时触发，存储在 `bubblefish-next` IndexedDB 中。快照同时保留完整的内部结构化文档和可导出的 BF 字节，不包含图片；总容量 50 MiB 按两者合计，写入前按时间清理最旧记录。

旧 BF 无法表达的内容也保存在内部文档中，此时记录导出原因、禁用 BF 下载并保留恢复入口。恢复创建新的未保存项目，重新完成图片关联；旧版仅有 BF 字节的快照仍可读取。超过单条上限或持久化失败会报告，失败后延迟重试。

## 扩展与验证

新增能力优先新增核心命令/数据类型，复用同一校验、历史、幂等和 patch。需要外部服务或文件访问时扩展平台端口；组件不直接接入 Tauri。插件通过宿主读取投影、提交公开命令，不能绕过核心直接修改 store。

### 插件宿主与协议

`PluginManager` 统一管理安装记录、启用状态、实例代次、异步调用、provider、命令、面板和任务。插件包是含 `plugin.json` 与资源文件的 ZIP；manifest 声明 API 版本、Web/各 Rust target 的原生入口、OCR/翻译 provider、命令、面板、配置及文档权限。JS 入口打成单个 ESM，WASM 和模型通过资源接口独立读取，避免将大权重编入应用文档核心。旧版动态库 ABI 不属于 Next 插件协议。

用户命令通过独立的 `runUserCommand` 入口产生内存反馈记录，面板的原始 `executeCommand` 返回语义保持不变。所有命令按插件串行，任务 ID、实例身份和停用代次约束进度／摘要与完成回复。取消发送控制消息并停止采纳结果，RPC 继续持有真实响应边界；实际结束前不会释放队列。Rust 原生输入控制线程与 WASM 独立取消句柄使取消绕过普通业务队列，已发出的修改 ACK 继续排空。卡片状态和通知不进入项目文档或持久化配置。

默认只保存启用状态，首次使用插件能力时才创建实例。自动化插件可声明 `activationEvents`，目前接受 `startup`、`event:context.changed`、`event:document.changed` 与 `event:project.closed`，用于没有 provider、命令或面板入口的插件。实例先握手确认 ID/API，再执行 `activate` 和注册声明过的能力；失败、停用与卸载会关闭所属任务、面板和传输，旧实例的迟到消息不能进入新代次。配置变化通过 `config.changed` 通知现有实例。

网页为每个实例建立 Dedicated Worker，使用 transferable `ArrayBuffer` 传送图片和资源，不要求 `SharedArrayBuffer`。TS 插件导出 `activate(context)`；Rust/WASM 插件通过单 ESM 的 `createPlugin(host)` 返回异步 `PluginWrapper`。桌面存在当前 target 的入口时启动独立可执行进程，否则使用 Web 入口；stdout 专用于协议，stderr 收集为插件日志，不在宿主进程内加载插件动态库。

两端使用带请求 ID 与 `apiVersion` 的 request/response/event 消息，JSON 控制数据和二进制附件分开。原生帧为两个 u32 小端长度、JSON 和二进制，分别限制为 8 MiB 与 512 MiB。`crates/plugin-protocol` 统一验证帧长度、请求/响应形状与路径，宿主原地验证大型附件，避免重复复制。SDK 的 host call 允许插件异步注册能力、读配置和资源、提交文档操作及发送进度。

文档接口由宿主校验 `document.read` / `document.write` 声明，并通过 Workbench 的屏障与公开命令执行。HTML 面板在仅允许脚本的 sandbox iframe 中运行，通过 MessageChannel 调用宿主；面板不能注册可执行 provider。模型资源可由包提供，或经资源接口下载并在可用的 CacheStorage 中按插件缓存，可带 SHA-256 校验。包、启用状态和配置使用独立的浏览器 IndexedDB 或桌面应用数据目录；模型缓存、配置和插件程序均不进入 BF、文档历史及项目快照。

插件面板外观由宿主管理。`panel-appearance` 从实际计算后的 CSS 读取配色、字体、字号与明确的 light/dark 模式，生成 Rust DTO 定义的 `PluginPanelAppearance`；网页 `srcdoc` 与桌面 `bf-plugin` HTML 响应注入共享的初始化脚本和基础 CSS，发布稳定的 `--bf-panel-*` 变量。注入不改写安装资源，所以更新宿主即可修复旧面板，无需卸载插件或重新导入模型。iframe 的 `sandbox="allow-scripts"` 与桌面 CSP 保持原隔离边界。

`bubblefish:connect` 携带初始快照和两个端口：`ports[0]` 保持插件 API，`ports[1]` 专用于主题，旧连接代码继续兼容。`PluginPanel` 在当前 revision 确认前隐藏 iframe 并展示同色占位，5 秒无确认时提供重试；连接代次阻止旧确认恢复已关闭的面板。主题变化只经端口原地更新，不重设 `src/srcdoc`，保留表单输入、焦点、滚动和在途模型导入。关闭时清理观察器、端口与计时器；主题不进入项目、配置或历史。变量用法见 [插件面板文档](docs/PLUGINS.md#主题与基础样式)。

同一 OCR 插件的任务串行执行，避免同时创建多份推理资源；任务有 ID、进度与取消信号。取消后宿主立即拒绝该任务结果。Rust SDK 的 native/WASM dispatch 串行交付事件，当前不能在运行中的 Rust handler 内逐步响应取消；停用时等待退出，超时后终止 Worker 或子进程。该行为与支持 AbortSignal 的 TS provider 区分记录，不将丢弃结果描述为已停止模型计算。

### OCR、原文与翻译

生产 Kha White OCR 位于 `plugins/kha-white-ocr`。原生与浏览器共用 Rust 灰度、Triangle 缩放、归一化及文本解码，推理分别接入 native ORT 与 ONNX Runtime Web WASM；模型与运行库不进入应用文档 core。约 440 MiB 的固定 FP32 模型独立打包，通过通用 `resources.local` 分块校验导入：浏览器存于独立 IndexedDB，桌面使用临时版本目录和原子 catalog。资源集绑定插件、临时上传绑定实例／面板连接，失败保留旧版本，关闭连接清理未完成导入，卸载清理本插件资源。

`AssistanceService` 负责选中标记或当前页已有标记的工作流，不承担文本区域检测。图片裁剪在专用 Worker 完成：矩形取相应区域，点取图像宽高各 10%、至少 50px 的局部区域，边界裁剪到图内；PNG 字节作为独立附件发给 provider。机器翻译读取标记原文和项目语言，推理过程在命令队列外执行，允许继续编辑。

运行时固定项目、图片、标记、资源 ID 与输入快照；任务完成后先等待输入/几何屏障，过滤已取消或输入已变更的结果，再用一个 `UpdateAssistance` 命令提交可用结果。核心再次原子比较原图、几何、原文与相关语言前置条件，任一目标无效时整条命令不提交。原文、机器译文及来源写入标记的 `bunnyCache`，保留其他未知字段；字段缺失保持原值，显式 null 清除。一次批量结果对应一个历史操作，失败任务不写入占位文本。

原文输入每次都进入同一个命令队列，相邻输入按组形成撤销记录；保存、导航和关闭无需额外的辅助文本提交路径。机器译文先保存为辅助结果，只有“采用机器译文”通过已有 `UpdateMarker` 写入人工 RichText。两类内容跟随 BF 和快照保存，插件配置、运行状态与模型缓存保持独立。

Rust SDK 的 echo 示例返回图片字节数，并复用同一份 Rust handler 验证 native/WASM 的输入、裁剪、传输、任务及结果写回。实际 OCR 由 Kha White 插件提供，在线翻译由 DeepSeek 插件提供；echo 示例不提供真实推理结论。

### 检查与打包

`npm run test:plugins` 运行 Rust 协议与 SDK 测试；`npm run test:ui` 包含插件管理、RPC、任务与辅助文本工作流测试；`npm run test:host` 检查桌面安装存储和原生宿主。`npm run plugin:pack -- <目录>` 打包单 ESM、面板和资源，原生入口可通过 `--native <target>=<可执行文件>` 加入。Rust 双端示例另用 `node crates/plugin-sdk/examples/build-example.mjs` 编译 WASM、原生 executable 并打包。接口和包格式详见 `docs/PLUGINS.md` 与 SDK README。

修改 DTO 后显式生成并审查 TypeScript 差异。修改格式时保留手写与旧版样例的语义往返测试。`crates/core/tests/fixtures/runtime-trace.json` 是原生/WASM 共用黄金轨迹，普通测试只读；只有明确更新预期行为时通过 `cargo run -p bubblefish-core --example trace_fixture -- crates/core/tests/fixtures/runtime-trace.json` 重新生成。

Playwright 使用独立的 `127.0.0.1:5184`，与交互开发的 5174 隔离；启动器只停止本次自行启动的服务。WASM 缓存区分构建模式，并校验 Rust 源码及 Cargo 输入；测试发现源码比产物新时先重新构建。网页开发监听 Rust 变化，Vite 也保留生成的 WASM 目录监听，重建成功后刷新以替换 Worker，避免沿用旧核心。

本地检查、平台步骤和已验证范围见 `docs/ACCEPTANCE.md`。不得把网页测试结果写成桌面文件关联或真实输入法已通过，也不得把 Windows 构建成功视为 macOS/Linux 已验证。

标题栏夹具单独挂载生产 `WorkspaceHeader` 和 PopupController，只提供可控的只读项目投影与窗口 props。锁定 Tauri 2.12.5 的原版 drag 脚本仅在测试中替换 OS 模板并记录 IPC；这验证浏览器布局、交互区域及回调分派，不等同原生窗口或系统菜单的实机验收。
