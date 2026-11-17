//! Presentation-only panel metadata; never part of project documents or plugin configuration.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginPanelColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelThemeTokens {
    pub background: String,
    pub surface: String,
    pub surface_hover: String,
    pub text: String,
    pub strong: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub accent_soft: String,
    pub danger: String,
    pub font_family: String,
    pub font_size: String,
    pub radius: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelAppearance {
    pub revision: u32,
    pub theme: String,
    pub color_scheme: PluginPanelColorScheme,
    pub tokens: PluginPanelThemeTokens,
}
