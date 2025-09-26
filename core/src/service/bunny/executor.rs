use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use crate::common::EVENT_SYSTEM;
use super::task::{BunnyTask, TaskStatus, TaskType, BunnyTaskEvent, get_timestamp_millis};
use super::BUNNY_PLUGIN_MANAGER;

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
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[BunnyExecutor] Processing OCR task {}", task.id).into());

        // Check for immediate cancellation
        let cancelled = cancellation_token.load(Ordering::SeqCst);

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
            // Check if this is a plugin-based service
            let result = if let Some(ref model) = task.model {
                if model != "default" {
                    // Get image data for the marker
                    // TODO: Get actual image data from image service
                    let dummy_image_data = vec![0u8; 100]; // Placeholder image data

                    // Process through plugin
                    match BUNNY_PLUGIN_MANAGER.process_ocr_with_plugin(
                        model,
                        task.marker_id.0,
                        dummy_image_data,
                    ) {
                        Ok(_) => {
                            // Plugin processing initiated, result will come via event
                            // For now, return a placeholder
                            format!("[OCR processing via plugin '{}']", model)
                        }
                        Err(e) => {
                            #[cfg(target_arch = "wasm32")]
                            web_sys::console::error_1(&format!("[BunnyExecutor] Plugin OCR failed: {}", e).into());

                            // Fallback to empty if plugin fails
                            String::new()
                        }
                    }
                } else {
                    // Return empty text for default dummy implementation
                    String::new()
                }
            } else {
                String::new()
            };

            task.status = TaskStatus::Completed;
            task.result = Some(result.clone());
            task.completed_at = Some(get_timestamp_millis());
            progress.store(100, Ordering::SeqCst);

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            // Log for debugging
            #[cfg(not(target_arch = "wasm32"))]
            println!("[BunnyExecutor] OCR task {} completed with result: {}", task.id, result);

            #[cfg(target_arch = "wasm32")]
            web_sys::console::log_1(&format!("[BunnyExecutor] OCR task {} completed with result: {}", task.id, result).into());

            // Emit completion event
            let event = serde_json::json!({
                "task_id": task.id,
                "marker_id": task.marker_id.0,
                "text": result,
                "model": task.model,
            });

            if let Err(e) = EVENT_SYSTEM.emit_business_event("bunny:ocr_completed".to_string(), event) {
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("[BunnyExecutor] Failed to emit OCR completion event: {:?}", e);
            }
        }
    }

    fn process_translation_task(
        mut task: BunnyTask,
        cancellation_token: Arc<AtomicBool>,
        progress: Arc<AtomicU64>,
        all_tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
    ) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[BunnyExecutor] Processing translation task {}", task.id).into());

        // Check for immediate cancellation
        let cancelled = cancellation_token.load(Ordering::SeqCst);

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
            // Check if this is a plugin-based service
            let result = if let Some(ref service) = task.service {
                if service != "default" {
                    // Get the text to translate (from marker's OCR result or provided text)
                    // TODO: Get actual text from marker data
                    let text_to_translate = "Sample text to translate".to_string();

                    // Process through plugin
                    match BUNNY_PLUGIN_MANAGER.process_translation_with_plugin(
                        service,
                        task.marker_id.0,
                        text_to_translate,
                        task.source_lang.clone(),
                        task.target_lang.clone().unwrap_or("zh-CN".to_string()),
                    ) {
                        Ok(_) => {
                            // Plugin processing initiated, result will come via event
                            // For now, return a placeholder
                            format!("[Translation processing via plugin '{}']", service)
                        }
                        Err(e) => {
                            #[cfg(target_arch = "wasm32")]
                            web_sys::console::error_1(&format!("[BunnyExecutor] Plugin translation failed: {}", e).into());

                            // Fallback to empty if plugin fails
                            String::new()
                        }
                    }
                } else {
                    // Return empty text for default dummy implementation
                    String::new()
                }
            } else {
                String::new()
            };

            task.status = TaskStatus::Completed;
            task.result = Some(result.clone());
            task.completed_at = Some(get_timestamp_millis());
            progress.store(100, Ordering::SeqCst);

            // Update the task in all_tasks
            {
                let mut all_tasks_guard = all_tasks.write().unwrap();
                all_tasks_guard.insert(task.id.clone(), task.clone());
            }

            // Log for debugging
            #[cfg(not(target_arch = "wasm32"))]
            println!("[BunnyExecutor] Translation task {} completed with result: {}", task.id, result);

            #[cfg(target_arch = "wasm32")]
            web_sys::console::log_1(&format!("[BunnyExecutor] Translation task {} completed with result: {}", task.id, result).into());

            // Emit completion event
            let event = serde_json::json!({
                "task_id": task.id,
                "marker_id": task.marker_id.0,
                "translation": result,
                "service": task.service,
            });

            if let Err(e) = EVENT_SYSTEM.emit_business_event("bunny:translation_completed".to_string(), event) {
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("[BunnyExecutor] Failed to emit translation completion event: {:?}", e);
            }
        }
    }
}