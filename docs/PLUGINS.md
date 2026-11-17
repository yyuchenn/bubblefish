# 插件开发

Bubblefish 使用独立版本化异步协议。Rust DTO 是协议的事实来源，`npm run types:generate` 生成 `src/generated/plugins.ts`；`types:check` 只比较，不重写。应用文档 core 不依赖插件运行时。

## 插件包

生产 OCR 插件见 [Kha White OCR](../plugins/kha-white-ocr/README.md)：复用已验证的真实 ONNX 权重，提供独立模型包、网页 WASM 和原生 stdio 实现。

在线翻译插件见 [DeepSeek 翻译](../plugins/deepseek-translation/README.md)：同一个 TS Worker 入口在网页和桌面直接请求 HTTPS Chat Completions，演示按请求读取配置、双提示词模板、独立设置面板以及网络取消，不需要原生入口或文档权限。

`.bfplugin` 是 ZIP，根目录必须有 `plugin.json`。也接受 `.zip`。包内路径为 `/` 分隔的相对路径，不接受绝对路径、`..` 和反斜杠。压缩包及展开资源总量各不超过 256 MiB；大模型通过资源接口另行下载缓存。

```json
{
  "id": "example.custom",
  "name": "Example",
  "version": "0.1.0",
  "apiVersion": 1,
  "entrypoints": { "web": "web.js" },
  "permissions": ["document.read"],
  "contributes": {
    "translation": [{ "id": "translator", "name": "Example translator" }],
    "panels": [{ "id": "settings", "title": "插件设置", "entry": "panel.html" }],
    "configuration": [{ "key": "prefix", "label": "前缀", "type": "string", "default": "译文：" }]
  }
}
```

`entrypoints.native` 可按 Rust target 映射原生可执行文件路径，例如 `aarch64-apple-darwin`。匹配当前桌面 target 时使用 native，否则使用 web；只有 native 入口的插件在网页不可用。不在原生启动失败后自动切换后端重复任务。

插件没有“翻译类”或“嵌字类”的互斥分类。同一个包可以贡献 OCR、翻译、命令、面板、事件处理和提交前钩子。宿主显示已启用插件的声明式贡献，首次执行 provider、命令或打开面板时激活主实例；启用带有提交前钩子的插件时，会预热独立的拦截实例。

声明 `contributes.panels` 即可在插件管理中获得打开按钮，无需同时声明或注册一个仅调用 `ctx.panels.open()` 的命令。命令用于自检、状态查询等独立操作；确实需要从菜单或程序打开面板时，仍可按需使用 `panels.open`。仅提供面板的插件也须保留执行入口和最小 `export function activate() {}`，宿主会先激活实例，再连接面板 SDK。

### 底部多 Tab 页面

面板可用可选的 `location` 声明展示位置：`"modal"` 为弹窗，`"bottom"` 为画布下方的底部 Tab。省略时继续打开弹窗，已有插件无需修改，协议仍为 v1。同一个插件可以同时提供多个底部页面和弹窗：

```json
{
  "panels": [
    { "id": "notes", "title": "项目笔记", "entry": "notes.html", "location": "bottom" },
    { "id": "events", "title": "事件记录", "entry": "events.html", "location": "bottom" },
    { "id": "settings", "title": "插件设置", "entry": "settings.html" }
  ]
}
```

将上面的 `panels` 放入 `contributes`。启用后底部 Tab 自动出现，首次选中才激活插件并加载页面；单个 Tab 没有关闭按钮，停用或卸载后移除。页面 ID 归属插件，不同插件可以使用相同的标题和页面 ID。

继续调用 `await ctx.panels.open('notes')` 即可展开底栏并选中页面；即使当前选中的页面相同、底栏已收起，也会再次展开。插件可以在 `activate()` 中请求打开自己的底部页面。底部打开请求完成代表宿主已接受定位，不代表 iframe 已完成加载；页面应等待现有的 `bubblefish:connect` 握手再使用面板 SDK。

切换 Tab 或收起底栏保留已加载页面、未保存输入和运行中的操作。页面仍可接收已订阅的事件及主题更新；任务结束不会自动切换当前 Tab。插件运行失败时显示错误和“重试加载”，不会自动反复启动；停用或卸载会销毁对应页面和连接。

