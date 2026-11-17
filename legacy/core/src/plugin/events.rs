use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PluginEventType {
    MarkerSelected,
    MarkerDeselected,
    MarkerCreated,
    MarkerDeleted,
    MarkerUpdated,
    ImageSelected,
    ImageDeselected,
    ProjectOpened,
    ProjectClosed,
    Custom(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEvent {
    pub event_type: PluginEventType,
    pub plugin_id: Option<String>,
    pub data: Value,
    pub timestamp: u64,
}

impl PluginEvent {
    pub fn new(event_type: PluginEventType, data: Value) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        
        Self {
            event_type,
            plugin_id: None,
            data,
            timestamp,
        }
    }

    pub fn from_plugin(plugin_id: String, event_type: PluginEventType, data: Value) -> Self {
        let mut event = Self::new(event_type, data);
        event.plugin_id = Some(plugin_id);
        event
    }
}

pub fn convert_domain_event_to_plugin_event(domain_event: &crate::service::events::DomainEvent) -> Option<PluginEvent> {
    use crate::service::events::DomainEvent;
    
    match domain_event {
        DomainEvent::MarkerDeleted(marker_id) => {
            Some(PluginEvent::new(
                PluginEventType::MarkerDeleted,
                serde_json::json!({ "marker_id": marker_id })
            ))
        }
        DomainEvent::MarkerUpdated(marker) => {
            Some(PluginEvent::new(
                PluginEventType::MarkerUpdated,
                serde_json::json!({ 
                    "marker_id": marker.0  // MarkerId is a tuple struct
                })
            ))
        }
        DomainEvent::ProjectCreated(project_id, name) => {
            Some(PluginEvent::new(
                PluginEventType::ProjectOpened,
                serde_json::json!({ 
                    "project_id": project_id.0,  // ProjectId is a tuple struct
                    "project_name": name
                })
            ))
        }
        _ => None
    }
}