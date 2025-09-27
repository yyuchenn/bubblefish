use serde::{Deserialize, Serialize};

// OCR and Translation Options for plugins

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCROptions {
    pub source_language: Option<String>,
}

impl Default for OCROptions {
    fn default() -> Self {
        Self {
            source_language: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationOptions {
    pub source_language: Option<String>,
    pub target_language: String,
}

// Service Info structures for registration

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCRServiceInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub supported_languages: Vec<String>,
    pub supported_image_formats: Vec<String>,
    pub max_image_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationServiceInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source_languages: Vec<String>,
    pub target_languages: Vec<String>,
    pub supports_auto_detect: bool,
    pub max_text_length: Option<usize>,
}

/// Registration info for bunny services
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BunnyServiceRegistration {
    OCR(OCRServiceInfo),
    Translation(TranslationServiceInfo),
}

/// Events emitted by bunny service providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BunnyProviderEvent {
    ServiceRegistered(BunnyServiceRegistration),
    ServiceUnregistered { service_id: String },
    ProcessingStarted { task_id: String, service_id: String },
    ProcessingProgress { task_id: String, progress: u8 },
    ProcessingCompleted { task_id: String, success: bool },
}