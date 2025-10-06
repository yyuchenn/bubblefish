// Re-export bunny types from plugin-sdk for use in core
pub use bubblefish_plugin_sdk::{OCRServiceInfo, TranslationServiceInfo};

use std::collections::HashMap;
use std::sync::RwLock;

use lazy_static::lazy_static;

use crate::common::EVENT_SYSTEM;

lazy_static! {
    pub static ref BUNNY_SERVICE_REGISTRY: RwLock<BunnyServiceRegistry> = RwLock::new(BunnyServiceRegistry::new());
}

pub struct BunnyServiceRegistry {
    ocr_services: HashMap<String, OCRServiceInfo>,
    translation_services: HashMap<String, TranslationServiceInfo>,
    service_to_plugin: HashMap<String, String>,
}

impl BunnyServiceRegistry {
    pub fn new() -> Self {
        Self {
            ocr_services: HashMap::new(),
            translation_services: HashMap::new(),
            service_to_plugin: HashMap::new(),
        }
    }

    fn emit_service_update_event(&self) {
        let payload = serde_json::json!({
            "ocr": self.get_ocr_services(),
            "translation": self.get_translation_services(),
        });

        let _ = EVENT_SYSTEM.emit_business_event(
            "plugins:bunny_services_updated".to_string(),
            payload,
        );
    }

    pub fn register_ocr_service(&mut self, plugin_id: String, service_info: OCRServiceInfo) -> Result<(), String> {
        self.service_to_plugin.insert(service_info.id.clone(), plugin_id);
        self.ocr_services.insert(service_info.id.clone(), service_info);
        self.emit_service_update_event();
        Ok(())
    }

    pub fn register_translation_service(&mut self, plugin_id: String, service_info: TranslationServiceInfo) -> Result<(), String> {
        self.service_to_plugin.insert(service_info.id.clone(), plugin_id);
        self.translation_services.insert(service_info.id.clone(), service_info);
        self.emit_service_update_event();
        Ok(())
    }

    pub fn unregister_service(&mut self, service_id: &str) -> Result<(), String> {
        self.service_to_plugin.remove(service_id);
        self.ocr_services.remove(service_id);
        self.translation_services.remove(service_id);
        self.emit_service_update_event();
        Ok(())
    }

    pub fn unregister_plugin_services(&mut self, plugin_id: &str) {
        let services_to_remove: Vec<String> = self.service_to_plugin
            .iter()
            .filter(|(_, pid)| *pid == plugin_id)
            .map(|(sid, _)| sid.clone())
            .collect();

        for service_id in services_to_remove {
            self.service_to_plugin.remove(&service_id);
            self.ocr_services.remove(&service_id);
            self.translation_services.remove(&service_id);
        }

        self.emit_service_update_event();
    }

    pub fn get_ocr_services(&self) -> Vec<serde_json::Value> {
        self.ocr_services.iter().map(|(service_id, service_info)| {
            let mut service_json = serde_json::to_value(service_info).unwrap_or(serde_json::json!({}));
            if let Some(obj) = service_json.as_object_mut() {
                if let Some(plugin_id) = self.service_to_plugin.get(service_id) {
                    obj.insert("plugin_id".to_string(), serde_json::json!(plugin_id));
                }
            }
            service_json
        }).collect()
    }

    pub fn get_translation_services(&self) -> Vec<serde_json::Value> {
        self.translation_services.iter().map(|(service_id, service_info)| {
            let mut service_json = serde_json::to_value(service_info).unwrap_or(serde_json::json!({}));
            if let Some(obj) = service_json.as_object_mut() {
                if let Some(plugin_id) = self.service_to_plugin.get(service_id) {
                    obj.insert("plugin_id".to_string(), serde_json::json!(plugin_id));
                }
            }
            service_json
        }).collect()
    }

    pub fn get_plugin_for_service(&self, service_id: &str) -> Option<String> {
        self.service_to_plugin.get(service_id).cloned()
    }
}