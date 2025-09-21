use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use crate::common::EVENT_SYSTEM;
use super::task::{BunnyTask, TaskStatus, TaskType, OCRModel, TranslationService, BunnyTaskEvent, get_timestamp_millis};
use super::cancellation::check_cancellation_with_delay;

#[cfg(not(target_arch = "wasm32"))]
use rayon::ThreadPool;

pub struct TaskExecutor {
    #[cfg(not(target_arch = "wasm32"))]
    ocr_pool: Arc<ThreadPool>,
    #[cfg(not(target_arch = "wasm32"))]
    translation_pool: Arc<ThreadPool>,
}

impl TaskExecutor {
    pub fn new() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let ocr_pool = rayon::ThreadPoolBuilder::new()
                .num_threads(5)
                .thread_name(|i| format!("bunny-ocr-{}", i))
                .build()
                .expect("Failed to create OCR thread pool");

            let translation_pool = rayon::ThreadPoolBuilder::new()
                .num_threads(5)
                .thread_name(|i| format!("bunny-trans-{}", i))
                .build()
                .expect("Failed to create translation thread pool");

            Self {
                ocr_pool: Arc::new(ocr_pool),
                translation_pool: Arc::new(translation_pool),
            }
        }

        #[cfg(target_arch = "wasm32")]
        {
            // In WASM, we can't create custom thread pools
            // We'll use the global rayon pool with limited parallelism
            Self {}
        }
    }

    pub fn execute_task(
        &self,
        mut task: BunnyTask,
        cancellation_token: Arc<AtomicBool>,
        progress: Arc<AtomicU64>,
        all_tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
    ) {
        task.status = TaskStatus::Processing;
        task.started_at = Some(get_timestamp_millis());

        let task_clone = task.clone();
        let token = Arc::clone(&cancellation_token);
        let progress_clone = Arc::clone(&progress);

        match task.task_type {
            TaskType::OCR => {
                let all_tasks_clone = Arc::clone(&all_tasks);
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.ocr_pool.spawn(move || {
                        Self::process_ocr_task(task_clone, token, progress_clone, all_tasks_clone);
                    });
                }

                #[cfg(target_arch = "wasm32")]
                {
                    // In WASM, use the global rayon pool
                    rayon::spawn(move || {
                        Self::process_ocr_task(task_clone, token, progress_clone, all_tasks_clone);
                    });
                }
            }
            TaskType::Translation => {
                let all_tasks_clone = Arc::clone(&all_tasks);
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.translation_pool.spawn(move || {
                        Self::process_translation_task(task_clone, token, progress_clone, all_tasks_clone);
                    });
                }

                #[cfg(target_arch = "wasm32")]
                {
                    // In WASM, use the global rayon pool
                    rayon::spawn(move || {
                        Self::process_translation_task(task_clone, token, progress_clone, all_tasks_clone);
                    });
                }
            }
        }
    }

    fn process_ocr_task(
        mut task: BunnyTask,
        cancellation_token: Arc<AtomicBool>,
        progress: Arc<AtomicU64>,
        all_tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
    ) {
        let mut cancelled = false;

        // Simulate OCR processing with progress updates
        for i in 0..5 {
            // Check for cancellation every second
            if check_cancellation_with_delay(&cancellation_token, 1000) {
                cancelled = true;
                break;
            }

            // Update progress
            let current_progress = ((i + 1) * 20) as u64;
            progress.store(current_progress, Ordering::SeqCst);

            // Emit progress event
            let event = BunnyTaskEvent {
                event_type: "task_progress".to_string(),
                task_id: task.id.clone(),
                marker_id: task.marker_id,
                task_type: task.task_type.clone(),
                status: task.status.clone(),
                progress: Some(current_progress as u8),
                data: None,
            };

            if let Ok(json) = serde_json::to_value(&event) {
                let _ = EVENT_SYSTEM.emit_business_event("bunny:task_progress".to_string(), json);
            }
        }

        if cancelled {
            // Task was cancelled
            task.status = TaskStatus::Cancelled;
            task.completed_at = Some(get_timestamp_millis());

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            let event = BunnyTaskEvent {
                event_type: "task_cancelled".to_string(),
                task_id: task.id.clone(),
                marker_id: task.marker_id,
                task_type: task.task_type.clone(),
                status: task.status.clone(),
                progress: None,
                data: None,
            };

            if let Ok(json) = serde_json::to_value(&event) {
                let _ = EVENT_SYSTEM.emit_business_event("bunny:task_cancelled".to_string(), json);
            }
        } else {
            // Generate dummy OCR result
            let result = format!(
                "[OCR Result - {:?}]\nMarker {}: Sample OCR text extracted from image.\n示例OCR文本。",
                task.model.as_ref().unwrap_or(&OCRModel::Default),
                task.marker_id.0
            );

            task.status = TaskStatus::Completed;
            task.result = Some(result.clone());
            task.completed_at = Some(get_timestamp_millis());
            progress.store(100, Ordering::SeqCst);

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            // Emit completion event
            let event = serde_json::json!({
                "task_id": task.id,
                "marker_id": task.marker_id.0,
                "text": result,
                "model": task.model,
            });

            let _ = EVENT_SYSTEM.emit_business_event("bunny:ocr_completed".to_string(), event);
        }
    }

    fn process_translation_task(
        mut task: BunnyTask,
        cancellation_token: Arc<AtomicBool>,
        progress: Arc<AtomicU64>,
        all_tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
    ) {
        let mut cancelled = false;

        // Simulate translation processing with progress updates
        for i in 0..5 {
            // Check for cancellation every second
            if check_cancellation_with_delay(&cancellation_token, 1000) {
                cancelled = true;
                break;
            }

            // Update progress
            let current_progress = ((i + 1) * 20) as u64;
            progress.store(current_progress, Ordering::SeqCst);

            // Emit progress event
            let event = BunnyTaskEvent {
                event_type: "task_progress".to_string(),
                task_id: task.id.clone(),
                marker_id: task.marker_id,
                task_type: task.task_type.clone(),
                status: task.status.clone(),
                progress: Some(current_progress as u8),
                data: None,
            };

            if let Ok(json) = serde_json::to_value(&event) {
                let _ = EVENT_SYSTEM.emit_business_event("bunny:task_progress".to_string(), json);
            }
        }

        if cancelled {
            // Task was cancelled
            task.status = TaskStatus::Cancelled;
            task.completed_at = Some(get_timestamp_millis());

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            let event = BunnyTaskEvent {
                event_type: "task_cancelled".to_string(),
                task_id: task.id.clone(),
                marker_id: task.marker_id,
                task_type: task.task_type.clone(),
                status: task.status.clone(),
                progress: None,
                data: None,
            };

            if let Ok(json) = serde_json::to_value(&event) {
                let _ = EVENT_SYSTEM.emit_business_event("bunny:task_cancelled".to_string(), json);
            }
        } else {
            // Generate dummy translation result
            let result = format!(
                "[Translation - {:?} to {}]\nMarker {}: This is the translated text.\n这是翻译后的文本。",
                task.service.as_ref().unwrap_or(&TranslationService::Default),
                task.target_lang.as_ref().unwrap_or(&"zh-CN".to_string()),
                task.marker_id.0
            );

            task.status = TaskStatus::Completed;
            task.result = Some(result.clone());
            task.completed_at = Some(get_timestamp_millis());
            progress.store(100, Ordering::SeqCst);

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            // Emit completion event
            let event = serde_json::json!({
                "task_id": task.id,
                "marker_id": task.marker_id.0,
                "translation": result,
                "service": task.service,
            });

            let _ = EVENT_SYSTEM.emit_business_event("bunny:translation_completed".to_string(), event);
        }
    }
}