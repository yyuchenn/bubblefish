//! Tauri boundary: files and protocol frames use raw binary IPC, never JSON byte arrays.
use crate::{
    header,
    plugin_host::{InstalledPlugin, NativePluginEvent, PluginManager},
    raw,
};
use bubblefish_plugin_protocol::{
    PluginLocalResourceImport, PluginLocalResourceImportToken, PluginLocalResourceSet,
    PluginManifest, PluginRuntimeRole,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{Channel, Request, Response};

type PluginState<'a> = tauri::State<'a, Arc<PluginManager>>;
fn resource_permission(
    manager: &PluginManager,
    plugin_id: &str,
    write: bool,
) -> Result<(), String> {
    let plugin = manager.store.get(plugin_id)?;
    let permission = if write {
        "resources.local.write"
    } else {
        "resources.local.read"
    };
    if !plugin
        .manifest
        .permissions
        .iter()
        .flatten()
        .any(|value| value == permission)
    {
        return Err(format!("Plugin has not declared {permission}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_resource_begin(
    state: PluginState<'_>,
    plugin_id: String,
    owner: String,
    input: PluginLocalResourceImport,
) -> Result<PluginLocalResourceImportToken, String> {
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &plugin_id, true)?;
        manager
            .resources
            .begin(&plugin_id, &owner, input)
            .map(|token| PluginLocalResourceImportToken { token })
    })
    .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceChunk {
    plugin_id: String,
    owner: String,
    token: String,
    path: String,
    offset: u64,
}
#[tauri::command]
pub async fn plugin_resource_write(
    state: PluginState<'_>,
    request: Request<'_>,
) -> Result<(), String> {
    let input: ResourceChunk = options(&request)?;
    let bytes = raw(&request)?;
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &input.plugin_id, true)?;
        manager.resources.write(
            &input.plugin_id,
            &input.owner,
            &input.token,
            &input.path,
            input.offset,
            &bytes,
        )
    })
    .await
}
#[tauri::command]
pub async fn plugin_resource_commit(
    state: PluginState<'_>,
    plugin_id: String,
    owner: String,
    token: String,
) -> Result<PluginLocalResourceSet, String> {
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &plugin_id, true)?;
        manager.resources.commit(&plugin_id, &owner, &token)
    })
    .await
}
#[tauri::command]
pub async fn plugin_resource_abort(
    state: PluginState<'_>,
    plugin_id: String,
    owner: String,
    token: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.resources.abort(&plugin_id, &owner, &token)).await
}
#[tauri::command]
pub async fn plugin_resource_list(
    state: PluginState<'_>,
    plugin_id: String,
) -> Result<Vec<PluginLocalResourceSet>, String> {
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &plugin_id, false)?;
        manager.resources.list(&plugin_id)
    })
    .await
}
#[tauri::command]
pub async fn plugin_resource_read(
    state: PluginState<'_>,
    plugin_id: String,
    id: String,
    path: String,
) -> Result<Response, String> {
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &plugin_id, false)?;
        manager
            .resources
            .read(&plugin_id, &id, &path)
            .map(Response::new)
    })
    .await
}
#[tauri::command]
pub async fn plugin_resource_remove(
    state: PluginState<'_>,
    plugin_id: String,
    id: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || {
        resource_permission(&manager, &plugin_id, true)?;
        manager.resources.remove(&plugin_id, &id)
    })
    .await
}
#[tauri::command]
pub async fn plugin_resource_release_owner(
    state: PluginState<'_>,
    plugin_id: String,
    owner: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.resources.release_owner(&plugin_id, &owner)).await
}
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
}
fn options<T: serde::de::DeserializeOwned>(request: &Request<'_>) -> Result<T, String> {
    let value = header(request, "x-bf-options")?;
    let value = percent_encoding::percent_decode_str(&value)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&value).map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub struct InstallToken {
    token: String,
}
#[tauri::command]
pub async fn plugin_install_begin(
    state: PluginState<'_>,
    manifest: PluginManifest,
) -> Result<InstallToken, String> {
    let manager = state.inner().clone();
    blocking(move || {
        manager
            .store
            .begin(manifest)
            .map(|token| InstallToken { token })
    })
    .await
}
#[derive(Deserialize)]
struct InstallFile {
    token: String,
    path: String,
}
#[tauri::command]
pub async fn plugin_install_file(
    state: PluginState<'_>,
    request: Request<'_>,
) -> Result<(), String> {
    let options: InstallFile = options(&request)?;
    let bytes = raw(&request)?;
    let manager = state.inner().clone();
    blocking(move || {
        manager
            .store
            .write_file(&options.token, &options.path, &bytes)
    })
    .await
}
#[tauri::command]
pub async fn plugin_install_commit(
    state: PluginState<'_>,
    token: String,
) -> Result<InstalledPlugin, String> {
    let manager = state.inner().clone();
    blocking(move || manager.store.commit(&token)).await
}
#[tauri::command]
pub async fn plugin_install_abort(state: PluginState<'_>, token: String) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.store.abort(&token)).await
}
#[tauri::command]
pub async fn plugin_list(state: PluginState<'_>) -> Result<Vec<InstalledPlugin>, String> {
    let manager = state.inner().clone();
    blocking(move || manager.store.list()).await
}
#[tauri::command]
pub async fn plugin_read_file(
    state: PluginState<'_>,
    plugin_id: String,
    path: String,
) -> Result<Response, String> {
    let manager = state.inner().clone();
    blocking(move || {
        manager
            .store
            .read_file(&plugin_id, &path)
            .map(Response::new)
    })
    .await
}
#[tauri::command]
pub async fn plugin_set_state(
    state: PluginState<'_>,
    plugin_id: String,
    enabled: Option<bool>,
    config: Option<Value>,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.store.set_state(&plugin_id, enabled, config)).await
}
#[tauri::command]
pub async fn plugin_remove(state: PluginState<'_>, plugin_id: String) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.remove(&plugin_id)).await
}
#[tauri::command]
pub fn plugin_native_target() -> &'static str {
    env!("BF_NATIVE_TARGET")
}
#[tauri::command]
pub async fn plugin_reset_runtime(state: PluginState<'_>) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.reset()).await
}
#[tauri::command]
pub async fn plugin_panel_url(
    state: PluginState<'_>,
    plugin_id: String,
    panel_id: String,
) -> Result<String, String> {
    let manager = state.inner().clone();
    blocking(move || {
        let plugin = manager.store.get(&plugin_id)?;
        if !plugin
            .manifest
            .contributes
            .panels
            .iter()
            .flatten()
            .any(|panel| panel.id == panel_id)
        {
            return Err("Plugin panel is not registered".into());
        }
        let base = if cfg!(target_os = "windows") {
            "http://bf-plugin.localhost"
        } else {
            "bf-plugin://localhost"
        };
        Ok(format!("{base}/{plugin_id}/{panel_id}"))
    })
    .await
}
#[tauri::command]
pub async fn plugin_native_start(
    state: PluginState<'_>,
    plugin_id: String,
    generation: String,
    runtime_role: Option<PluginRuntimeRole>,
    on_message: Channel<Response>,
    on_event: Channel<NativePluginEvent>,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || {
        manager.start_role(
            plugin_id,
            generation,
            runtime_role.unwrap_or_default(),
            env!("BF_NATIVE_TARGET"),
            Arc::new(move |bytes| {
                on_message
                    .send(Response::new(bytes))
                    .map_err(|e| e.to_string())
            }),
            Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        )
    })
    .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFrame {
    plugin_id: String,
    generation: String,
    #[serde(default)]
    runtime_role: PluginRuntimeRole,
}
#[tauri::command]
pub async fn plugin_native_send(
    state: PluginState<'_>,
    request: Request<'_>,
) -> Result<(), String> {
    let options: SendFrame = options(&request)?;
    let bytes = raw(&request)?;
    let manager = state.inner().clone();
    blocking(move || {
        manager.send_role(
            &options.plugin_id,
            &options.generation,
            options.runtime_role,
            &bytes,
        )
    })
    .await
}
#[tauri::command]
pub async fn plugin_native_stop(
    state: PluginState<'_>,
    plugin_id: String,
    generation: String,
    runtime_role: Option<PluginRuntimeRole>,
) -> Result<(), String> {
    let manager = state.inner().clone();
    blocking(move || manager.stop_role(&plugin_id, &generation, runtime_role.unwrap_or_default()))
        .await
}