底栏内置“OCR 与机器翻译”Tab，原文、机器译文及任务状态与当前项目和标记同步。底栏首次默认展开，开关、高度和选中页面保存在应用本地布局中，不写入项目或插件配置。两个底部页面加一个旧式弹窗的可安装测试源码位于 `tests/fixtures/bottom-panels`。

当前安装器不覆盖同 ID 的已安装插件。更新安装包需要先卸载再安装；卸载会删除插件配置、下载缓存和已导入的本地资源集。重装前记下需要恢复的配置并保留模型包，重装后重新配置／导入。构建新包不会修改已经安装的副本。

面板主题同步由宿主提供。仅为修复面板外观时更新应用即可，已安装的旧插件也会生效，无需卸载、修改插件文件或重新导入模型。

自动化插件可声明 `activationEvents`：`startup` 或 `event:` 加下文的公开事件名，例如 `event:transaction.committed`。失败实例不会因每个事件无限重启，可再次启用或显式调用以重试。触发冷激活的那一次事件最多交付一次。

JS 入口需要单个独立 ESM bundle。WASM、词表和其他资源通过 SDK 获取，不能假设安装目录是网站路径或运行时能够解析 npm 包。UI 是独立 HTML，脚本和样式需要随面板打包，不共享宿主 Svelte。

## TypeScript SDK

入口导出 `activate(context)` 和可选 `deactivate()`。SDK 类型位于 `src/plugin-sdk`，构建插件时把运行时依赖打进 bundle；只有类型导入会在编译时消除。

```ts
import type { PluginContext } from '../../../src/plugin-sdk';

export async function activate(ctx: PluginContext) {
  ctx.subscriptions.add(
    ctx.translation.register(
      { id: 'translator', name: 'Example translator' },
      async (input, task) => {
        task.signal.throwIfAborted();
        task.progress({ completed: 1, total: 1 });
        return { text: '处理结果' };
      },
    ),
  );
}
```

每个注册必须在 manifest 中声明。注册、订阅和资源 URL 自动归属当前实例，失败、停用或卸载时清理。API：

| 接口                                             | 用途                                               |
| ------------------------------------------------ | -------------------------------------------------- |
| `ocr.register(info, handler)`                    | handler 接收输入、独立图片 ArrayBuffer、任务上下文 |
| `translation.register(info, handler)`            | handler 接收原文／语言输入和任务上下文             |
| `commands.register(infoOrId, handler)`           | 声明式命令调用                                     |
| `panels.open(panelId)`                           | 打开本插件已声明面板                               |
| `config.get()` / `update(patch)`                 | 按 schema 读取、合并并持久配置                     |
| `resources.read(path)` / `url(path, mimeType?)`  | 读取本插件包内资源                                 |
| `resources.fetch(url, sha256?)`                  | 下载、可选校验 SHA-256，并缓存模型                 |
| `events.subscribe(event, callback, options?)`    | 订阅事件，按项目和自身来源过滤                     |
| `document.read(query?)` / `apply(command)`       | 受控文档读写，需要对应权限                         |
| `document.transaction(transaction)`              | 原子提交一组文档操作                               |
| `document.images.*` / `markers.*`                | 图片、标记查询与 CRUD                              |
| `document.translations.*` / `assistance.*`       | 人工译文与辅助字段                                 |
| `history.list/push/pop/undo/redo`                | 分页查询和控制真实项目历史                         |
| `hooks.beforeCommit.register(infoOrId, handler)` | 注册 manifest 中声明的提交前钩子                   |
| `log(message, level?)`                           | 宿主插件日志                                       |

OCR 输入包含 `mimeType: 'image/png'`、`width`、`height`、`sourceLanguage`、`options`；图片独立于 JSON 传输。矩形按归一化几何裁剪，点标记沿用旧版以该点为中心的图片宽高 10% 区域，最小各 50px，并裁至图片边界。

翻译输入包含 `text`、`sourceLanguage`、`targetLanguage`、`options`。provider 返回 `{ text: string }`，宿主也兼容纯字符串。OCR 按插件实例串行，翻译按 provider 串行。使用任务上下文的 `signal` 协作取消，宿主取消后不再采纳回复。

### 命令反馈、进度与取消

管理页和“更多”菜单发起的命令在对应插件卡片中展示执行状态。每个插件保留最近一次用户命令记录；关闭管理页后仍可查看，退出应用或卸载后清除，不写入 BF、快照、配置或插件日志。菜单调用提供“查看结果”入口，定位对应卡片。面板 SDK 的 `commands.execute()` 保持原始返回值，由面板自行展示，不生成宿主通知。

