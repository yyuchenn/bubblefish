# Local build orchestration

All commands run from the new project root. `npm ci` installs the locked npm
dependencies; Rust dependencies are pinned by the independent `Cargo.lock`.
Install stable Rust and the `wasm32-unknown-unknown` target before web development.

- `node scripts/run.mjs dev:web` builds the worker's WASM module, then starts Vite. Rust source/manifest changes rebuild the worker and reload the page; failed builds keep the server alive for the next edit. Optional `--port`, `--host`, and `--open` are supported.
- `node scripts/run.mjs build:web` builds optimized WASM and `dist/web`.
- `node scripts/run.mjs dev:desktop` runs desktop-mode Vite and the Tauri CLI.
- `node scripts/run.mjs build:desktop --no-bundle` builds `dist/desktop` and the native executable.
- Omit `--no-bundle` to package the installers for the host OS.
- `node scripts/run.mjs types:generate` explicitly rewrites TypeScript DTOs.
- `node scripts/run.mjs types:check` compares generated DTOs without rewriting them.
- `node scripts/run.mjs test:core` runs document/history and format regressions.
- `node scripts/run.mjs test:host` runs native file grants, atomic saves, and image inspection tests.
- `node scripts/run.mjs check:wasm` checks the actual stable Rust WASM target.

Desktop builds never require WASM; web builds never compile Tauri. No nightly,
threads, SharedArrayBuffer, or special HTTP response headers are required. The
WASM module is generated under `src/wasm`; its source fingerprint is cached under
`.cache`. Changing Rust sources or the lockfile invalidates that fingerprint.
Build commands stop at the first failure, propagate exit status, and clean up
their own development child processes and Rust file watchers when interrupted.

The locked npm `wasm-pack` package manages its own pinned binary. If npm blocks
postinstall scripts, its normal run shim installs the binary on first use. Build
tools can need network access on first run. The script respects `CARGO_HOME`,
`RUSTUP_HOME`, and `CARGO_NET_OFFLINE`; caches may be relocated in restricted
development environments. WASM tool downloads and npm cache use local `.cache`.
