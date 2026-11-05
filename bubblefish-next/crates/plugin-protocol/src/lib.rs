//! Transport-independent plugin contracts. Binary payloads travel beside JSON.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
};
use ts_rs::TS;
mod document;
pub use document::*;
mod resources;
pub use resources::*;
mod theme;
pub use theme::*;

pub const PLUGIN_API_VERSION: u32 = 1;
pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BINARY_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub entrypoints: PluginEntrypoints,
    pub contributes: PluginContributions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permissions: Option<Vec<String>>,
    /// Opt-in activation for plugins without a provider, command or panel trigger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_events: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntrypoints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub web: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, string>")]
    pub native: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before_commit_hooks: Option<Vec<BeforeCommitHookInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ocr: Option<Vec<ProviderInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub translation: Option<Vec<ProviderInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub commands: Option<Vec<CommandInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panels: Option<Vec<PanelInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub configuration: Option<Vec<ConfigField>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub languages: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub id: String,
    pub title: String,
}

/// Additive v1 command request parameters; legacy callers omit task_id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandInvocation {
    pub command_id: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskProgress {
    pub task_id: String,
    pub progress: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskSummary {
    pub task_id: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelInfo {
    pub id: String,
    pub title: String,
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub location: Option<PanelLocation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PanelLocation {
    Modal,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub field_type: ConfigFieldType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConfigFieldType {
    String,
    Number,
    Boolean,
    Secret,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BinaryAttachment {
    pub byte_length: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequest {
    pub api_version: u32,
    pub id: String,
    pub method: String,
    pub params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub binary: Option<BinaryAttachment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginResponse {
    pub api_version: u32,
    pub id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[ts(optional)]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<PluginRpcError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub binary: Option<BinaryAttachment>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginEvent {
    pub api_version: u32,
    pub event: String,
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub binary: Option<BinaryAttachment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginMessage {
    Request(PluginRequest),
    Response(PluginResponse),
    Event(PluginEvent),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<Value>,
}

impl PluginRpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}
impl std::fmt::Display for PluginRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for PluginRpcError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginPlatform {
    Web,
    Native,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHandshakeRequest {
    pub api_version: u32,
    pub plugin_id: String,
    pub host_version: String,
    pub platform: PluginPlatform,
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_role: Option<PluginRuntimeRole>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHandshakeResponse {
    pub api_version: u32,
    pub plugin_id: String,
    pub features: Vec<String>,
}

pub fn validate_package_path(path: &str) -> Result<(), PluginRpcError> {
    if path.is_empty()
        || path.contains(['\\', ':', '\0', '?', '#', '%'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(PluginRpcError::new(
            "invalidPath",
            "Package paths must be normalized relative paths",
        ));
    }
    Ok(())
}

pub fn validate_manifest(manifest: &PluginManifest) -> Result<(), PluginRpcError> {
    let valid_id = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            && value.as_bytes()[0].is_ascii_alphanumeric()
    };
    if manifest.api_version != PLUGIN_API_VERSION {
        return Err(PluginRpcError::new(
            "incompatibleApi",
            "Unsupported plugin API version",
        ));
    }
    if manifest.activation_events.iter().flatten().any(|event| {
        !matches!(
            event.as_str(),
            "startup"
                | "event:context.changed"
                | "event:document.changed"
                | "event:project.closed"
                | "event:images.changed"
                | "event:markers.changed"
                | "event:translations.changed"
                | "event:assistance.changed"
                | "event:history.changed"
                | "event:transaction.completed"
                | "event:transaction.committed"
                | "event:image.added"
                | "event:image.updated"
                | "event:image.removed"
                | "event:images.reordered"
                | "event:marker.added"
                | "event:marker.updated"
                | "event:marker.removed"
                | "event:markers.reordered"
                | "event:translation.changed"
                | "event:project.opened"
        )
    }) {
        return Err(PluginRpcError::new(
            "invalidManifest",
            "Unsupported plugin activation event",
        ));
    }
    if !valid_id(&manifest.id)
        || manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
    {
        return Err(PluginRpcError::new(
            "invalidManifest",
            "Plugin id, name and version are required",
        ));
    }
    if manifest.entrypoints.web.is_none()
        && manifest
            .entrypoints
            .native
            .as_ref()
            .is_none_or(BTreeMap::is_empty)
    {
        return Err(PluginRpcError::new(
            "invalidManifest",
            "At least one plugin entrypoint is required",
        ));
    }
    if let Some(web) = &manifest.entrypoints.web {
        validate_package_path(web)?;
    }
    for (target, path) in manifest.entrypoints.native.iter().flatten() {
        if !valid_id(target) {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Invalid native target",
            ));
        }
        validate_package_path(path)?;
    }
    let mut ids = std::collections::HashSet::new();
    for provider in manifest
        .contributes
        .ocr
        .iter()
        .flatten()
        .chain(manifest.contributes.translation.iter().flatten())
    {
        if !valid_id(&provider.id)
            || provider.name.trim().is_empty()
            || !ids.insert(provider.id.as_str())
        {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Provider IDs must be unique and have names",
            ));
        }
    }
    let mut commands = std::collections::HashSet::new();
    let mut hooks = std::collections::HashSet::new();
    for hook in manifest.contributes.before_commit_hooks.iter().flatten() {
        if !valid_id(&hook.id) || !hooks.insert(&hook.id) {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Hook IDs must be valid and unique",
            ));
        }
    }
    if !hooks.is_empty()
        && !manifest
            .permissions
            .iter()
            .flatten()
            .any(|permission| permission == "document.intercept")
    {
        return Err(PluginRpcError::new(
            "invalidManifest",
            "Commit hooks require document.intercept permission",
        ));
    }
    for command in manifest.contributes.commands.iter().flatten() {
        if !valid_id(&command.id)
            || command.title.trim().is_empty()
            || !commands.insert(&command.id)
        {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Command IDs must be unique and have titles",
            ));
        }
    }
    let mut panels = std::collections::HashSet::new();
    for panel in manifest.contributes.panels.iter().flatten() {
        if !valid_id(&panel.id) || panel.title.trim().is_empty() || !panels.insert(&panel.id) {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Panel IDs must be unique and have titles",
            ));
        }
        validate_package_path(&panel.entry)?;
    }
    let mut fields = std::collections::HashSet::new();
    for field in manifest.contributes.configuration.iter().flatten() {
        if !valid_id(&field.key) || field.label.trim().is_empty() || !fields.insert(&field.key) {
            return Err(PluginRpcError::new(
                "invalidManifest",
                "Configuration keys must be unique and have labels",
            ));
        }
        if let Some(value) = &field.default {
            let valid = match field.field_type {
                ConfigFieldType::String | ConfigFieldType::Secret => value.is_string(),
                ConfigFieldType::Number => value.is_number(),
                ConfigFieldType::Boolean => value.is_boolean(),
            };
            if !valid {
                return Err(PluginRpcError::new(
                    "invalidManifest",
                    "Configuration default has the wrong type",
                ));
            }
        }
    }
    Ok(())
}