命令处理器支持第二个 `CommandContext` 参数，旧的单参数处理器继续兼容：

```ts
ctx.commands.register('check', async (params, task) => {
  task.signal.throwIfAborted();
  task.progress({ message: '正在检查', completed: 0, total: 1 });
  const result = await check(params);
  task.signal.throwIfAborted();
  task.summary('检查完成');
  return result;
});
```

`progress` 接收 JSON；`message` 是阶段说明，有限且满足 `0 <= completed <= total`、`total > 0` 的完成量显示实际进度，其余显示不确定进度。`summary` 提供纯文本成功摘要，仅在正常完成后显示；返回值仍原样提供给调用方，并可在“数据详情”展开，包括 `null`、`false`、`0`。返回 `{passed:false}` 不会自动变成“自检通过”；业务失败应抛出明确错误。

协议仍为 v1，`commands.execute` 使用 `{commandId,params,taskId?}`，进度为 `task.progress {taskId,progress}`，摘要为 `task.summary {taskId,message}`，取消为 `$cancel {requestId}`。新 SDK 声明 `commands.tasks` feature。DTO 由 Rust 定义并生成 TypeScript。命令按插件串行执行，不同插件可并行；同插件的用户命令连点不会重复执行。内部面板调用也进入同一命令队列，但不产生用户命令记录。

点击取消立即停止采纳本次结果，状态保持“正在取消”，直到收到实际响应或连接结束才释放执行占位。插件应在异步等待和计算步骤之间检查取消；取消不自动终止整个实例。旧插件或不合作操作会等待自然结束，用户可显式停用插件。取消不会回滚已提交的文档修改、释放会话或外部请求；已经发出的修改调用须完成 ACK 确认。

Rust SDK 保留 `Plugin::handle`，提供 `context.request_id()`、`task_id()`、`check_cancelled()`、`report_progress(value)` 和 `summary(message)`；旧的 `progress(task_id,value)` 继续可用。原生 `serve_stdio` 使用独立输入／取消线程与串行业务执行器；WASM 的独立 `cancellation_handle()` 允许宿主在普通请求队列之外登记和取消任务。同步 ORT／WASM 计算只能在返回后的检查点响应取消。新 SDK 示例实际验证了双端进度、摘要、排队取消、执行中取消和再次执行。

`resources.fetch` 接受 HTTPS，开发时允许 localhost／127.0.0.1 的 HTTP。模型使用独立 Cache API 缓存，不占项目快照额度；卸载插件会清理该插件的模型缓存。可在浏览器站点数据中清除。`secret` 配置是密码输入字段，存于插件配置存储，不写入 BF；它不代表操作系统密钥链加密存储。

## 文档与工作流

插件不能访问 Workbench、Svelte store、内部 Engine 或任意 Tauri 调用。公开协议类型位于 `crates/plugin-protocol`，不直接依赖 core 类型；TypeScript 中可从 `src/generated/plugins` 导入 `PluginOperation`、`PluginRichText`、`PluginMutationProposal` 等 DTO。

`document.read({projectId})` 选择已打开项目，省略则读取当前项目。兼容投影返回 `projectId`、`name`、语言、`selection`、`stateId`、`historyRevision` 和图片／标记；其中旧版标记 `translation` 仍是纯文本。需要完整样式、RichText 或未知缓存字段时使用下面的实体接口。

| 接口                                              | 输入与返回                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `images.list({projectId})`                        | 当前图片列表，含标记、宿主探测的尺寸及校验值                         |
| `images.get({projectId,imageId})`                 | 完整 `PluginImage`，缺失返回 `null`                                  |
| `images.read({projectId,imageId,region?})`        | `{metadata,binary}`；完整图为原始编码字节，裁剪图为 PNG              |
| `images.stage({projectId,filename?}, bytes)`      | 上传独立 `ArrayBuffer`，返回 `PluginStagedImage` 及 `stagedResource` |
| `images.create/update/remove/reorder(input)`      | 新增、改名／替换像素、删除及全量排序                                 |
| `markers.list/get({projectId,imageId,markerId?})` | 完整标记列表／单个 `PluginMarker`，单个缺失返回 `null`               |
| `markers.create/update/remove/reorder(input)`     | 标记 CRUD、几何、样式、RichText 及全量排序                           |
| `translations.get({projectId,imageId,markerId})`  | 完整 `PluginRichText`                                                |
| `translations.set({...target,value})`             | `value` 为纯字符串或完整 RichText                                    |
| `translations.clear(target)`                      | 清空人工译文                                                         |
| `assistance.get(target)`                          | 完整辅助缓存，保留未知旧字段                                         |
| `assistance.update({...target,patch,expected?})`  | 合并已知辅助字段，可附相关输入前置条件                               |
| `assistance.clear(target)`                        | 清除四个已知辅助字段，保留未知字段                                   |

