# Header browser fixture

`index.html` mounts the production `WorkspaceHeader` and popup controller through
a small Svelte parent. Its ordinary form controls publish a read-only project
projection and window-chrome props; callback results are displayed as a list.
No test API or alternate window behavior is added to production code.

`tauri-2.12.5-drag.txt` is an unmodified copy of the drag-region script shipped by
the Tauri version locked in this project's Cargo.lock. The browser test replaces
only its operating-system template literal and records IPC calls. Preserve its
copyright and Apache-2.0/MIT license header when updating the locked version.

These tests cover browser layout and event dispatch only. Native decorations,
traffic lights, window movement and system window-manager behavior still require
operating-system smoke tests.