/// One logical async message, with a separate attachment rather than a JSON byte array.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub message: PluginMessage,
    pub binary: Vec<u8>,
}

impl Frame {
    pub fn validate(&self) -> io::Result<()> {
        validate_message(&self.message, self.binary.len())
    }
}

/// Validate a message without copying its separately owned binary attachment.
pub fn validate_message(message: &PluginMessage, binary_len: usize) -> io::Result<()> {
    let (version, attachment) = match message {
        PluginMessage::Request(request) => {
            if request.id.is_empty() || request.method.is_empty() {
                return Err(invalid("Request id and method are required"));
            }
            (request.api_version, &request.binary)
        }
        PluginMessage::Response(response) => {
            if response.id.is_empty() || response.result.is_some() == response.error.is_some() {
                return Err(invalid(
                    "Response requires an id and exactly one result or error",
                ));
            }
            (response.api_version, &response.binary)
        }
        PluginMessage::Event(event) => {
            if event.event.is_empty() {
                return Err(invalid("Event name is required"));
            }
            (event.api_version, &event.binary)
        }
    };
    if version != PLUGIN_API_VERSION {
        return Err(invalid("Unsupported plugin API version"));
    }
    if binary_len > MAX_BINARY_BYTES {
        return Err(invalid("Plugin binary payload is too large"));
    }
    let declared = attachment
        .as_ref()
        .map(|attachment| attachment.byte_length as usize)
        .unwrap_or(0);
    if declared != binary_len {
        return Err(invalid("Binary attachment length does not match payload"));
    }
    Ok(())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 8];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let json_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
    let binary_len = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if json_len == 0 || json_len > MAX_JSON_BYTES || binary_len > MAX_BINARY_BYTES {
        return Err(invalid("Plugin frame exceeds size limits"));
    }
    let mut json = vec![0; json_len];
    reader.read_exact(&mut json)?;
    let message = serde_json::from_slice(&json).map_err(|error| invalid(&error.to_string()))?;
    validate_message(&message, binary_len)?;
    let mut binary = vec![0; binary_len];
    reader.read_exact(&mut binary)?;
    let frame = Frame { message, binary };
    frame.validate()?;
    Ok(Some(frame))
}

pub fn write_frame<W: Write>(writer: &mut W, frame: &Frame) -> io::Result<()> {
    frame.validate()?;
    let json = serde_json::to_vec(&frame.message).map_err(|error| invalid(&error.to_string()))?;
    if json.len() > MAX_JSON_BYTES {
        return Err(invalid("Plugin control payload is too large"));
    }
    writer.write_all(&(json.len() as u32).to_le_bytes())?;
    writer.write_all(&(frame.binary.len() as u32).to_le_bytes())?;
    writer.write_all(&json)?;
    writer.write_all(&frame.binary)?;
    writer.flush()
}

pub fn encode_frame(frame: &Frame) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, frame)?;
    Ok(bytes)
}

pub fn decode_frame(bytes: &[u8]) -> io::Result<Frame> {
    let mut reader = io::Cursor::new(bytes);
    let frame = read_frame(&mut reader)?.ok_or_else(|| invalid("Plugin frame is empty"))?;
    if reader.position() != bytes.len() as u64 {
        return Err(invalid("Unexpected trailing frame bytes"));
    }
    Ok(frame)
}