以上实体接口都位于 `ctx.document`。`region` 使用 `{x,y,width,height}`，每项是归一化数值且矩形必须位于图片内。标记支持 `point` 与 `rectangle`；样式为 `{overlayText,horizontal}`。RichText 为 `{runs:[{text,marks}],raw?}`，marks 支持 `bold`、`italic`、`strike`、`emphasis`。修改 runs 后应去掉旧的 `raw`，让导出根据新内容编码。

单项修改的 input 包含 `projectId`、实体目标和可选 `label`／`expectedStateId`，内部同样提交事务。`images.create` 与 `markers.create` 可以省略 ID，并返回 `{id,result}`；批事务先用 `document.createId()` 分配 ID，后续操作即可引用同一事务刚创建的实体。

```ts
const current = (await ctx.document.read()) as { projectId: string; stateId: string };
const [image] = await ctx.document.images.list({ projectId: current.projectId });
const markerId = ctx.document.createId();
await ctx.document.transaction({
  projectId: current.projectId,
  label: '插件批量标注',
  expectedStateId: current.stateId,
  operations: [
    {
      type: 'marker.create',
      imageId: image.id,
      marker: {
        id: markerId,
        geometry: { type: 'point', x: 0.3, y: 0.4 },
        translation: { runs: [] },
        style: { overlayText: false, horizontal: false },
      },
    },
    { type: 'translation.set', imageId: image.id, markerId, value: '人工译文' },
    { type: 'assistance.update', imageId: image.id, markerId, patch: { originalText: '原文' } },
  ],
});
```

`PluginOperation` 的类型是 `project.update`、`image.create/update/remove/reorder`、`marker.create/update/remove/reorder`、`translation.set/clear`、`assistance.update/clear`。项目更新支持名称、源语言和目标语言。排序必须包含目标集合的全部 ID 且不重复。事务只针对一个已打开项目；任一操作失败整体回滚，无净变化不创建历史记录。成功的事务只创建一个 undo 条目并清空 redo 分支。

`expectedStateId` 是可选的乐观并发检查。宿主在捕获提案、执行钩子和最终核心提交时保持基准，最终状态冲突会拒绝；不会把旧操作静默覆盖到另一个版本。传输 ACK 不确定时沿用同一命令 ID 重试，不会重复执行钩子、写入历史或发布事件。

`assistance.update.patch` 支持 `originalText`、`machineTranslation`、`lastOcrModel`、`lastTranslationService`：缺失保持原值，`null` 清除，保留未知字段。可选 `expected` 支持 `assetId`、`geometry`、原文／机器译文和源／目标语言，仅检查计算实际依赖的输入。

旧版 `read/apply` 与已有示例仍兼容；下列调用同样进入统一事务及拦截管线：

```ts
await ctx.document.apply({
  type: 'setTranslation',
  projectId,
  imageId,
  markerId,
  text: '人工译文',
});
await ctx.document.apply({
  type: 'updateAssistance',
  projectId,
  updates: [{ imageId, markerId, originalText: '原文', machineTranslation: '机器译文' }],
});
```

应用工作流运行 OCR／翻译时捕获目标与相关输入。目标删除、项目关闭、裁剪或原文／语言变化后，旧结果被丢弃，核心提交时再次验证前置条件。批量结果一次原子写入，失败项单独报告；用户可以一次撤销。结果等待钩子检查时仍可取消；首次向核心发送提交后不再显示取消操作，丢失的 ACK 会以同一命令 ID 重试确认。

## 权限与调用身份

### 本地大资源集

