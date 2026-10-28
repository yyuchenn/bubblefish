use bubblefish_core::{
    protocol::{CoreError, Envelope, Reply},
    Engine,
};
use bubblefish_formats::{Format, ImportResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Emitter, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Default)]
struct HostState {
    engine: Mutex<Engine>,
    authorized: Mutex<HashSet<PathBuf>>,
    pending_open: Mutex<Vec<String>>,
    recent: Mutex<Vec<String>>,
    closing: AtomicBool,
    core_started: AtomicBool,
    chrome: Mutex<WindowChromeState>,
    #[cfg(any(target_os = "macos", test))]
    native_recent: Mutex<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowChromeState {
    platform: String,
    maximized: bool,
    fullscreen: bool,
    focused: bool,
    revision: u64,
}
impl Default for WindowChromeState {
    fn default() -> Self {
        Self {
            platform: std::env::consts::OS.into(),
            maximized: false,
            fullscreen: false,
            focused: false,
            revision: 0,
        }
    }
}
impl WindowChromeState {
    fn record(&mut self, maximized: bool, fullscreen: bool, focused: bool) -> Self {
        self.maximized = maximized;
        self.fullscreen = fullscreen;
        self.focused = focused;
        self.revision += 1;
        self.clone()
    }
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window unavailable".into())
}
fn refresh_window_state(app: &tauri::AppHandle, focused: Option<bool>) -> Result<(), String> {
    let window = main_window(app)?;
    let maximized = window.is_maximized().map_err(err)?;
    let fullscreen = window.is_fullscreen().map_err(err)?;
    let focused = match focused {
        Some(value) => value,
        None => window.is_focused().map_err(err)?,
    };
    let state = app.state::<HostState>();
    let mut chrome = lock(&state.chrome)?;
    let snapshot = chrome.record(maximized, fullscreen, focused);
    drop(chrome);
    app.emit("bf://window-state", snapshot).map_err(err)
}

#[tauri::command]
fn platform_window_info(state: tauri::State<'_, HostState>) -> Result<WindowChromeState, String> {
    Ok(lock(&state.chrome)?.clone())
}
#[tauri::command]
fn platform_window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.minimize().map_err(err)
}
#[tauri::command]
fn platform_window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    if window.is_maximized().map_err(err)? {
        window.unmaximize().map_err(err)?;
    } else {
        window.maximize().map_err(err)?;
    }
    refresh_window_state(&app, None)
}
#[tauri::command]
fn platform_window_set_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    main_window(&app)?.set_title(&title).map_err(err)
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn core_err(error: CoreError) -> String {
    let location = error
        .path
        .as_deref()
        .map(|path| format!(" ({path})"))
        .unwrap_or_default();
    format!("{error}{location}")
}
fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Host state lock was poisoned".into())
}
fn project_path(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| ["bf", "lp", "txt"].contains(&s.to_ascii_lowercase().as_str()))
}
fn image_path(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        ["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&s.to_ascii_lowercase().as_str())
    })
}
fn authorize(state: &HostState, path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(err)?;
    if !canonical.is_file() {
        return Err("Expected a regular file".into());
    }
    lock(&state.authorized)?.insert(canonical.clone());
    Ok(canonical)
}
fn authorized(state: &HostState, path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(err)?;
    if !canonical.is_file() || !lock(&state.authorized)?.contains(&canonical) {
        return Err("Choose this file through the file picker before accessing it".into());
    }
    Ok(canonical)
}
fn raw(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("Expected raw binary request".into()),
    }
}
fn header(request: &Request<'_>, key: &str) -> Result<String, String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing {key} header"))
}
fn format(name: &str) -> Result<Format, CoreError> {
    match name {
        "bf" => Ok(Format::Bf),
        "labelplus" => Ok(Format::Labelplus),
        _ => Err(CoreError::new("unknown_format", "Unknown project format")),
    }
}
fn recent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("recent.json"))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("File has no parent directory")?;
    let name = path
        .file_name()
        .ok_or("File has no name")?
        .to_string_lossy();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let temporary = parent.join(format!(".{name}.{}.{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
        drop(file);
        fs::rename(&temporary, path).map_err(err)?;
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn queue_open(app: &tauri::AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let state = app.state::<HostState>();
    let mut pending = match state.pending_open.lock() {
        Ok(value) => value,
        Err(_) => return,
    };
    for path in paths {
        if project_path(&path) {
            if let Ok(path) = authorize(&state, &path) {
                let path = path.to_string_lossy().into_owned();
                if !pending.contains(&path) {
                    pending.push(path);
                }
            }
        }
    }
    drop(pending);
    let _ = app.emit("bf://open", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn core_ready(state: tauri::State<'_, HostState>) {
    state.core_started.store(true, Ordering::SeqCst);
}
#[tauri::command]
fn core_dispatch(state: tauri::State<'_, HostState>, envelope: Envelope) -> Result<Reply, String> {
    Ok(lock(&state.engine)?.dispatch(envelope))
}
#[tauri::command]
fn core_import(request: Request<'_>) -> Result<ImportResult, CoreError> {
    let bytes = raw(&request).map_err(|e| CoreError::new("invalid_request", e))?;
    let kind = header(&request, "x-bf-format").map_err(|e| CoreError::new("invalid_request", e))?;
    let project_id =
        header(&request, "x-bf-project").map_err(|e| CoreError::new("invalid_request", e))?;
    bubblefish_formats::import_project(&bytes, format(&kind)?, project_id)
}
#[tauri::command]
fn core_export(
    state: tauri::State<'_, HostState>,
    project_id: String,
    format: String,
) -> Result<Response, String> {
    let document = lock(&state.engine)?
        .document(&project_id)
        .map_err(core_err)?;
    Ok(Response::new(
        bubblefish_formats::export_project(&document, self::format(&format).map_err(err)?)
            .map_err(core_err)?,
    ))
}
#[tauri::command]
fn core_probe_image(request: Request<'_>) -> Result<bubblefish_wasm::ImageProbe, CoreError> {
    bubblefish_wasm::probe_image(&raw(&request).map_err(|e| CoreError::new("invalid_request", e))?)
}

#[tauri::command]
async fn platform_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    kind: String,
) -> Result<Vec<String>, String> {
    let files = match kind.as_str() {
        "images" => app
            .dialog()
            .file()
            .set_title("添加图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
            .blocking_pick_files(),
        "project" => app
            .dialog()
            .file()
            .set_title("打开项目")
            .add_filter("Bubblefish / LabelPlus", &["bf", "txt", "lp"])
            .blocking_pick_file()
            .map(|f| vec![f]),
        _ => return Err("Unknown picker kind".into()),
    };
    let mut paths = Vec::new();
    for file in files.unwrap_or_default() {
        let path = file.into_path().map_err(err)?;
        let canonical = authorize(&state, &path)?;
        paths.push(canonical.to_string_lossy().into_owned());
    }
    Ok(paths)
}
#[tauri::command]
async fn platform_read(
    state: tauri::State<'_, HostState>,
    path: String,
) -> Result<Response, String> {
    let path = authorized(&state, Path::new(&path))?;
    if fs::metadata(&path).map_err(err)?.len() > 128 * 1024 * 1024 {
        return Err("File exceeds 128 MiB".into());
    }
    Ok(Response::new(fs::read(path).map_err(err)?))
}
#[tauri::command]
fn platform_scan_images(
    state: tauri::State<'_, HostState>,
    project_path: String,
) -> Result<Vec<String>, String> {
    let project = authorized(&state, Path::new(&project_path))?;
    let directory = project.parent().ok_or("Project has no parent directory")?;
    let mut paths = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.file_type().map_err(err)?.is_file() && image_path(&entry.path()) {
            let path = authorize(&state, &entry.path())?;
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    paths.sort();
    Ok(paths)
}
#[tauri::command]
fn platform_allow_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    path: String,
) -> Result<(), String> {
    let path = authorized(&state, Path::new(&path))?;
    if !image_path(&path) {
        return Err("Expected image path".into());
    }
    app.asset_protocol_scope().allow_file(path).map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveOptions {
    suggested_name: String,
    path: Option<String>,
    #[serde(default)]
    save_as: bool,
    format: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    path: Option<String>,
    cancelled: bool,
}
#[tauri::command]
async fn platform_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    request: Request<'_>,
) -> Result<SaveResult, String> {
    let options_json = percent_encoding::percent_decode_str(&header(&request, "x-bf-options")?)
        .decode_utf8()
        .map_err(err)?
        .into_owned();
    let options: SaveOptions = serde_json::from_str(&options_json).map_err(err)?;
    let bytes = raw(&request)?;
    let path = if !options.save_as && options.path.is_some() {
        authorized(&state, Path::new(options.path.as_ref().unwrap()))?
    } else {
        let extension = match options.format.as_str() {
            "bf" => "bf",
            "labelplus" => "txt",
            _ => return Err("Unknown format".into()),
        };
        let dialog = app
            .dialog()
            .file()
            .set_title("保存项目")
            .set_file_name(&options.suggested_name)
            .add_filter("项目文件", &[extension]);
        let Some(path) = dialog.blocking_save_file() else {
            return Ok(SaveResult {
                path: None,
                cancelled: true,
            });
        };
        path.into_path().map_err(err)?
    };
    atomic_write(&path, &bytes)?;
    let canonical = authorize(&state, &path)?;
    Ok(SaveResult {
        path: Some(canonical.to_string_lossy().into_owned()),
        cancelled: false,
    })
}
#[tauri::command]
fn platform_recent(state: tauri::State<'_, HostState>) -> Result<Vec<String>, String> {
    Ok(lock(&state.recent)?.clone())
}
#[tauri::command]
fn platform_remember(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    path: String,
) -> Result<(), String> {
    let canonical = authorized(&state, Path::new(&path))?
        .to_string_lossy()
        .into_owned();
    let mut recent = lock(&state.recent)?;
    recent.retain(|item| item != &canonical);
    recent.insert(0, canonical);
    recent.truncate(5);
    atomic_write(
        &recent_path(&app)?,
        &serde_json::to_vec(&*recent).map_err(err)?,
    )
}
#[tauri::command]
fn platform_take_open(state: tauri::State<'_, HostState>) -> Result<Vec<String>, String> {
    Ok(std::mem::take(&mut *lock(&state.pending_open)?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuState {
    #[serde(default = "default_menu_enabled")]
    enabled: bool,
    has_project: bool,
    can_undo: bool,
    can_redo: bool,
    undo_label: Option<String>,
    redo_label: Option<String>,
    #[serde(default)]
    recent_files: Vec<String>,
    #[serde(default)]
    left_open: bool,
    #[serde(default)]
    right_open: bool,
}
fn default_menu_enabled() -> bool {
    true
}

#[cfg(any(target_os = "macos", test))]
fn recent_action_id(path: &str) -> String {
    // The native route has precisely the same component encoding as the web UI.
    const ENCODE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    format!(
        "app.openRecent:{}",
        percent_encoding::utf8_percent_encode(path, ENCODE)
    )
}

#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn populate_recent_menu(
    app: &tauri::AppHandle,
    submenu: &tauri::menu::Submenu<tauri::Wry>,
    paths: &[String],
) -> Result<(), String> {
    use tauri::menu::MenuItemBuilder;
    for item in submenu.items().map_err(err)? {
        submenu.remove(&item).map_err(err)?;
    }
    submenu.set_enabled(!paths.is_empty()).map_err(err)?;
    for path in paths.iter().take(5) {
        let name = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let item = MenuItemBuilder::with_id(recent_action_id(path), name.replace('&', "&&"))
            .build(app)
            .map_err(err)?;
        submenu.append(&item).map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
fn platform_sync_menu(app: tauri::AppHandle, menu: NativeMenuState) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    if let Some(native_menu) = app.menu() {
        for entry in native_menu.items().map_err(err)? {
            let Some(submenu) = entry.as_submenu() else {
                continue;
            };
            for id in [
                "app.save",
                "app.saveAs",
                "app.exportLabelplus",
                "app.closeCurrent",
                "view.fit",
                "view.width",
                "view.height",
            ] {
                if let Some(entry) = submenu
                    .get(id)
                    .and_then(|entry| entry.as_menuitem().cloned())
                {
                    entry
                        .set_enabled(menu.enabled && menu.has_project)
                        .map_err(err)?;
                }
            }
            for id in ["app.new", "app.open", "app.snapshots", "app.settings"] {
                if let Some(entry) = submenu
                    .get(id)
                    .and_then(|entry| entry.as_menuitem().cloned())
                {
                    entry.set_enabled(menu.enabled).map_err(err)?;
                }
            }
            for (id, enabled, label, action) in [
                (
                    "app.undo",
                    menu.enabled && menu.has_project && menu.can_undo,
                    &menu.undo_label,
                    "撤销",
                ),
                (
                    "app.redo",
                    menu.enabled && menu.has_project && menu.can_redo,
                    &menu.redo_label,
                    "重做",
                ),
            ] {
                if let Some(entry) = submenu
                    .get(id)
                    .and_then(|entry| entry.as_menuitem().cloned())
                {
                    entry.set_enabled(enabled).map_err(err)?;
                    entry
                        .set_text(
                            label
                                .as_deref()
                                .filter(|text| !text.is_empty())
                                .map(|label| format!("{action} {label}"))
                                .unwrap_or_else(|| action.into()),
                        )
                        .map_err(err)?;
                }
            }
            for (id, checked) in [
                ("view.toggleLeft", menu.left_open),
                ("view.toggleRight", menu.right_open),
            ] {
                if let Some(item) = submenu
                    .get(id)
                    .and_then(|item| item.as_check_menuitem().cloned())
                {
                    item.set_enabled(menu.enabled).map_err(err)?;
                    item.set_checked(checked).map_err(err)?;
                }
            }
            if let Some(recent) = submenu
                .get("file.recent")
                .and_then(|item| item.as_submenu().cloned())
            {
                let state = app.state::<HostState>();
                let mut previous = lock(&state.native_recent)?;
                let paths = menu
                    .recent_files
                    .iter()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>();
                if *previous != paths {
                    populate_recent_menu(&app, &recent, &paths)?;
                    *previous = paths;
                }
                recent
                    .set_enabled(menu.enabled && !previous.is_empty())
                    .map_err(err)?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (
        app,
        menu.enabled,
        menu.has_project,
        menu.can_undo,
        menu.can_redo,
        menu.undo_label,
        menu.redo_label,
        menu.recent_files,
        menu.left_open,
        menu.right_open,
    );
    Ok(())
}
#[tauri::command]
async fn platform_confirm_close(app: tauri::AppHandle, name: String) -> String {
    match app
        .dialog()
        .message(format!("“{name}”尚未保存。保存后关闭？"))
        .title("未保存的修改")
        .buttons(MessageDialogButtons::YesNoCancel)
        .blocking_show_with_result()
    {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::No => "discard",
        _ => "cancel",
    }
    .into()
}
#[tauri::command]
fn platform_close(app: tauri::AppHandle, state: tauri::State<'_, HostState>) -> Result<(), String> {
    // The frontend calls this only after its edit/save barrier has accepted
    // closing every project. Exit the app explicitly so macOS application-level
    // quit and window-close requests have the same committed outcome.
    if !state.closing.swap(true, Ordering::SeqCst) {
        app.exit(0);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn setup_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id, text, key| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(key)
            .build(app)
    };
    let application = SubmenuBuilder::new(app, "Bubblefish Next")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&item(
            "window.close",
            "退出 Bubblefish Next",
            "CmdOrCtrl+Q",
        )?)
        .build()?;
    let recent = SubmenuBuilder::with_id(app, "file.recent", "最近文件").build()?;
    let paths = app
        .state::<HostState>()
        .recent
        .lock()
        .map(|paths| paths.clone())
        .unwrap_or_default();
    populate_recent_menu(app, &recent, &paths).map_err(std::io::Error::other)?;
    if let Ok(mut previous) = app.state::<HostState>().native_recent.lock() {
        *previous = paths;
    }
    let file = SubmenuBuilder::new(app, "文件")
        .item(&item("app.new", "新建项目", "CmdOrCtrl+N")?)
        .item(&item("app.open", "打开项目…", "CmdOrCtrl+O")?)
        .item(&recent)
        .separator()
        .item(&item("app.save", "保存", "CmdOrCtrl+S")?)
        .item(&item("app.saveAs", "另存为…", "CmdOrCtrl+Shift+S")?)
        .text("app.exportLabelplus", "导出 LabelPlus…")
        .separator()
        .item(&item("app.closeCurrent", "关闭项目", "CmdOrCtrl+W")?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .item(&item("app.undo", "撤销", "CmdOrCtrl+Z")?)
        .item(&item("app.redo", "重做", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "视图")
        .check("view.toggleLeft", "左侧面板")
        .check("view.toggleRight", "翻译面板")
        .separator()
        .text("view.fit", "适合屏幕")
        .text("view.width", "适合宽度")
        .text("view.height", "适合高度")
        .build()?;
    let more = SubmenuBuilder::new(app, "更多")
        .text("app.snapshots", "快照")
        .text("app.settings", "设置与外观")
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &view, &more])
            .build()?,
    )?;
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(HostState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            queue_open(
                app,
                args.into_iter().skip(1).map(|arg| {
                    let path = PathBuf::from(arg);
                    if path.is_absolute() {
                        path
                    } else {
                        PathBuf::from(&cwd).join(path)
                    }
                }),
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Create exactly once from the common config. Platform chrome is
            // applied before build/show, avoiding a native-titlebar flash.
            #[cfg_attr(
                not(any(target_os = "windows", target_os = "macos")),
                allow(unused_mut)
            )]
            let mut config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("Main window configuration unavailable")?
                .clone();
            #[cfg(target_os = "windows")]
            {
                config.decorations = false;
            }
            #[cfg(target_os = "macos")]
            {
                config.decorations = true;
                config.title_bar_style = tauri::TitleBarStyle::Overlay;
                config.hidden_title = true;
            }
            tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
            refresh_window_state(app.handle(), None)?;
            let state = app.state::<HostState>();
            if let Ok(path) = recent_path(app.handle()) {
                if let Ok(bytes) = fs::read(path) {
                    if let Ok(paths) = serde_json::from_slice::<Vec<String>>(&bytes) {
                        let valid: Vec<_> = paths
                            .into_iter()
                            .filter(|p| project_path(Path::new(p)) && Path::new(p).is_file())
                            .take(5)
                            .collect();
                        for path in &valid {
                            let _ = authorize(&state, Path::new(path));
                        }
                        *lock(&state.recent)? = valid;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            setup_menu(app.handle())?;
            queue_open(app.handle(), std::env::args_os().skip(1).map(PathBuf::from));
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "window.close" {
                if app.state::<HostState>().core_started.load(Ordering::SeqCst) {
                    let _ = app.emit("bf://close-requested", ());
                } else {
                    app.exit(0);
                }
            } else {
                let _ = app.emit("bf://action", id);
            }
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::Focused(focused) => {
                    let _ = refresh_window_state(window.app_handle(), Some(*focused));
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    let _ = refresh_window_state(window.app_handle(), None);
                }
                _ => {}
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<HostState>();
                if state.core_started.load(Ordering::SeqCst)
                    && !state.closing.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("bf://close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_ready,
            core_dispatch,
            core_import,
            core_export,
            core_probe_image,
            platform_pick,
            platform_read,
            platform_scan_images,
            platform_allow_image,
            platform_save,
            platform_recent,
            platform_remember,
            platform_take_open,
            platform_window_info,
            platform_window_minimize,
            platform_window_toggle_maximize,
            platform_window_set_title,
            platform_sync_menu,
            platform_confirm_close,
            platform_close
        ]);
    let app = builder
        .build(tauri::generate_context!())
        .expect("Failed to initialize Bubblefish Next");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            let state = app.state::<HostState>();
            // A system/application quit (for example macOS Dock Quit) may not
            // first produce WindowEvent::CloseRequested. Route it through the
            // same frontend barrier. Explicit committed exits and a legitimately
            // destroyed last window must remain able to terminate the process.
            if code.is_none()
                && state.core_started.load(Ordering::SeqCst)
                && !state.closing.load(Ordering::SeqCst)
                && app.get_webview_window("main").is_some()
            {
                api.prevent_exit();
                let _ = app.emit("bf://close-requested", ());
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            queue_open(
                app,
                urls.into_iter().filter_map(|url| url.to_file_path().ok()),
            );
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_access_requires_exact_grant() {
        let state = HostState::default();
        let file = std::env::current_exe().unwrap();
        assert!(authorized(&state, &file).is_err());
        authorize(&state, &file).unwrap();
        assert!(authorized(&state, &file).is_ok());
    }
    #[test]
    fn atomic_save_replaces_content() {
        let path =
            std::env::temp_dir().join(format!("bf-next-atomic-test-{}.bf", std::process::id()));
        atomic_write(&path, b"before").unwrap();
        atomic_write(&path, b"after").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"after");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn window_query_snapshot_cannot_acquire_a_later_event_revision() {
        let mut chrome = WindowChromeState::default();
        let earlier_query = chrome.record(false, false, true);
        let event = chrome.record(true, false, false);
        assert!(earlier_query.revision < event.revision);
        assert!(!earlier_query.maximized && earlier_query.focused);
        assert!(event.maximized && !event.focused);
        assert_eq!(chrome.revision, event.revision);
        let fullscreen_event = chrome.record(false, true, true);
        assert!(fullscreen_event.revision > event.revision);
        assert!(fullscreen_event.fullscreen);
    }

    #[test]
    fn recent_route_is_a_javascript_uri_component() {
        assert_eq!(
            recent_action_id("C:\\漫画\\a & #?.bf"),
            "app.openRecent:C%3A%5C%E6%BC%AB%E7%94%BB%5Ca%20%26%20%23%3F.bf"
        );
        assert_eq!(
            recent_action_id("/tmp/a-_.!~*'().bf"),
            "app.openRecent:%2Ftmp%2Fa-_.!~*'().bf"
        );
    }
}
