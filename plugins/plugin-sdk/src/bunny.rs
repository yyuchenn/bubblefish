use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerGeometry {
    #[serde(rename = "markerType")]
    pub marker_type: String,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMarkerInfo {
    #[serde(rename = "markerId")]
    pub marker_id: u32,
    pub geometry: MarkerGeometry,
    #[serde(rename = "originalText")]
    pub original_text: Option<String>,
    #[serde(rename = "machineTranslation")]
    pub machine_translation: Option<String>,
    #[serde(rename = "userTranslation")]
    pub user_translation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCRContext {
    #[serde(rename = "markerId")]
    pub marker_id: u32,
    #[serde(rename = "imageId")]
    pub image_id: u32,
    #[serde(rename = "imageData")]
    pub image_data: Vec<u8>,
    #[serde(rename = "markerGeometry")]
    pub marker_geometry: MarkerGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationContext {
    #[serde(rename = "markerId")]
    pub marker_id: u32,
    #[serde(rename = "imageId")]
    pub image_id: u32,
    pub text: String,
    #[serde(rename = "allMarkers")]
    pub all_markers: Vec<PageMarkerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCROptions {
    pub language: Option<String>,
    pub enhance_image: bool,
    pub dpi: Option<u32>,
}

impl Default for OCROptions {
    fn default() -> Self {
        Self {
            language: None,
            enhance_image: false,
            dpi: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationOptions {
    pub source_language: Option<String>,
    pub target_language: String,
    pub preserve_formatting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OCRResult {
    pub text: String,
    pub confidence: Option<f32>,
    pub language: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationResult {
    pub translated_text: String,
    pub source_language: Option<String>,
    pub confidence: Option<f32>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceCapabilities {
    pub id: String,
    pub name: String,
    pub version: String,
    pub supported_languages: Vec<String>,
}

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

/// Trait for plugins that provide OCR services
pub trait OCRProvider: Send + Sync {
    /// Get information about this OCR service
    fn get_info(&self) -> OCRServiceInfo;

    /// Process an image and extract text with full context
    fn process_ocr(&self, context: OCRContext, options: OCROptions) -> Result<OCRResult, String>;

    /// Check if the service is available and properly configured
    fn is_available(&self) -> bool {
        true
    }

    /// Validate options before processing
    fn validate_options(&self, _options: &OCROptions) -> Result<(), String> {
        Ok(())
    }
}

/// Trait for plugins that provide translation services
pub trait TranslationProvider: Send + Sync {
    /// Get information about this translation service
    fn get_info(&self) -> TranslationServiceInfo;

    /// Translate text with full context
    fn translate(&self, context: TranslationContext, options: TranslationOptions) -> Result<TranslationResult, String>;

    /// Check if the service is available and properly configured
    fn is_available(&self) -> bool {
        true
    }

    /// Detect the language of the input text
    fn detect_language(&self, _text: &str) -> Result<String, String> {
        Err("Language detection not supported".to_string())
    }

    /// Validate options before translation
    fn validate_options(&self, _options: &TranslationOptions) -> Result<(), String> {
        Ok(())
    }
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