`resources.local` 是独立于插件包的持久资源存储，适合离线模型。宿主提供通用文件能力，不解析 ONNX。新能力通过 `resources.local` feature 声明，协议仍为 v1，TS、面板和 Rust SDK 使用同一套 DTO。

```ts
const { token } = await ctx.resources.local.beginImport({
  id: 'my-model-v1',
  files: [{ path: 'model.onnx', byteLength, sha256 }],
});
try {
  await ctx.resources.local.writeChunk({ token, path: 'model.onnx', offset: 0 }, firstChunk);
  // 按顺序追加余下分块；单块最大 4 MiB，发送后 ArrayBuffer 可能已被 transfer。
  const model = await ctx.resources.local.commitImport({ token });
} catch (error) {
  await ctx.resources.local.abortImport({ token }).catch(() => {});
  throw error;
}
const sets = await ctx.resources.local.list();
const bytes = await ctx.resources.local.read({ id: 'my-model-v1', path: 'model.onnx' });
await ctx.resources.local.remove({ id: 'my-model-v1' });
```

读取需要 `resources.local.read`，导入、取消和删除需要 `resources.local.write`。hooks 角色不能访问这些接口。身份来自连接，上传令牌还绑定具体实例／面板连接；关闭面板清理其未完成上传，不停止主 provider。已提交数据跨插件启停保存，卸载清理本插件全部资源。

每个资源集最多 100 个文件、总计 512 MiB。文件使用可移植的相对路径，拒绝目录穿越、Windows 保留名称、大小写重名和文件／目录冲突。宿主检查长度、连续 offset 和完整文件的增量 SHA-256；仅全部验证成功后原子切换 ready 目录。失败或配额不足清理临时数据，旧资源集继续可用。浏览器使用 IndexedDB Blob 分块，桌面使用独立应用数据目录。资源字节始终独立传输，不公开磁盘路径，也不进入 BF 或文档历史。

| manifest 权限           | 宿主能力                                             |
| ----------------------- | ---------------------------------------------------- |
| `document.read`         | 项目投影、图片元数据、完整标记、译文和辅助字段查询   |
| `document.write`        | 普通文档事务；也是 `history.push` 的权限             |
| `images.read`           | 读取原图／裁剪图二进制，同时需要 `document.read`     |
| `images.write`          | 暂存图片；提交任意 `image.*` 还需要 `document.write` |
| `history.read`          | 分页读取两栈元数据                                   |
| `history.control`       | pop、undo、redo                                      |
| `document.intercept`    | 注册已声明的提交前钩子                               |
| `resources.local.read`  | 查询和读取本插件已导入的本地资源集                   |
| `resources.local.write` | 分块导入、取消和删除本插件本地资源集                 |

身份由宿主连接绑定到插件 ID、执行角色和实例 generation；请求参数不能伪造其他插件。钩子改写必须通过改写插件自己的权限和数据校验，例如替换图片操作还需要 `document.write` 与 `images.write`。

订阅文档变更事件需要 `document.read`；`history.changed` 同时需要 `history.read`。钩子只校验新增、改动、删除或相对排序变化的操作所需权限，混合事务中保持不变的图片操作不会要求文本钩子额外声明 `images.write`。完整改写数组仍接受核心预检。

## 历史接口

`history.list({projectId,offset?,limit?})` 返回 `{undo,redo,undoTotal,redoTotal,historyRevision}`。两栈分别按栈顶优先分页，默认 offset 为 0、limit 为 100，最大每栈 1000 条。记录只包含 `entryId`、`label`、`origin`、`beforeStateId`、`afterStateId`，不暴露内部快照。

```ts
const page = await ctx.history.list({ projectId, limit: 20 });
const top = page.undo[0];
if (top) {
  await ctx.history.pop({
    projectId,
    stack: 'undo',
    expectedEntryId: top.entryId,
    expectedHistoryRevision: page.historyRevision,
  });
}
```

`push(transaction)` 是 `document.transaction` 的别名；“压入”代表提交文档事务。`pop({stack:'undo'})` 执行撤销，`pop({stack:'redo'})` 执行重做，并将同一个条目移到另一栈；`undo(options)` 和 `redo(options)` 是快捷接口。栈顶和版本 guards 都是可选的，提供后发生冲突会拒绝操作，调用方应重新查询。

