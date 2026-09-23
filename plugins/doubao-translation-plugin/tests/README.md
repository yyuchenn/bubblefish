# Doubao WASM Worker integration tests

Run from the repository root with Node.js 22 or newer and `wasm-pack`:

```sh
wasm-pack build plugins/doubao-translation-plugin --target web --dev --out-dir pkg -- --features wasm
node --test plugins/doubao-translation-plugin/tests/worker.integration.test.mjs
```

Alternatively, compile with Cargo and generate **web** bindings with a matching
`wasm-bindgen` CLI. Set `DOUBAO_WASM_PKG` to the generated package directory if it
is not the plugin's `pkg` directory. Both unversioned filenames and the versioned
filenames produced by `build.py` are supported; the latter use the version in
`manifest.json`, `package.json`, or `version.json`.

To test the files actually packaged for the frontend from PowerShell:

```powershell
$env:DOUBAO_WASM_PKG = 'frontend/static/plugins/doubao-translation-plugin/pkg'
node --test plugins/doubao-translation-plugin/tests/worker.integration.test.mjs
Remove-Item Env:DOUBAO_WASM_PKG
```

These tests load the actual generated WASM in a Node Worker, exercise the exported
`PluginWrapper` lifecycle and messages, and answer synchronous SDK service calls
through the real SharedArrayBuffer protocol. The Worker has no `Window`; a minimal
`WorkerGlobalScope` identity shim supplies the browser type check. Request,
Headers, Response, WebAssembly and Atomics use Node's implementations. The suite
captures and mocks every `fetch`; it requires no credentials, network, or paid
API calls. This verifies Worker transport and plugin behavior, but does not replace
a browser CORS check or a live Ark model availability check.
