use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocument {
    pub id: String,
    pub name: String,
    pub source_language: String,
    pub target_language: String,
    pub images: Vec<ImageDocument>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImageDocument {
    pub id: String,
    pub asset_id: String,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checksum: Option<String>,
    pub markers: Vec<Marker>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub geometry: Geometry,
    pub translation: RichText,
    pub style: MarkerStyle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bunny_cache: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Geometry {
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

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RichText {
    pub runs: Vec<TextRun>,
    /// Legacy text that was not confidently decoded. Exporters preserve it until edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub raw: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub text: String,
    pub marks: Vec<TextMark>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextMark {
    Bold,
    Italic,
    Strike,
    Emphasis,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarkerStyle {
    pub overlay_text: bool,
    pub horizontal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorBookmark {
    pub image_id: String,
    pub marker_id: String,
    pub anchor: u32,
    pub head: u32,
    pub stored_marks: Vec<TextMark>,
    /// Omitted for text history. False navigates without stealing editor focus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub focus_editor: Option<bool>,
}