连续输入合并保留同一个 `entryId`，递增 `historyRevision` 并更新 `afterStateId`。undo／redo 也保留条目身份；分支修改清空 redo。没有任意插入 redo、删除中间记录、压入自定义快照或执行插件撤销回调的接口。异步保存仍以捕获的 `stateId` 记录保存完成，不会将后续编辑误标为已保存。

## 提交前钩子与双角色

manifest 需要声明权限和钩子元数据：

```json
{
  "permissions": ["document.read", "document.write", "document.intercept"],
  "contributes": {
    "beforeCommitHooks": [
      { "id": "normalize", "priority": -10, "operations": ["translation.set", "marker.update"] }
    ]
  }
}
```

同一插件配置与贡献共用一个 ID，业务 `main` 与拦截 `hooks` 使用独立 Worker／原生进程、RPC 和 generation。每个角色各自选择一个平台入口；停用、卸载和实例崩溃按角色清理，暂停拦截不停止主实例的 OCR／翻译任务。

```ts
export function activate(ctx: PluginContext) {
  if (ctx.runtimeRole === 'hooks') {
    ctx.hooks.beforeCommit.register('normalize', (proposal, task) => {
      task.signal.throwIfAborted();
      const operations = proposal.operations.map((operation) =>
        operation.type === 'translation.set' && typeof operation.value === 'string'
          ? { ...operation, value: operation.value.trim() }
          : operation,
      );
      return { action: 'replace', operations };
    });
    return;
  }
  // 在 main 角色注册 provider、命令和普通事件订阅。
}
```

钩子收到 `PluginMutationProposal`：`projectId`、`transactionId`、`baseStateId`、`origin`、`operations` 和可选 `causationId`。返回 `{action:'continue'}`、`{action:'replace',operations}` 或 `{action:'reject',reason}`。只能替换操作数组，不能改项目或来源。`operations` 声明过滤器可省略，表示检查全部操作。

每次提案中，钩子按 priority 升序，再按插件 ID、钩子 ID 排序，各执行一次。后一个钩子接收此前有效改写。默认每钩子预算 250ms、整链 1 秒；预算包含改写校验。业务拒绝会拒绝此次提交；错误、非法改写或超时会保留此前有效提案、继续提交并暂停故障插件的拦截能力。总预算耗尽后跳过剩余钩子，迟到结果不采纳。在插件管理中可查看原因并点击“恢复拦截”。

钩子等待不占核心命令队列或核心锁。hooks 角色可查询已提交的基准文档、图片、历史、配置和包内资源并记录日志；图片 get/read 也接受 `{projectId,stagedResource}`，仅限当前提案明确固定持有的句柄。不能嵌套提交事务、控制历史、写配置或下载模型；修改只能通过返回提案完成。这避免查询等待自身提交造成死锁。

手工持久化编辑、插件事务以及 OCR／翻译写回共用这条提交管线。撤销和重做绕过提交前钩子，只发送完成事件；项目打开、关闭、保存、导出和拖动中的临时预览也不经过修改钩子。

## 输入确认与恢复草稿

人工译文与原文在本地即时显示，IME 完成后检查最终文本。钩子等待期间继续输入会记录为步骤／差异，收到接受或改写确认后，在实际提交结果上重放形成下一提案，避免旧整段文字覆盖规范化结果。

拒绝或无法重放时，编辑视图对齐核心实际状态，并保留最新完整恢复草稿。业务拒绝不会毒化后续编辑队列；用户可以修改规则或暂停插件后恢复草稿。草稿本身未写入项目文件。保存、导航、关闭、撤销和重做会等待编辑与事务屏障；后台插件修改默认不抢走编辑焦点。

## 变更事件

后置通知从核心命令的确认边界产生。每次实际事务只发布一次相应事件；传输重试不会重复通知，undo／redo 根据实际前后文档发送相同领域事件。

| 事件                           | 内容                                 |
| ------------------------------ | ------------------------------------ |
| `image.added/updated/removed`  | 图片新增、元数据或像素版本变化、删除 |
| `images.reordered`             | 图片顺序变化                         |
| `marker.added/updated/removed` | 标记新增、内容／几何／样式变化、删除 |
| `markers.reordered`            | 某图片内标记顺序变化                 |
| `translation.changed`          | 人工译文变化                         |
| `assistance.changed`           | 辅助字段变化                         |
| `history.changed`              | 历史移动、提交或输入合并，附历史版本 |
| `transaction.committed`        | 整次事务完成                         |
| `document.changed`             | 兼容的文档变更通知                   |
| `project.opened/closed`        | 项目打开／关闭                       |
| `context.changed`              | 当前项目、图片、标记选择、主题和语言 |

