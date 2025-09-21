// Bunny (海兔) module - OCR and translation service with queue management
mod task;
mod cancellation;
mod executor;
mod queue;

pub use task::{OCRModel, TranslationService, BunnyTask, TaskType, TaskStatus, BunnyTaskEvent};

use std::sync::Arc;
use crate::common::{MarkerId, ImageId, ProjectId};
use crate::service::events::EventBus;
use queue::TaskQueueSystem;
use task::get_timestamp_millis;

pub struct BunnyService {
    queue_system: Arc<TaskQueueSystem>,
    task_counter: Arc<std::sync::Mutex<u32>>,
}

impl BunnyService {
    pub fn new(_event_bus: Arc<EventBus>) -> Self {
        Self {
            queue_system: Arc::new(TaskQueueSystem::new()),
            task_counter: Arc::new(std::sync::Mutex::new(0)),
        }
    }

    pub fn request_ocr(&self, marker_id: MarkerId, image_id: ImageId, model: OCRModel) -> Result<String, String> {
        let task_id = self.generate_task_id();

        let task = BunnyTask::new_ocr(
            task_id.clone(),
            marker_id,
            image_id,
            model,
        );

        // Enqueue the task
        self.queue_system.enqueue_task(task)?;

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

        // For now, using ImageId(0) as placeholder - will be fetched from marker
        let task = BunnyTask::new_translation(
            task_id.clone(),
            marker_id,
            ImageId(0),
            service,
            source_lang,
            target_lang,
        );

        // Enqueue the task
        self.queue_system.enqueue_task(task)?;

        Ok(task_id)
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        self.queue_system.cancel_task(task_id)
    }

    pub fn get_task_status(&self, task_id: &str) -> Option<BunnyTask> {
        self.queue_system.get_task_status(task_id)
    }

    pub fn get_queued_tasks(&self, project_id: Option<ProjectId>) -> Vec<BunnyTask> {
        self.queue_system.get_queued_tasks(project_id)
    }

    pub fn get_all_tasks(&self) -> Vec<BunnyTask> {
        self.queue_system.get_all_tasks()
    }

    pub fn get_ocr_result(&self, marker_id: MarkerId) -> Option<String> {
        let tasks = self.queue_system.get_all_tasks();
        tasks.iter()
            .filter(|t| {
                t.marker_id == marker_id &&
                t.task_type == TaskType::OCR &&
                t.status == TaskStatus::Completed
            })
            .max_by_key(|t| t.completed_at)
            .and_then(|t| t.result.clone())
    }

    pub fn get_translation_result(&self, marker_id: MarkerId) -> Option<String> {
        let tasks = self.queue_system.get_all_tasks();
        tasks.iter()
            .filter(|t| {
                t.marker_id == marker_id &&
                t.task_type == TaskType::Translation &&
                t.status == TaskStatus::Completed
            })
            .max_by_key(|t| t.completed_at)
            .and_then(|t| t.result.clone())
    }

    pub fn clear_all_tasks(&self) -> Result<(), String> {
        self.queue_system.clear_all_tasks()
    }

    // Helper methods

    fn generate_task_id(&self) -> String {
        let mut counter = self.task_counter.lock().unwrap();
        *counter += 1;
        format!("bunny_task_{}_{}", get_timestamp_millis(), *counter)
    }

    // Shutdown method for clean termination
    pub fn shutdown(&self) {
        self.queue_system.shutdown();
    }
}

impl Drop for BunnyService {
    fn drop(&mut self) {
        self.shutdown();
    }
}