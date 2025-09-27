// Bunny (海兔) module - OCR and translation service types
// Plugin-based architecture: actual processing happens in plugins

mod types;

pub use types::{OCRServiceInfo, TranslationServiceInfo, BUNNY_SERVICE_REGISTRY};

use std::sync::Arc;
use crate::service::events::EventBus;

pub struct BunnyService {
    _event_bus: Arc<EventBus>,
}

impl BunnyService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            _event_bus: event_bus,
        }
    }
}