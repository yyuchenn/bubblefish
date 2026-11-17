# Rust plugin SDK

`bubblefish-plugin-sdk` shares one async plugin interface between browser
WASM and native executables. Implement `Plugin::manifest` and `Plugin::handle`;
return a `PluginFuture` and use `PluginContext` for host calls. The SDK processes
the initial handshake and rejects identity/API mismatches before plugin calls.

The host calls `activate` with `{config}`, `deactivate`, `ocr.recognize` and
`translation.translate` with `{providerId,input,taskId}`, or `commands.execute`
with `{commandId,params,taskId?}`. Register declared contributions during activation with
`register_ocr`, `register_translation` and `register_command`. Emit task progress
through `context.progress(task_id, value)` or the current request's
`context.report_progress(value)`. `context.task_id()` and `request_id()` expose
the bound identifiers. `context.summary("检查完成")` supplies a short success
summary without changing the command's raw return value; the host displays it
only after a successful response. Progress and summary are no-ops when a legacy
caller omitted `taskId`. The additive `commands.tasks` handshake feature keeps
the protocol at version 1.

Call `context.check_cancelled()?` between expensive steps and async waits.
`native::serve_stdio` runs an independent input/control thread: `$cancel` sets
the matching request token even while the serial actor is busy or the request
is queued. Synchronous native/WASM inference stops only at a subsequent check,
not in the middle of an inference call. Reporting progress and starting a new
host call also check cancellation. Already-issued host calls still consume their
ACK, so cancelling does not roll back committed document changes or external
side effects. The host keeps a command in “cancelling” until actual settlement;
it does not kill the whole plugin merely to cancel one command.

`native::serve(plugin, borrowed_reader, writer)` remains available for legacy
embedding and deterministic frame fixtures. Owned readers can use
`native::serve_with_control(plugin, reader, writer)` for the same independent
control plane as stdio. The plugin and writer stay on the calling thread.

`PluginContext::runtime_role` comes from the handshake and is either `Main` or
`Hooks`. A plugin declaring `contributes.beforeCommitHooks` receives a separate
instance for interception; register its declared hooks with
`register_before_commit`. The main instance continues serving providers and
commands. Handle `hooks.beforeCommit` by deserializing `params.proposal` as
`PluginMutationProposal` and returning a serialized `BeforeCommitHookResult`.
Hooks may query committed document/image/history state, configuration and package
resources. They must return replacement operations rather than submit writes or
control history. Errors and deadlines pause interception without stopping the
main instance. The example's `normalize-text` hook trims plain translations.

Typed `PluginContext` helpers mirror the TypeScript SDK:

| TypeScript API            | Rust helpers                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `document.images.*`       | `images_list/get/read/stage/create/update/remove/reorder`                              |
| `document.markers.*`      | `markers_list/get/create/update/remove/reorder`                                        |
| `document.translations.*` | `translations_get/set/clear`                                                           |
| `document.assistance.*`   | `assistance_get/update/clear`                                                          |
| `document.transaction`    | `transaction(PluginTransaction)`                                                       |
| `history.*`               | `history_list/push/pop/undo/redo`                                                      |
| `events.subscribe`        | `events_subscribe(event, PluginEventOptions)`                                          |
| `resources.local.*`       | `resources_local_begin_import/write_chunk/commit_import/abort_import/list/read/remove` |

All writes submit a transaction. Use `create_id()` before building its
`PluginOperation` array to refer to new images/markers in later operations.
`images_read` returns `ImageBytes { metadata, binary }`; `images_stage` sends bytes
independently and returns a project/instance-bound `PluginStagedImage` lease.
Image dimensions and checksums come from the host. `history_push` aliases
transaction submission; `history_pop` moves the guarded top entry between undo
and redo stacks. `PluginHistoryControl` supports expected entry/revision guards.
The host checks permissions using the connection identity, never request fields.
`images_get_staged` and `images_read_staged` inspect a staged lease owned by the
instance or explicitly held by the current hook proposal; they never expose a
filesystem path. The `get` helpers return `Option` for missing entities.

`resources.local` stores plugin-private model/resource sets independently of
project files, history and plugin code. Declare `resources.local.read` for list
and binary read, and `resources.local.write` for import and removal; the hooks
role cannot use this API. The optional `resources.local` handshake feature
advertises support while the protocol remains version 1.

