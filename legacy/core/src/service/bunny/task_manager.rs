// Bunny task management system
use crate::common::{MarkerId, ImageId, events::get_timestamp_millis};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Processing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    OCR,
    Translation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunnyTask {
    pub task_id: String,
    pub marker_id: MarkerId,
    pub image_id: ImageId,
    pub task_type: TaskType,
    pub service_id: String,
    pub status: TaskStatus,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub error: Option<String>,
}

impl BunnyTask {
    pub fn new(
        task_id: String,
        marker_id: MarkerId,
        image_id: ImageId,
        task_type: TaskType,
        service_id: String,
    ) -> Self {
        Self {
            task_id,
            marker_id,
            image_id,
            task_type,
            service_id,
            status: TaskStatus::Queued,
            created_at: get_timestamp_millis(),
            started_at: None,
            completed_at: None,
            error: None,
        }
    }

    pub fn start(&mut self) {
        self.status = TaskStatus::Processing;
        self.started_at = Some(get_timestamp_millis());
    }

    pub fn complete(&mut self) {
        self.status = TaskStatus::Completed;
        self.completed_at = Some(get_timestamp_millis());
    }

    pub fn fail(&mut self, error: String) {
        self.status = TaskStatus::Failed;
        self.error = Some(error);
        self.completed_at = Some(get_timestamp_millis());
    }
}

pub struct TaskManager {
    tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn create_task(
        &self,
        marker_id: MarkerId,
        image_id: ImageId,
        task_type: TaskType,
        service_id: String,
    ) -> Result<String, String> {
        let task_id = format!(
            "bunny_task_{}_{}_{:?}",
            get_timestamp_millis(),
            marker_id,
            task_type
        );

        let task = BunnyTask::new(task_id.clone(), marker_id, image_id, task_type, service_id);

        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        tasks.insert(task_id.clone(), task);

        Ok(task_id)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<BunnyTask>, String> {
        let tasks = self.tasks.read().map_err(|e| format!("Lock error: {}", e))?;
        Ok(tasks.get(task_id).cloned())
    }

    pub fn start_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(task) = tasks.get_mut(task_id) {
            task.start();
            Ok(())
        } else {
            Err(format!("Task not found: {}", task_id))
        }
    }

    pub fn complete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(task) = tasks.get_mut(task_id) {
            task.complete();
            Ok(())
        } else {
            Err(format!("Task not found: {}", task_id))
        }
    }

    pub fn fail_task(&self, task_id: &str, error: String) -> Result<(), String> {
        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(task) = tasks.get_mut(task_id) {
            task.fail(error);
            Ok(())
        } else {
            Err(format!("Task not found: {}", task_id))
        }
    }

    pub fn get_all_tasks(&self) -> Result<Vec<BunnyTask>, String> {
        let tasks = self.tasks.read().map_err(|e| format!("Lock error: {}", e))?;
        Ok(tasks.values().cloned().collect())
    }

    pub fn remove_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        tasks.remove(task_id);
        Ok(())
    }

    pub fn clear_all_tasks(&self) -> Result<(), String> {
        let mut tasks = self.tasks.write().map_err(|e| format!("Lock error: {}", e))?;
        tasks.clear();
        Ok(())
    }
}