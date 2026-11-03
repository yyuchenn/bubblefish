use crate::model::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub command_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
    pub command: Command,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<HistoryMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_state_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    /// Atomic document operations. Nested batches and lifecycle/history commands
    /// are rejected; the state precondition is checked before applying any item.
    Batch {
        commands: Vec<Command>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_state_id: Option<String>,
    },
    CreateProject {
        document: ProjectDocument,
        #[serde(default)]
        saved: bool,
    },
    CloseProject,
    UpdateProject {
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
    AddImages {
        images: Vec<ImageDocument>,
    },
    UpdateImage {
        image_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        asset_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        width: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        height: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        checksum: Option<String>,
    },
    RemoveImage {
        image_id: String,
    },
    ReorderImages {
        image_ids: Vec<String>,
    },
    AddMarker {
        image_id: String,
        marker: Marker,
    },
    RemoveMarker {
        image_id: String,
        marker_id: String,
    },
    UpdateMarker {
        image_id: String,
        marker_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        geometry: Option<Geometry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        translation: Option<RichText>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        style: Option<MarkerStyle>,
    },
    UpdateAssistance {
        updates: Vec<AssistanceUpdate>,
    },
    ReorderMarkers {
        image_id: String,
        marker_ids: Vec<String>,
    },
    Undo,
    Redo,
    GuardedUndo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        expected_history_revision: Option<u64>,
    },
    GuardedRedo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        expected_history_revision: Option<u64>,
    },
    EndGroup,
    MarkSaved {
        state_id: String,
    },
}

/// Optional fields distinguish an omitted change from an explicit null (clear).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssistanceUpdate {
    pub image_id: String,
    pub marker_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected: Option<AssistanceExpected>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssistanceExpected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub geometry: Option<Geometry>,
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

fn present_nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_id: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<MutationOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<EditorBookmark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<EditorBookmark>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MutationOrigin {
    // Host-defined actor, for example user, plugin, assistance or history.
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryInfo {
    pub entry_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<MutationOrigin>,
    pub before_state_id: String,
    pub after_state_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub undo: Vec<HistoryEntryInfo>,
    pub redo: Vec<HistoryEntryInfo>,
    pub undo_total: u32,
    pub redo_total: u32,
    #[ts(type = "number")]
    pub history_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub command_id: String,
    #[ts(type = "number")]
    pub event_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub patch: Option<ProjectPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closed_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<CoreError>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub id: String,
    pub name: String,
    pub source_language: String,
    pub target_language: String,
    pub image_order: Vec<String>,
    // Arc is transparent on the wire and shares image nodes with history and
    // idempotent reply records instead of copying every marker again.
    pub upsert_images: Vec<std::sync::Arc<ImageDocument>>,
    pub removed_image_ids: Vec<String>,
    pub state_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub saved_state_id: Option<String>,
    pub can_undo: bool,
    pub can_redo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub undo_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub redo_label: Option<String>,
    pub history_depth: u32,
    #[ts(type = "number")]
    pub history_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub focus: Option<EditorBookmark>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}

impl CoreError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: None,
        }
    }
    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}
