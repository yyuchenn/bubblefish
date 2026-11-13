//! Plugin-private, locally imported resource sets. Payloads use binary attachments.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MAX_LOCAL_RESOURCE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_LOCAL_RESOURCE_SET_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_LOCAL_RESOURCE_FILES: usize = 100;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginLocalResourceFile {
    pub path: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginLocalResourceImport {
    pub id: String,
    pub files: Vec<PluginLocalResourceFile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginLocalResourceSet {
    pub id: String,
    pub files: Vec<PluginLocalResourceFile>,
    #[ts(type = "number")]
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginLocalResourceImportToken {
    pub token: String,
}
