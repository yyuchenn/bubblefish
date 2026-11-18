# Header browser fixture

`index.html` mounts the production `WorkspaceHeader` and popup controller through
a small Svelte parent. Its ordinary form controls publish a read-only project
projection and window-chrome props; callback results are displayed as a list.
No test API or alternate window behavior is added to production code.

`tauri-2.12.6-drag.txt` is an unmodified copy of `src/window/scripts/drag.js` from
the official `tauri 2.12.6` crate, matching this project's Cargo.lock. The browser
test checks the locked version before replacing only the operating-system
template literal and recording IPC calls. When updating Tauri, compare the
matching official script, update the fixture and `TAURI_FIXTURE_VERSION`, and
preserve its copyright and Apache-2.0/MIT license header.

These tests cover browser layout and event dispatch only. Native decorations,
traffic lights, window movement and system window-manager behavior still require
operating-system smoke tests.
