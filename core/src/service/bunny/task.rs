use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use serde::{Deserialize, Serialize};
use crate::common::{MarkerId, ImageId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OCRModel {
    Default,
    Tesseract,
    PaddleOCR,
    EasyOCR,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TranslationService {
    Default,
    Google,
    DeepL,
    ChatGPT,
    Baidu,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskType {
    OCR,
    Translation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskStatus {
    Queued,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunnyTask {
    pub id: String,
    pub marker_id: MarkerId,
    pub image_id: ImageId,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub model: Option<OCRModel>,
    pub service: Option<TranslationService>,
    pub source_lang: Option<String>,
    pub target_lang: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub progress: Option<u8>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
}

pub struct QueuedTask {
    pub task: BunnyTask,
    pub cancellation_token: Arc<AtomicBool>,
}

pub struct ActiveTask {
    pub task: BunnyTask,
    pub cancellation_token: Arc<AtomicBool>,
    pub progress: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunnyTaskEvent {
    pub event_type: String,
    pub task_id: String,
    pub marker_id: MarkerId,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub progress: Option<u8>,
    pub data: Option<serde_json::Value>,
}

impl BunnyTask {
    pub fn new_ocr(
        id: String,
        marker_id: MarkerId,
        image_id: ImageId,
        model: OCRModel,
    ) -> Self {
        Self {
            id,
            marker_id,
            image_id,
            task_type: TaskType::OCR,
            status: TaskStatus::Queued,
            model: Some(model),
            service: None,
            source_lang: None,
            target_lang: None,
            result: None,
            error: None,
            progress: None,
            created_at: crate::common::get_timestamp_millis(),
            started_at: None,
            completed_at: None,
        }
    }

    pub fn new_translation(
        id: String,
        marker_id: MarkerId,
        image_id: ImageId,
        service: TranslationService,
        source_lang: Option<String>,
        target_lang: String,
    ) -> Self {
        Self {
            id,
            marker_id,
            image_id,
            task_type: TaskType::Translation,
            status: TaskStatus::Queued,
            model: None,
            service: Some(service),
            source_lang,
            target_lang: Some(target_lang),
            result: None,
            error: None,
            progress: None,
            created_at: crate::common::get_timestamp_millis(),
            started_at: None,
            completed_at: None,
        }
    }
}

pub fn get_timestamp_millis() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
    #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(all(target_arch = "wasm32", not(feature = "wasm")))]
    {
        0
    }
}