领域事件携带 `PluginDocumentChangeEvent`：项目、事务／命令 ID、`origin`、可选因果标识、`revision`、前后状态 ID 和相关 `changes` 数组。origin 的 kind 可为 user、plugin、assistance、history 等，插件来源同时携带 pluginId。`history.changed` 还包含 `historyRevision`。

```ts
const subscription = ctx.events.subscribe(
  'translation.changed',
  (event) => {
    // 已知领域事件自动推导为 PluginDocumentChangeEvent。
    void ctx.log(`${event.transactionId}: ${event.changes.length} 项译文变化`);
  },
  { projectId, includeSelf: false },
);
ctx.subscriptions.add(subscription);
```

已知领域事件的 callback 自动推导 DTO 类型，`context.changed`／`config.changed` 和未知事件名保留 `JsonValue` 兼容接口。默认过滤本插件发起的变更，`includeSelf:true` 可显式接收；`projectId` 限定项目。没有历史实体事件重播，`context.changed` 等状态通知可以回放当前值。冷激活事件最多交付一次，避免监听插件因一次激活收到重复操作。

## 图片资源与项目资源包

图片二进制与 JSON 始终分开传输，不公开磁盘路径。暂存句柄绑定调用实例与项目，固定持有资源；多图先逐文件 stage，再在一个事务中引用。宿主读取并探测尺寸、媒体类型与校验值，插件不能通过事务伪造。

替换像素创建新 `assetId`，保留现有标记的归一化坐标。旧资源版本保留到项目关闭，可通过 undo／redo 恢复；删除页面不会删除用户原文件。成功事务将资源归属项目，失败、取消、卸载及项目关闭清理未使用暂存资源；不确定 ACK 期间继续固定持有资源，避免结果尚未确认就提前释放。

应用提供“导出项目资源包”：原子捕获同一提交点的文档和图片版本，在命令队列外通过 Worker 生成 ZIP。包内含 BF 与当前图片，使用无冲突安全别名，并只调整导出副本的 BF 引用。解压后按既有 BF＋图片关联流程打开。

导出不会修改当前文档、用户原图、BF 保存路径或 `savedStateId`。导出持有的图片版本在任务结束后释放，即使期间继续编辑也不会混入新版本。现有自动快照只保存文档元数据；图片字节与历史栈仍不写入自动快照。

## 独立面板

面板放在 `sandbox="allow-scripts"` iframe，不授予 `allow-same-origin`。宿主发送 `{ type: 'bubblefish:connect', apiVersion: 1, panelId, appearance }` 并转移两个 MessagePort：`event.ports[0]` 继续用于插件 API，`event.ports[1]` 专用于宿主主题同步。旧面板仍只连接第一个端口，无需修改 SDK 调用：

```ts
import { connectPanel } from '../../../src/plugin-sdk';
window.addEventListener(
  'message',
  (event) => {
    if (event.source !== window.parent || event.data?.type !== 'bubblefish:connect') return;
    const sdk = connectPanel(event.ports[0]);
    sdk.events.subscribe('context.changed', (context) => {
      /* theme、locale、选择 */
    });
  },
  { once: true },
);
```

面板 SDK 提供配置、完整 document／history、命令、资源和事件接口；不能注册后台 provider 或提交前钩子。面板关闭会关闭其通道，后台 provider 与 hooks 实例继续运行。桌面用受限 `bf-plugin` 自定义协议提供已登记 HTML，并使用独立 CSP，主界面不开放 inline script。

### 主题与基础样式

宿主从应用实际生效的 CSS 采集配色、字体、字号及明确的 `light`／`dark` 模式，形成带单调 `revision` 的 `PluginPanelAppearance` 快照。DTO 由 Rust 定义并生成 TypeScript。面板跟随软件当前的海洋、果实或夜间主题，不自行依据操作系统外观选择配色。

网页的面板 HTML 与桌面 `bf-plugin` HTML 响应注入同一份初始化脚本和基础 CSS。注入只作用于本次响应，不改写已安装的 HTML、插件文件或模型资源。现有 `sandbox` 和桌面 CSP 保持不变；面板仍不能访问宿主 DOM、组件或 store。

