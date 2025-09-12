// Bunny (海兔) module - OCR and translation service
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use crate::common::{MarkerId, ImageId, ProjectId};
use crate::service::events::EventBus;
use crate::common::EVENT_SYSTEM;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
use js_sys;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunnyTask {
    pub id: String,
    pub marker_id: MarkerId,
    pub image_id: ImageId,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub model: Option<OCRModel>,
    pub service: Option<TranslationService>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
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
pub struct BunnyTaskEvent {
    pub event_type: String,
    pub task_id: String,
    pub marker_id: MarkerId,
    pub task_type: TaskType,
    pub data: Option<serde_json::Value>,
}

pub struct BunnyService {
    tasks: Arc<Mutex<HashMap<String, BunnyTask>>>,
    task_counter: Arc<Mutex<u32>>,
    event_bus: Arc<EventBus>,
}

impl BunnyService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            task_counter: Arc::new(Mutex::new(0)),
            event_bus,
        }
    }

    pub fn request_ocr(&self, marker_id: MarkerId, image_id: ImageId, model: OCRModel) -> Result<String, String> {
        let task_id = self.generate_task_id();
        
        let task = BunnyTask {
            id: task_id.clone(),
            marker_id,
            image_id,
            task_type: TaskType::OCR,
            status: TaskStatus::Queued,
            model: Some(model.clone()),
            service: None,
            result: None,
            error: None,
            created_at: Self::current_timestamp(),
            started_at: None,
            completed_at: None,
        };

        // Store task
        {
            let mut tasks = self.tasks.lock().unwrap();
            tasks.insert(task_id.clone(), task.clone());
        }

        // Emit task started event
        self.emit_task_event("task_started", &task);

        // Process in background using rayon
        let tasks = Arc::clone(&self.tasks);
        let event_bus = Arc::clone(&self.event_bus);
        let task_id_clone = task_id.clone();
        
        rayon::spawn(move || {
            Self::process_ocr_task(task_id_clone, marker_id, model, tasks, event_bus);
        });

        Ok(task_id)
    }

    pub fn request_translation(
        &self, 
        marker_id: MarkerId, 
        service: TranslationService,
        source_lang: Option<String>,
        target_lang: String
    ) -> Result<String, String> {
        let task_id = self.generate_task_id();
        
        let task = BunnyTask {
            id: task_id.clone(),
            marker_id,
            image_id: ImageId(0), // Will be fetched from marker
            task_type: TaskType::Translation,
            status: TaskStatus::Queued,
            model: None,
            service: Some(service.clone()),
            result: None,
            error: None,
            created_at: Self::current_timestamp(),
            started_at: None,
            completed_at: None,
        };

        // Store task
        {
            let mut tasks = self.tasks.lock().unwrap();
            tasks.insert(task_id.clone(), task.clone());
        }

        // Emit task started event
        self.emit_task_event("task_started", &task);

        // Process in background using rayon
        let tasks = Arc::clone(&self.tasks);
        let event_bus = Arc::clone(&self.event_bus);
        let task_id_clone = task_id.clone();
        
        rayon::spawn(move || {
            Self::process_translation_task(
                task_id_clone, 
                marker_id, 
                service, 
                source_lang, 
                target_lang, 
                tasks, 
                event_bus
            );
        });

        Ok(task_id)
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.lock().unwrap();
        
        if let Some(task) = tasks.get_mut(task_id) {
            if task.status == TaskStatus::Queued || task.status == TaskStatus::Processing {
                task.status = TaskStatus::Cancelled;
                task.completed_at = Some(Self::current_timestamp());
                
                // Emit cancelled event
                self.emit_task_event("task_cancelled", task);
                
                Ok(())
            } else {
                Err("Task is not cancellable".to_string())
            }
        } else {
            Err("Task not found".to_string())
        }
    }

    pub fn get_task_status(&self, task_id: &str) -> Option<BunnyTask> {
        let tasks = self.tasks.lock().unwrap();
        tasks.get(task_id).cloned()
    }

    pub fn get_queued_tasks(&self, _project_id: Option<ProjectId>) -> Vec<BunnyTask> {
        let tasks = self.tasks.lock().unwrap();
        tasks.values()
            .filter(|t| t.status == TaskStatus::Queued || t.status == TaskStatus::Processing)
            .cloned()
            .collect()
    }

    pub fn get_ocr_result(&self, marker_id: MarkerId) -> Option<String> {
        let tasks = self.tasks.lock().unwrap();
        tasks.values()
            .filter(|t| {
                t.marker_id == marker_id && 
                t.task_type == TaskType::OCR && 
                t.status == TaskStatus::Completed
            })
            .max_by_key(|t| t.completed_at)
            .and_then(|t| t.result.clone())
    }

    pub fn get_translation_result(&self, marker_id: MarkerId) -> Option<String> {
        let tasks = self.tasks.lock().unwrap();
        tasks.values()
            .filter(|t| {
                t.marker_id == marker_id && 
                t.task_type == TaskType::Translation && 
                t.status == TaskStatus::Completed
            })
            .max_by_key(|t| t.completed_at)
            .and_then(|t| t.result.clone())
    }

    // Helper methods

    fn generate_task_id(&self) -> String {
        let mut counter = self.task_counter.lock().unwrap();
        *counter += 1;
        format!("bunny_task_{}_{}", Self::current_timestamp(), *counter)
    }

    fn current_timestamp() -> u64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        }
        #[cfg(target_arch = "wasm32")]
        {
            // In WASM, use JavaScript Date.now()
            #[cfg(feature = "wasm")]
            {
                js_sys::Date::now() as u64
            }
            #[cfg(not(feature = "wasm"))]
            {
                0
            }
        }
    }

    fn emit_task_event(&self, event_type: &str, task: &BunnyTask) {
        let event = BunnyTaskEvent {
            event_type: event_type.to_string(),
            task_id: task.id.clone(),
            marker_id: task.marker_id,
            task_type: task.task_type.clone(),
            data: None,
        };

        let event_name = format!("bunny:{}", event_type);
        if let Ok(json) = serde_json::to_value(&event) {
            // Use the unified event system which handles platform differences
            let _ = EVENT_SYSTEM.emit_business_event(event_name, json);
        }
    }

    // Dummy processing functions - simulating OCR and translation
    
    fn process_ocr_task(
        task_id: String,
        marker_id: MarkerId,
        model: OCRModel,
        tasks: Arc<Mutex<HashMap<String, BunnyTask>>>,
        _event_bus: Arc<EventBus>
    ) {
        // Update task status to processing
        {
            let mut tasks = tasks.lock().unwrap();
            if let Some(task) = tasks.get_mut(&task_id) {
                task.status = TaskStatus::Processing;
                task.started_at = Some(Self::current_timestamp());
            }
        }

        // Simulate processing delay (3-5 seconds)
        // Note: In WASM with rayon, this will block a worker thread from the pool
        // In production, replace with actual OCR processing
        simulate_delay();

        // Generate dummy OCR result
        let result = format!(
            "[OCR Result - {:?}]\nMarker {}: Sample OCR text extracted from image.\n示例OCR文本。",
            model, marker_id.0
        );

        // Update task with result
        {
            let mut tasks = tasks.lock().unwrap();
            if let Some(task) = tasks.get_mut(&task_id) {
                if task.status == TaskStatus::Cancelled {
                    return;
                }
                
                task.status = TaskStatus::Completed;
                task.result = Some(result.clone());
                task.completed_at = Some(Self::current_timestamp());

                // Emit completion event
                let event = serde_json::json!({
                    "task_id": task_id,
                    "marker_id": marker_id.0,
                    "text": result,
                    "model": serde_json::to_value(&model).unwrap()
                });
                
                // Use the unified event system which handles platform differences
                let _ = EVENT_SYSTEM.emit_business_event("bunny:ocr_completed".to_string(), event);
            }
        }
    }

    fn process_translation_task(
        task_id: String,
        marker_id: MarkerId,
        service: TranslationService,
        _source_lang: Option<String>,
        target_lang: String,
        tasks: Arc<Mutex<HashMap<String, BunnyTask>>>,
        _event_bus: Arc<EventBus>
    ) {
        // Update task status to processing
        {
            let mut tasks = tasks.lock().unwrap();
            if let Some(task) = tasks.get_mut(&task_id) {
                task.status = TaskStatus::Processing;
                task.started_at = Some(Self::current_timestamp());
            }
        }

        // Simulate processing delay (3-5 seconds)
        // Note: In WASM with rayon, this will block a worker thread from the pool
        // In production, replace with actual OCR processing
        simulate_delay();

        // Generate dummy translation result
        let result = format!(
            "[Translation - {:?} to {}]\nMarker {}: This is the translated text.\n这是翻译后的文本。",
            service, target_lang, marker_id.0
        );

        // Update task with result
        {
            let mut tasks = tasks.lock().unwrap();
            if let Some(task) = tasks.get_mut(&task_id) {
                if task.status == TaskStatus::Cancelled {
                    return;
                }
                
                task.status = TaskStatus::Completed;
                task.result = Some(result.clone());
                task.completed_at = Some(Self::current_timestamp());

                // Emit completion event
                let event = serde_json::json!({
                    "task_id": task_id,
                    "marker_id": marker_id.0,
                    "translation": result,
                    "service": serde_json::to_value(&service).unwrap()
                });
                
                // Use the unified event system which handles platform differences
                let _ = EVENT_SYSTEM.emit_business_event("bunny:translation_completed".to_string(), event);
            }
        }
    }
}

// Simulate delay with random duration (3-5 seconds)
fn simulate_delay() {
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Simple pseudo-random based on current time
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let random_ms = (now % 2000) as u64;
        std::thread::sleep(std::time::Duration::from_millis(3000 + random_ms));
    }
    #[cfg(target_arch = "wasm32")]
    {
        // In WASM, use JavaScript Math.random() and busy wait
        #[cfg(feature = "wasm")]
        {
            let random_ms = (js_sys::Math::random() * 2000.0) as u64;
            let start = BunnyService::current_timestamp();
            let delay = 3000 + random_ms;
            while BunnyService::current_timestamp() - start < delay {
                // Busy wait - not ideal but works in WASM
            }
        }
        #[cfg(not(feature = "wasm"))]
        {
            // Fixed delay for non-wasm builds
            let start = BunnyService::current_timestamp();
            while BunnyService::current_timestamp() - start < 4000 {
                // Busy wait
            }
        }
    }
}