use tauri::{Manager, Emitter, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, CheckMenuItemBuilder};

mod plugin_loader;
use plugin_loader::{init_plugin_loader, get_plugin_loader, PluginMetadata};


// 使用 bubblefish_core 的通用绑定
// 这会自动生成所有必要的 Tauri 命令和回调设置

// 原生文件选择对话框
#[tauri::command]
async fn open_image_file_dialog(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::sync::mpsc;
    
    let (tx, rx) = mpsc::channel();
    
    app_handle.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "bmp", "webp"])
        .set_title("选择图片文件")
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    
    // 等待用户选择
    match rx.recv() {
        Ok(Some(file_path)) => {
            // 返回绝对路径
            Ok(Some(file_path.to_string()))
        },
        Ok(None) => Ok(None), // 用户取消了选择
        Err(_) => Err("Dialog communication error".to_string())
    }
}

// 更新菜单项选中状态
#[tauri::command]
async fn update_menu_checked_state(app_handle: tauri::AppHandle, menu_id: String, checked: bool) -> Result<(), String> {
    // 在 macOS 上，菜单是应用级别的
    if let Some(menu) = app_handle.menu() {
        // 遍历所有菜单项，查找子菜单中的项目
        if let Ok(items) = menu.items() {
            for item in items {
                // 如果是子菜单，遍历其中的项目
                if let Some(submenu) = item.as_submenu() {
                    if let Some(sub_item) = submenu.get(menu_id.as_str()) {
                        if let Some(check_item) = sub_item.as_check_menuitem() {
                            check_item.set_checked(checked)
                                .map_err(|e| format!("Failed to set checked state: {}", e))?;
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// 更新菜单项的文本
#[tauri::command]
async fn update_menu_text(app_handle: tauri::AppHandle, menu_id: String, text: String) -> Result<(), String> {
    use tauri::menu::MenuItemKind;
    
    // 在 macOS 上，菜单是应用级别的
    if let Some(menu) = app_handle.menu() {
        // 遍历所有菜单项，查找子菜单中的项目
        if let Ok(items) = menu.items() {
            for item in items {
                // 如果是子菜单，遍历其中的项目
                if let Some(submenu) = item.as_submenu() {
                    // 检查子菜单中的项目
                    if let Some(sub_item) = submenu.get(menu_id.as_str()) {
                        if let MenuItemKind::MenuItem(menu_item) = &sub_item {
                            menu_item.set_text(text)
                                .map_err(|e| format!("Failed to set menu text: {}", e))?;
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// 更新菜单项启用/禁用状态
#[tauri::command]
async fn update_menu_enabled_state(app_handle: tauri::AppHandle, menu_id: String, enabled: bool) -> Result<(), String> {
    use tauri::menu::MenuItemKind;
    
    // 在 macOS 上，菜单是应用级别的
    if let Some(menu) = app_handle.menu() {
        // 遍历所有菜单项，查找子菜单中的项目
        if let Ok(items) = menu.items() {
            for item in items {
                // 如果是子菜单，遍历其中的项目
                if let Some(submenu) = item.as_submenu() {
                    // 首先检查子菜单本身是否需要更新
                    if submenu.id().as_ref() == &menu_id {
                        submenu.set_enabled(enabled)
                            .map_err(|e| format!("Failed to set submenu enabled state: {}", e))?;
                        return Ok(());
                    }
                    
                    // 然后检查子菜单中的项目
                    if let Some(sub_item) = submenu.get(menu_id.as_str()) {
                        match &sub_item {
                            MenuItemKind::MenuItem(menu_item) => {
                                menu_item.set_enabled(enabled)
                                    .map_err(|e| format!("Failed to set enabled state: {}", e))?;
                                return Ok(());
                            }
                            MenuItemKind::Check(check_item) => {
                                check_item.set_enabled(enabled)
                                    .map_err(|e| format!("Failed to set enabled state: {}", e))?;
                                return Ok(());
                            }
                            MenuItemKind::Submenu(nested_submenu) => {
                                nested_submenu.set_enabled(enabled)
                                    .map_err(|e| format!("Failed to set submenu enabled state: {}", e))?;
                                return Ok(());
                            }
                            _ => {
                                // 其他类型的菜单项不支持设置启用状态
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// 单选文本文件对话框
#[tauri::command]
async fn open_text_file_dialog(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::sync::mpsc;
    
    let (tx, rx) = mpsc::channel();
    
    app_handle.dialog()
        .file()
        .add_filter("Project Files", &["bf", "txt", "lp"])
        .set_title("选择翻译文件")
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    
    // 等待用户选择
    match rx.recv() {
        Ok(Some(file_path)) => {
            let path = file_path.to_string();
            println!("Selected text file: {}", path);
            Ok(Some(path))
        },
        Ok(None) => Ok(None), // 用户取消了选择
        Err(_) => Err("Dialog communication error".to_string())
    }
}

// 多选图片文件对话框
#[tauri::command]
async fn open_multiple_image_files_dialog(app_handle: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::sync::mpsc;
    
    let (tx, rx) = mpsc::channel();
    
    app_handle.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "bmp", "webp"])
        .set_title("选择图片文件")
        .pick_files(move |file_paths| {
            let _ = tx.send(file_paths);
        });
    
    // 等待用户选择
    match rx.recv() {
        Ok(Some(file_paths)) => {
            // 返回所有文件的绝对路径
            let paths: Vec<String> = file_paths.iter()
                .map(|fp| fp.to_string())
                .collect();
            Ok(Some(paths))
        },
        Ok(None) => Ok(None), // 用户取消了选择
        Err(_) => Err("Dialog communication error".to_string())
    }
}

// 保存项目到文件（带路径）
#[tauri::command]
async fn save_project_to_path(project_id: u32, file_path: String) -> Result<(), String> {
    // 获取项目数据
    let data = bubblefish_core::api::io::save_project(project_id)?;
    
    // 写入文件
    std::fs::write(&file_path, data)
        .map_err(|e| format!("Failed to save file: {}", e))?;
    
    // 更新项目的文件路径
    bubblefish_core::api::io::update_project_file_path(project_id, Some(file_path.clone()))?;
    
    Ok(())
}

// 获取项目的文件路径
#[tauri::command]
async fn get_project_file_path(project_id: u32) -> Result<Option<String>, String> {
    use bubblefish_core::api::project::get_project_info;
    
    match get_project_info(project_id) {
        Some(project) => Ok(project.file_path),
        None => Ok(None)
    }
}

// 读取文件内容
#[tauri::command]
async fn read_file_content(file_path: String) -> Result<String, String> {
    match std::fs::read_to_string(&file_path) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read file: {}", e))
    }
}

// 扫描目录中的图片文件（从文件路径自动提取目录）
#[tauri::command]
async fn scan_directory_for_images(file_path: String, required_images: Vec<String>) -> Result<Vec<String>, String> {
    use std::path::Path;
    use std::fs;
    
    // 从文件路径提取目录
    let file_path = Path::new(&file_path);
    let dir_path = file_path.parent()
        .ok_or_else(|| "无法从文件路径提取目录".to_string())?;
    
    if !dir_path.exists() || !dir_path.is_dir() {
        return Err("文件所在目录不存在或无效".to_string());
    }
    
    let mut found_images = Vec::new();
    let image_extensions = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];
    
    // 读取目录中的所有文件
    match fs::read_dir(dir_path) {
        Ok(entries) => {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(extension) = path.extension() {
                        let ext_str = extension.to_string_lossy().to_lowercase();
                        if image_extensions.contains(&ext_str.as_str()) {
                            if let Some(_file_name) = path.file_name() {
                                // 检查文件名（不包含扩展名）是否在需求列表中
                                let name_without_ext = path.file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("");
                                
                                // 检查是否匹配任何需要的图片
                                for required in &required_images {
                                    // 去掉required中可能的扩展名
                                    let required_stem = if let Some(pos) = required.rfind('.') {
                                        &required[..pos]
                                    } else {
                                        required
                                    };
                                    
                                    // 在 Windows 上进行不区分大小写的比较
                                    #[cfg(target_os = "windows")]
                                    let matches = name_without_ext.eq_ignore_ascii_case(required_stem);
                                    #[cfg(not(target_os = "windows"))]
                                    let matches = name_without_ext == required_stem;
                                    
                                    if matches {
                                        found_images.push(path.to_string_lossy().to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Err(e) => return Err(format!("无法读取目录: {}", e))
    }
    
    Ok(found_images)
}

// 获取应用信息
#[tauri::command]
async fn get_app_info() -> Result<String, String> {
    Ok("Bubblefish Desktop App v0.1.0".to_string())
}

// 插件管理命令
#[tauri::command]
async fn load_native_plugin(plugin_path: String) -> Result<PluginMetadata, String> {
    if let Some(loader) = get_plugin_loader() {
        loader.load_plugin(&plugin_path)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn unload_native_plugin(plugin_id: String) -> Result<(), String> {
    if let Some(loader) = get_plugin_loader() {
        loader.unload_plugin(&plugin_id)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn dispatch_event_to_plugin(plugin_id: String, event: serde_json::Value) -> Result<(), String> {
    if let Some(loader) = get_plugin_loader() {
        loader.dispatch_event(&plugin_id, &event)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn call_plugin_service(
    plugin_id: String,
    service: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(loader) = get_plugin_loader() {
        loader.call_plugin_service(&plugin_id, &service, &method, &params)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn enable_native_plugin(plugin_id: String, enabled: bool) -> Result<(), String> {
    if let Some(loader) = get_plugin_loader() {
        loader.set_plugin_enabled(&plugin_id, enabled)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn list_native_plugins() -> Result<Vec<PluginMetadata>, String> {
    if let Some(loader) = get_plugin_loader() {
        Ok(loader.list_plugins())
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[tauri::command]
async fn send_message_to_plugin(to: String, from: String, message: serde_json::Value) -> Result<(), String> {
    if let Some(loader) = get_plugin_loader() {
        loader.send_message(&to, &from, &message)
    } else {
        Err("Plugin loader not initialized".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 初始化 OS 插件
      app.handle().plugin(tauri_plugin_os::init())?;
      
      // 初始化 Dialog 插件
      app.handle().plugin(tauri_plugin_dialog::init())?;
      
      // 初始化 Shell 插件
      app.handle().plugin(tauri_plugin_shell::init())?;
      
      // 初始化 FS 插件（文件系统）
      app.handle().plugin(tauri_plugin_fs::init())?;

      // 使用 core 模块的自动回调设置
      bubblefish_core::tauri::setup_all_core_callbacks(app.handle().clone());
      
      // 初始化事件系统
      let event_emitter = bubblefish_core::tauri::TauriEventEmitter::new(app.handle().clone());
      bubblefish_core::tauri::EVENT_SYSTEM.register_emitter(
          "tauri".to_string(),
          Box::new(event_emitter)
      );
      
      // 初始化插件加载器
      init_plugin_loader(app.handle().clone());

      // 创建主窗口，根据操作系统使用不同的标题栏样式
      let window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("")  // 设置标题为空，使用自定义标题栏，如果标题栏有文字，在macOS上会遮挡
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .center();

      // 根据操作系统设置不同的标题栏样式和装饰
      let window_builder = if cfg!(target_os = "macos") {
        // macOS: 使用 Overlay 模式解决渲染遮挡问题
        #[cfg(target_os = "macos")]
        let window_builder = window_builder
          .decorations(true)
          .title_bar_style(TitleBarStyle::Overlay);
        #[cfg(not(target_os = "macos"))]
        let window_builder = window_builder.decorations(true);
        window_builder
      } else if cfg!(target_os = "windows") {
        // Windows: 启用装饰，不使用 macOS 特有的 title_bar_style
        window_builder
          .decorations(false)
      } else {
        // Linux: 禁用装饰，使用完全自定义标题栏
        window_builder.decorations(false)
      };

      let _window = window_builder.build()?;

      // 只为 macOS 创建系统原生菜单，Windows 使用虚拟菜单栏
      if cfg!(target_os = "macos") {
        create_native_menu(app)?;
      }
      
      Ok(())
    })
    .invoke_handler(bubblefish_core::generate_all_commands![
        open_image_file_dialog,
        open_multiple_image_files_dialog,
        open_text_file_dialog,
        save_project_to_path,
        get_project_file_path,
        read_file_content,
        scan_directory_for_images,
        get_app_info,
        update_menu_checked_state,
        update_menu_enabled_state,
        update_menu_text,
        load_native_plugin,
        unload_native_plugin,
        dispatch_event_to_plugin,
        call_plugin_service,
        enable_native_plugin,
        list_native_plugins,
        send_message_to_plugin
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn create_native_menu(app: &mut tauri::App) -> Result<(), tauri::Error> {
    // 创建导出子菜单
    let export_submenu = SubmenuBuilder::new(app, "导出")
        .id("export-submenu")
        .item(&MenuItemBuilder::new("Labelplus文件")
            .id("export-labelplus")
            .build(app)?)
        .build()?;

    // 创建文件菜单
    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&MenuItemBuilder::new("新建项目")
            .id("new-project")
            .accelerator("CmdOrCtrl+N")
            .build(app)?)
        .item(&MenuItemBuilder::new("打开项目")
            .id("open-project")
            .accelerator("CmdOrCtrl+O")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("保存")
            .id("save")
            .accelerator("CmdOrCtrl+S")
            .build(app)?)
        .item(&MenuItemBuilder::new("另存为...")
            .id("save-as")
            .accelerator("CmdOrCtrl+Shift+S")
            .build(app)?)
        .item(&export_submenu)
        .separator()
        .build()?;

    // 创建编辑菜单
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&MenuItemBuilder::new("撤销")
            .id("undo")
            .accelerator("CmdOrCtrl+Z")
            .build(app)?)
        .item(&MenuItemBuilder::new("重做")
            .id("redo")
            .accelerator("CmdOrCtrl+Shift+Z")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("上一个标记")
            .id("prev-marker")
            .accelerator("Shift+Tab")
            .build(app)?)
        .item(&MenuItemBuilder::new("下一个标记")
            .id("next-marker")
            .accelerator("Tab")
            .build(app)?)
        .build()?;

    // 创建视图菜单
    let window_menu = SubmenuBuilder::new(app, "视图")
        .item(&MenuItemBuilder::new("上一张图片")
            .id("prev-image")
            .accelerator("CmdOrCtrl+Left")
            .build(app)?)
        .item(&MenuItemBuilder::new("下一张图片")
            .id("next-image")
            .accelerator("CmdOrCtrl+Right")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("最小化")
            .id("minimize")
            .accelerator("CmdOrCtrl+M")
            .build(app)?)
        .item(&MenuItemBuilder::new("最大化")
            .id("maximize")
            .build(app)?)
        .separator()
        .item(&CheckMenuItemBuilder::new("翻译")
            .id("translation")
            .build(app)?)
        .item(&CheckMenuItemBuilder::new("缩略图")
            .id("thumbnail")
            .build(app)?)
        .item(&CheckMenuItemBuilder::new("词库")
            .id("dictionary")
            .build(app)?)
        .item(&CheckMenuItemBuilder::new("项目配置")
            .id("project-config")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("调试窗口")
            .id("debug")
            .accelerator("CmdOrCtrl+Shift+D")
            .build(app)?)
        .build()?;

    // 创建更多菜单
    let more_menu = SubmenuBuilder::new(app, "更多")
        .item(&MenuItemBuilder::new("快照")
            .id("snapshots")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("关于")
            .id("version-info")
            .build(app)?)
        .item(&MenuItemBuilder::new("软件许可")
            .id("software-license")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::new("退出Bubblefish")
            .id("quit")
            .accelerator("Cmd+Q")
            .build(app)?)
        .build()?;

    // 构建主菜单
    let menu = MenuBuilder::new(app)
        .items(&[&more_menu,&file_menu, &edit_menu, &window_menu])
        .build()?;

    // 设置应用菜单
    app.set_menu(menu)?;

    // 添加菜单事件处理器
    app.on_menu_event(move |app, event| {
        let event_name = match event.id().0.as_str() {
            "new-project" => "menu:file:new-project",
            "open-project" => "menu:file:open-project",
            "save" => "menu:file:save",
            "save-as" => "menu:file:save-as",
            "export-labelplus" => "menu:file:export",
            "quit" => "menu:more:quit",
            "undo" => "menu:edit:undo",
            "redo" => "menu:edit:redo",
            "prev-marker" => "menu:edit:prev-marker",
            "next-marker" => "menu:edit:next-marker",
            "prev-image" => "menu:view:prev-image",
            "next-image" => "menu:view:next-image",
            "minimize" => "menu:window:minimize",
            "maximize" => "menu:window:maximize",
            "translation" => "menu:window:translation",
            "thumbnail" => "menu:window:thumbnail",
            "dictionary" => "menu:window:dictionary",
            "project-config" => "menu:window:project-config",
            "debug" => "menu:window:debug",
            "snapshots" => "menu:more:snapshots",
            "version-info" => "menu:more:version-info",
            "software-license" => "menu:more:software-license",
            _ => {
                if cfg!(debug_assertions) {
                    println!("Unknown menu event: {}", event.id().0);
                }
                return; // 忽略未知的菜单项
            }
        };

        // 发送事件到前端
        if let Err(e) = app.emit(event_name, ()) {
            eprintln!("Failed to emit menu event {}: {}", event_name, e);
        }

        // 处理一些系统级的菜单操作
        match event.id().0.as_str() {
            "minimize" => {
                // 尝试不同的窗口名称
                let window_labels = ["main", "main-window", ""];
                for label in &window_labels {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.minimize();
                        break;
                    }
                }
            }
            "maximize" => {
                // 尝试不同的窗口名称
                let window_labels = ["main", "main-window", ""];
                for label in &window_labels {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = if window.is_maximized().unwrap_or(false) {
                            window.unmaximize()
                        } else {
                            window.maximize()
                        };
                        break;
                    }
                }
            }
            _ => {}
        }
    });

    Ok(())
}