Begin an import using `PluginLocalResourceImport { id, files }`, where each
`PluginLocalResourceFile` declares `path`, `byte_length` and `sha256`. Send
sequential binary chunks of at most 4 MiB with exact offsets. Commit publishes
the set only after every declared file has the expected length and SHA-256;
errors or cancellation leave the previous published set intact. Abort an
unfinished import explicitly; its owning connection closing also cleans it up.
Set IDs use lowercase ASCII letters, digits, dots, underscores and dashes;
relative file paths must be portable and cannot overlap files with directories.
Sets contain 1–100 nonempty files and at most 512 MiB in total.

```rust,ignore
let sets = context.resources_local_list().await?;
let bytes = context
    .resources_local_read("kha-white-manga-ocr-fp32-v1", "encoder.onnx")
    .await?;
```

`resources_local_read` returns independent `Vec<u8>` binary data, never a host
filesystem path. Disabling a plugin removes unfinished imports; uninstalling it
also removes its committed local sets. Models are not stored in BF or snapshots.

Override `on_event_with_context` for asynchronous event handlers that need host
calls. It receives `&mut PluginContext`, allowing history queries or subsequent
transactions. The default delegates to existing synchronous `on_event` handlers.
Subscriptions accept project and own-origin filters; hooks remain read-only.

Binary data is separate from JSON in `Frame.binary`. Do not put image byte arrays
in request parameters. Native executables run `native::serve_stdio(plugin)` and
reserve stdout for protocol frames; send diagnostic logs to stderr. Frames are
`u32 LE JSON length`, `u32 LE binary length`, JSON, then binary. JSON is capped at
8 MiB and binary at 512 MiB. Responses correlate by request ID. `call_host` can
receive independent binary results, such as `resources.read`.

For browser WASM, enable the `wasm` feature and invoke `export_wasm_plugin!(Type)`
for a default-constructible plugin. Its wasm-bindgen `PluginWrapper.dispatch`
accepts `{message,binary?:Uint8Array}` and a host callback, and returns a Promise
of a response frame. Package a single ESM entry exporting `createPlugin(host)`;
that entry reads its WASM using `resources.read`, initializes wasm-bindgen, and
returns the wrapper. Bundle the generated JS glue into the entry; WASM and model
weights remain independent package resources. See `examples/wasm-entry.mjs`.

The wrapper's `cancellation_handle()` returns an independent object with
`register(request_id)`, `cancel(request_id)` and `release(request_id)`. A host
obtains this object before dispatch, registers requests before queueing them,
and sends cancellation directly to the handle rather than behind the serial
dispatch queue. It never borrows the active async `PluginWrapper` twice.
The handler must yield to the JavaScript event loop for a cancellation message
to arrive, then check its token; synchronous WASM cannot be interrupted.

Build and package the working echo example from the repository root:

```sh
node crates/plugin-sdk/examples/build-example.mjs
node crates/plugin-sdk/examples/smoke-example.mjs
```

This produces `.cache/plugin-sdk-example/example.echo.bfplugin`, containing
browser WASM plus the native executable for the current Rust host target. Add
`--web-only` to omit the native executable. The script uses the wasm-bindgen CLI
cached by the application's normal WASM build; `BUBBLEFISH_WASM_BINDGEN` can point
to another matching CLI. Build `npm run build:web` once if that cache is absent.

The example registers `echo-ocr` and `prefix-translation`. OCR returns the number
of received image bytes, and translation prefixes the supplied text. These verify
the full provider workflow and binary transport without an OCR model. Native and
WASM use the same Rust implementation; replace its provider handlers with model
inference to build a real OCR plugin.

The example also contributes **Rust: inspect document and history**,
**Rust: duplicate first image**, and **Rust: task progress and cancellation**
commands. Inspection reads encoded full-image
bytes and history metadata; duplication stages those bytes and pushes one image
creation transaction. The document event handler asynchronously reads history
after commits. Both native and WASM use the same Rust source and a separate hooks
role. The smoke script runs both compiled adapters against identical binary,
transaction, event and hook golden traces, comparing every host call.
The task example yields between steps, reports per-task progress and summary,
and verifies active and queued cancellation followed by successful reuse in
both compiled adapters. This exercises real native and WASM control paths.