初始化脚本接收快照并通过受控属性与 `style.setProperty()` 应用主题，不将快照拼接为任意 CSS。它负责第二个端口的通信与确认，插件不需要自行管理该端口。iframe 在确认当前快照已应用后才显示，此前展示宿主配色的加载占位；5 秒内未收到确认时显示加载错误和“重试加载”按钮。

公开的主题变量如下，可用于插件自身的区域与控件：

| 用途                           | CSS 变量                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| 背景、表面、悬浮表面           | `--bf-panel-background`、`--bf-panel-surface`、`--bf-panel-surface-hover`               |
| 正文、强调文字、次要文字       | `--bf-panel-text`、`--bf-panel-strong`、`--bf-panel-muted`                              |
| 边框、强调色、强调背景、危险色 | `--bf-panel-border`、`--bf-panel-accent`、`--bf-panel-accent-soft`、`--bf-panel-danger` |
| 字体、字号、圆角               | `--bf-panel-font-family`、`--bf-panel-font-size`、`--bf-panel-radius`                   |

```css
.preview {
  padding: 12px;
  background: var(--bf-panel-surface);
  color: var(--bf-panel-text);
  border: 1px solid var(--bf-panel-border);
  border-radius: var(--bf-panel-radius);
}
.hint {
  color: var(--bf-panel-muted);
}
[data-error='true'] {
  color: var(--bf-panel-danger);
}
```

宿主基础样式统一正文、标题、按钮、输入框、下拉框、文本域、进度条及结果区域，包含悬浮、聚焦和禁用状态。插件保留布局、尺寸与图片／图表等内容的语义颜色；基础文字、背景和控件应使用上述变量，避免独立声明 `color-scheme: light dark` 或写死基础颜色。

软件切换主题时，宿主通过主题通道原地更新快照，不重设 iframe 的 `src/srcdoc`，不重连插件 API。未保存输入、焦点、选择、滚动及正在进行的模型导入得以保留，连续切换以最新快照为准。关闭面板会清理主题端口、监听和超时计时器。主题只属于临时界面状态，不进入项目、插件配置或文档历史。

## Rust SDK 与传输

参见 [Rust SDK](../crates/plugin-sdk/README.md)。同一个 Rust 插件可编译为 WASM 或独立原生进程。原生由宿主注册目录启动，使用 stdin／stdout 通信，stderr 为日志；宿主重载和退出会回收进程。

协议继续使用 API 版本 1。握手新增可选 `runtimeRole: 'main' | 'hooks'`，缺失按 main 处理；feature 声明包含 `document.transactions`、`history`、`hooks`、`runtime.roles`。旧 provider、read/apply 和已有示例包继续工作。Rust SDK 提供相同的类型化文档与历史 helpers，`on_event_with_context` 支持异步事件处理并携带 `PluginContext`。

消息为 `kind: request | response | event`，包含 `apiVersion: 1`；请求／响应通过 `id` 对应。原生帧为 u32 little-endian JSON 长度、u32 little-endian 二进制长度、UTF-8 JSON、独立二进制。JSON 最大 8 MiB、二进制最大 512 MiB，附件长度必须一致。不要把图片或模型变成 JSON 数字数组。

Rust SDK 串行分发，取消事件在 handler 的分发边界交付；不会自动中断单次原生／WASM 推理。宿主会立即拒绝取消结果，停用超时后终止整个实例。模型应在首次实际使用时初始化，并在停用时释放。

插件运行在用户主动安装且信任的前提下。Worker 与原生进程提供执行和崩溃边界，不是完整安全沙箱；权限限制宿主 RPC，不限制原生程序自行访问操作系统。

## 验证

```sh
npm run types:check
npm run check
npm run test:plugins
npm run test:core
npm run test:host
npm run test:ui
npm run build:web
npm run test:e2e -- tests/plugins.spec.ts
npm run test:e2e -- tests/plugin-document.spec.ts
```

三个可安装示例“图片与标记工具箱”“历史与事件检查器”“编辑检查插件”及 Rust SDK 示例见 [示例说明](../examples/plugins/README.md)。真实 Rust WASM／原生示例同时验证新接口和 main／hooks 双角色，黄金轨迹覆盖文档事务、二进制、事件和历史。没有插件市场、自动更新、插件间依赖或旧版二进制兼容层。
