use std::sync::{Arc, RwLock};
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCRServiceInfo {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    pub supported_languages: Vec<String>,
    pub supported_image_formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationServiceInfo {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    pub source_languages: Vec<String>,
    pub target_languages: Vec<String>,
    pub supports_auto_detect: bool,
}

#[derive(Debug, Clone)]
pub struct BunnyPluginManager {
    ocr_services: Arc<RwLock<HashMap<String, OCRServiceInfo>>>,
    translation_services: Arc<RwLock<HashMap<String, TranslationServiceInfo>>>,
    // Map from service ID to plugin ID for routing
    service_to_plugin: Arc<RwLock<HashMap<String, String>>>,
}

impl BunnyPluginManager {
    pub fn new() -> Self {
        Self {
            ocr_services: Arc::new(RwLock::new(HashMap::new())),
            translation_services: Arc::new(RwLock::new(HashMap::new())),
            service_to_plugin: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register_ocr_service(&self, info: OCRServiceInfo) -> Result<(), String> {
        let service_id = info.id.clone();
        let plugin_id = info.plugin_id.clone();

        let mut services = self.ocr_services.write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

        if services.contains_key(&service_id) {
            return Err(format!("OCR service '{}' already registered", service_id));
        }

        services.insert(service_id.clone(), info);

        let mut mapping = self.service_to_plugin.write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;
        mapping.insert(service_id, plugin_id);

        Ok(())
    }

    pub fn register_translation_service(&self, info: TranslationServiceInfo) -> Result<(), String> {
        let service_id = info.id.clone();
        let plugin_id = info.plugin_id.clone();

        let mut services = self.translation_services.write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

        if services.contains_key(&service_id) {
            return Err(format!("Translation service '{}' already registered", service_id));
        }

        services.insert(service_id.clone(), info);

        let mut mapping = self.service_to_plugin.write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;
        mapping.insert(service_id, plugin_id);

        Ok(())
    }

    pub fn unregister_service(&self, service_id: &str) -> Result<(), String> {
        // Try to remove from OCR services
        if let Ok(mut services) = self.ocr_services.write() {
            if services.remove(service_id).is_some() {
                if let Ok(mut mapping) = self.service_to_plugin.write() {
                    mapping.remove(service_id);
                }
                return Ok(());
            }
        }

        // Try to remove from translation services
        if let Ok(mut services) = self.translation_services.write() {
            if services.remove(service_id).is_some() {
                if let Ok(mut mapping) = self.service_to_plugin.write() {
                    mapping.remove(service_id);
                }
                return Ok(());
            }
        }

        Err(format!("Service '{}' not found", service_id))
    }

    pub fn unregister_plugin_services(&self, plugin_id: &str) -> Result<(), String> {
        // Remove all services from this plugin
        let mut removed_count = 0;

        // Remove OCR services
        if let Ok(mut services) = self.ocr_services.write() {
            let to_remove: Vec<String> = services
                .iter()
                .filter(|(_, info)| info.plugin_id == plugin_id)
                .map(|(id, _)| id.clone())
                .collect();

            for id in to_remove {
                services.remove(&id);
                if let Ok(mut mapping) = self.service_to_plugin.write() {
                    mapping.remove(&id);
                }
                removed_count += 1;
            }
        }

        // Remove translation services
        if let Ok(mut services) = self.translation_services.write() {
            let to_remove: Vec<String> = services
                .iter()
                .filter(|(_, info)| info.plugin_id == plugin_id)
                .map(|(id, _)| id.clone())
                .collect();

            for id in to_remove {
                services.remove(&id);
                if let Ok(mut mapping) = self.service_to_plugin.write() {
                    mapping.remove(&id);
                }
                removed_count += 1;
            }
        }

        if removed_count > 0 {
            Ok(())
        } else {
            Err(format!("No services found for plugin '{}'", plugin_id))
        }
    }

    pub fn get_ocr_services(&self) -> Vec<OCRServiceInfo> {
        self.ocr_services
            .read()
            .ok()
            .map(|services| services.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_translation_services(&self) -> Vec<TranslationServiceInfo> {
        self.translation_services
            .read()
            .ok()
            .map(|services| services.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_ocr_service(&self, service_id: &str) -> Option<OCRServiceInfo> {
        self.ocr_services
            .read()
            .ok()
            .and_then(|services| services.get(service_id).cloned())
    }

    pub fn get_translation_service(&self, service_id: &str) -> Option<TranslationServiceInfo> {
        self.translation_services
            .read()
            .ok()
            .and_then(|services| services.get(service_id).cloned())
    }

    pub fn get_plugin_for_service(&self, service_id: &str) -> Option<String> {
        self.service_to_plugin
            .read()
            .ok()
            .and_then(|mapping| mapping.get(service_id).cloned())
    }

    pub fn list_all_services(&self) -> (Vec<OCRServiceInfo>, Vec<TranslationServiceInfo>) {
        (self.get_ocr_services(), self.get_translation_services())
    }

    /// Process OCR request through a plugin
    pub fn process_ocr_with_plugin(
        &self,
        service_id: &str,
        marker_id: u32,
        image_data: Vec<u8>,
    ) -> Result<String, String> {
        // Get the plugin ID for this service
        let plugin_id = self.get_plugin_for_service(service_id)
            .ok_or_else(|| format!("No plugin found for service '{}'", service_id))?;

        // Get the OCR service info
        let _service_info = self.get_ocr_service(service_id)
            .ok_or_else(|| format!("OCR service '{}' not found", service_id))?;

        // Send message to plugin to process OCR
        #[cfg(feature = "wasm")]
        {
            use serde_json::json;

            let _message = json!({
                "type": "ocr_request",
                "marker_id": marker_id,
                "image_data": image_data,
                "service_id": service_id
            });

            // TODO: Implement plugin message sending when PLUGIN_SYSTEM is available
            // For now, we'll process synchronously through the plugin's message handler

            // For now, return a placeholder - the actual result will come via event
            Ok(format!("OCR processing by plugin '{}' initiated", plugin_id))
        }

        #[cfg(not(feature = "wasm"))]
        {
            // In non-WASM environment, we don't have plugin support yet
            Err("Plugin OCR not supported in non-WASM environment".to_string())
        }
    }

    /// Process translation request through a plugin
    pub fn process_translation_with_plugin(
        &self,
        service_id: &str,
        marker_id: u32,
        text: String,
        source_lang: Option<String>,
        target_lang: String,
    ) -> Result<String, String> {
        // Get the plugin ID for this service
        let plugin_id = self.get_plugin_for_service(service_id)
            .ok_or_else(|| format!("No plugin found for service '{}'", service_id))?;

        // Get the translation service info
        let _service_info = self.get_translation_service(service_id)
            .ok_or_else(|| format!("Translation service '{}' not found", service_id))?;

        // Send message to plugin to process translation
        #[cfg(feature = "wasm")]
        {
            use serde_json::json;

            let _message = json!({
                "type": "translation_request",
                "marker_id": marker_id,
                "text": text,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "service_id": service_id
            });

            // TODO: Implement plugin message sending when PLUGIN_SYSTEM is available
            // For now, we'll process synchronously through the plugin's message handler

            // For now, return a placeholder - the actual result will come via event
            Ok(format!("Translation processing by plugin '{}' initiated", plugin_id))
        }

        #[cfg(not(feature = "wasm"))]
        {
            // In non-WASM environment, we don't have plugin support yet
            Err("Plugin translation not supported in non-WASM environment".to_string())
        }
    }
}

// Global singleton instance
use once_cell::sync::Lazy;
pub static BUNNY_PLUGIN_MANAGER: Lazy<BunnyPluginManager> = Lazy::new(BunnyPluginManager::new);