//! Public plugin DTOs. These deliberately do not depend on the document engine.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginRuntimeRole {
    #[default]
    Main,
    Hooks,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BeforeCommitHookInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub priority: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operations: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginGeometry {
    Point {
        x: f64,
        y: f64,
    },
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginTextMark {
    Bold,
    Italic,
    Strike,
    Emphasis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginTextRun {
    pub text: String,
    pub marks: Vec<PluginTextMark>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRichText {
    pub runs: Vec<PluginTextRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub raw: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum PluginTranslation {
    Text(String),
    RichText(PluginRichText),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarkerStyle {
    pub overlay_text: bool,
    pub horizontal: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarker {
    pub id: String,
    pub geometry: PluginGeometry,
    pub translation: PluginRichText,
    pub style: PluginMarkerStyle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bunny_cache: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginImage {
    pub id: String,
    pub asset_id: String,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checksum: Option<String>,
    pub markers: Vec<PluginMarker>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginDocument {
    pub id: String,
    pub name: String,
    pub source_language: String,
    pub target_language: String,
    pub images: Vec<PluginImage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginStagedImage {
    pub staged_resource: String,
    pub asset_id: String,
    pub width: u32,
    pub height: u32,
    pub checksum: String,
    pub filename: String,
    pub mime_type: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginImageRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Binary image bytes are attached to the RPC response, never serialized here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginImageRead {
    pub image: PluginImage,
    pub mime_type: String,
    pub byte_length: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub region: Option<PluginImageRegion>,
}

fn present_nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAssistancePatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub original_text: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub machine_translation: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub last_ocr_model: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub last_translation_service: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAssistanceExpected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub geometry: Option<PluginGeometry>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub original_text: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable_string"
    )]
    #[ts(optional, type = "string | null")]
    pub machine_translation: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_language: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum PluginOperation {
    #[serde(rename = "project.update")]
    ProjectUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        source_language: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target_language: Option<String>,
    },
    #[serde(rename = "image.create")]
    ImageCreate {
        id: String,
        staged_resource: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
    },
    #[serde(rename = "image.update")]
    ImageUpdate {
        image_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        staged_resource: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
    },
    #[serde(rename = "image.remove")]
    ImageRemove { image_id: String },
    #[serde(rename = "image.reorder")]
    ImageReorder { image_ids: Vec<String> },
    #[serde(rename = "marker.create")]
    MarkerCreate {
        image_id: String,
        marker: PluginMarker,
    },
    #[serde(rename = "marker.update")]
    MarkerUpdate {
        image_id: String,
        marker_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        geometry: Option<PluginGeometry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        translation: Option<PluginRichText>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        style: Option<PluginMarkerStyle>,
    },
    #[serde(rename = "marker.remove")]
    MarkerRemove { image_id: String, marker_id: String },
    #[serde(rename = "marker.reorder")]
    MarkerReorder {
        image_id: String,
        marker_ids: Vec<String>,
    },
    #[serde(rename = "translation.set")]
    TranslationSet {
        image_id: String,
        marker_id: String,
        value: PluginTranslation,
    },
    #[serde(rename = "translation.clear")]
    TranslationClear { image_id: String, marker_id: String },
    #[serde(rename = "assistance.update")]
    AssistanceUpdate {
        image_id: String,
        marker_id: String,
        patch: PluginAssistancePatch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected: Option<PluginAssistanceExpected>,
    },
    #[serde(rename = "assistance.clear")]
    AssistanceClear { image_id: String, marker_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginMutationOrigin {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub causation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginTransaction {
    pub project_id: String,
    pub label: String,
    pub operations: Vec<PluginOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_state_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub causation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginMutationProposal {
    pub project_id: String,
    pub transaction_id: String,
    pub base_state_id: String,
    pub origin: PluginMutationOrigin,
    pub operations: Vec<PluginOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub causation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BeforeCommitHookResult {
    Continue,
    Replace { operations: Vec<PluginOperation> },
    Reject { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHistoryEntry {
    pub entry_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<PluginMutationOrigin>,
    pub before_state_id: String,
    pub after_state_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHistoryPage {
    pub undo: Vec<PluginHistoryEntry>,
    pub redo: Vec<PluginHistoryEntry>,
    pub undo_total: u32,
    pub redo_total: u32,
    #[ts(type = "number")]
    pub history_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHistoryQuery {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginHistoryStack {
    Undo,
    Redo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginHistoryControl {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub expected_history_revision: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginEventOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub include_self: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntityChange {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub marker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginDocumentChangeEvent {
    pub project_id: String,
    pub transaction_id: String,
    pub command_id: String,
    pub origin: PluginMutationOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub causation_id: Option<String>,
    #[ts(type = "number")]
    pub revision: u64,
    pub before_state_id: String,
    pub after_state_id: String,
    pub changes: Vec<PluginEntityChange>,
}
