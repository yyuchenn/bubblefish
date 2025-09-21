use std::collections::{VecDeque, HashMap};
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use crate::common::{ProjectId, EVENT_SYSTEM};
use super::task::{BunnyTask, QueuedTask, ActiveTask, TaskStatus, TaskType, BunnyTaskEvent, get_timestamp_millis};
use super::executor::TaskExecutor;
use super::cancellation::CancellationManager;

pub struct TaskQueueSystem {
    ocr_queue: Arc<Mutex<VecDeque<QueuedTask>>>,
    translation_queue: Arc<Mutex<VecDeque<QueuedTask>>>,
    active_tasks: Arc<RwLock<HashMap<String, ActiveTask>>>,
    all_tasks: Arc<RwLock<HashMap<String, BunnyTask>>>,
    executor: Arc<TaskExecutor>,
    cancellation_manager: Arc<CancellationManager>,
    ocr_active_count: Arc<AtomicUsize>,
    translation_active_count: Arc<AtomicUsize>,
    max_concurrent_ocr: usize,
    max_concurrent_translation: usize,
    scheduler_running: Arc<AtomicBool>,
}

impl TaskQueueSystem {
    pub fn new() -> Self {
        // In WASM, limit concurrency to avoid overwhelming the environment
        #[cfg(target_arch = "wasm32")]
        let (max_ocr, max_trans) = (2, 2);
        #[cfg(not(target_arch = "wasm32"))]
        let (max_ocr, max_trans) = (5, 5);

        let system = Self {
            ocr_queue: Arc::new(Mutex::new(VecDeque::new())),
            translation_queue: Arc::new(Mutex::new(VecDeque::new())),
            active_tasks: Arc::new(RwLock::new(HashMap::new())),
            all_tasks: Arc::new(RwLock::new(HashMap::new())),
            executor: Arc::new(TaskExecutor::new()),
            cancellation_manager: Arc::new(CancellationManager::new()),
            ocr_active_count: Arc::new(AtomicUsize::new(0)),
            translation_active_count: Arc::new(AtomicUsize::new(0)),
            max_concurrent_ocr: max_ocr,
            max_concurrent_translation: max_trans,
            scheduler_running: Arc::new(AtomicBool::new(true)),
        };

        system.start_scheduler();
        system
    }

    pub fn enqueue_task(&self, mut task: BunnyTask) -> Result<(), String> {
        let task_id = task.id.clone();
        let task_type = task.task_type.clone();

        task.status = TaskStatus::Queued;

        let cancellation_token = self.cancellation_manager.create_token(task_id.clone());

        let queued_task = QueuedTask {
            task: task.clone(),
            cancellation_token,
        };

        {
            let mut all_tasks = self.all_tasks.write().unwrap();
            all_tasks.insert(task_id.clone(), task.clone());
        }

        match task_type {
            TaskType::OCR => {
                let mut queue = self.ocr_queue.lock().unwrap();
                queue.push_back(queued_task);
            }
            TaskType::Translation => {
                let mut queue = self.translation_queue.lock().unwrap();
                queue.push_back(queued_task);
            }
        }

        let event = BunnyTaskEvent {
            event_type: "task_queued".to_string(),
            task_id: task.id.clone(),
            marker_id: task.marker_id,
            task_type: task.task_type.clone(),
            status: task.status.clone(),
            progress: None,
            data: None,
        };

        if let Ok(json) = serde_json::to_value(&event) {
            let _ = EVENT_SYSTEM.emit_business_event("bunny:task_queued".to_string(), json);
        }

        Ok(())
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let mut all_tasks = self.all_tasks.write().unwrap();
        if let Some(task) = all_tasks.get_mut(task_id) {

            match task.status {
                TaskStatus::Queued => {
                    self.remove_from_queue(task_id, &task.task_type)?;

                    task.status = TaskStatus::Cancelled;
                    task.completed_at = Some(get_timestamp_millis());

                    let event = BunnyTaskEvent {
                        event_type: "task_cancelled".to_string(),
                        task_id: task_id.to_string(),
                        marker_id: task.marker_id,
                        task_type: task.task_type.clone(),
                        status: TaskStatus::Cancelled,
                        progress: None,
                        data: None,
                    };

                    if let Ok(json) = serde_json::to_value(&event) {
                        let _ = EVENT_SYSTEM.emit_business_event("bunny:task_cancelled".to_string(), json);
                    }

                    Ok(())
                }
                TaskStatus::Processing => {
                    self.cancellation_manager.cancel(task_id);
                    Ok(())
                }
                _ => Err("Task is not cancellable".to_string())
            }
        } else {
            Err("Task not found".to_string())
        }
    }

    fn remove_from_queue(&self, task_id: &str, task_type: &TaskType) -> Result<(), String> {
        match task_type {
            TaskType::OCR => {
                let mut queue = self.ocr_queue.lock().unwrap();
                if let Some(pos) = queue.iter().position(|t| t.task.id == task_id) {
                    queue.remove(pos);
                    Ok(())
                } else {
                    Err("Task not found in queue".to_string())
                }
            }
            TaskType::Translation => {
                let mut queue = self.translation_queue.lock().unwrap();
                if let Some(pos) = queue.iter().position(|t| t.task.id == task_id) {
                    queue.remove(pos);
                    Ok(())
                } else {
                    Err("Task not found in queue".to_string())
                }
            }
        }
    }

    pub fn get_task_status(&self, task_id: &str) -> Option<BunnyTask> {
        let all_tasks = self.all_tasks.read().unwrap();
        all_tasks.get(task_id).cloned()
    }

    pub fn get_queued_tasks(&self, project_id: Option<ProjectId>) -> Vec<BunnyTask> {
        let _ = project_id;
        let all_tasks = self.all_tasks.read().unwrap();

        all_tasks
            .values()
            .filter(|task| {
                task.status == TaskStatus::Queued || task.status == TaskStatus::Processing
            })
            .cloned()
            .collect()
    }

    pub fn get_all_tasks(&self) -> Vec<BunnyTask> {
        let all_tasks = self.all_tasks.read().unwrap();
        all_tasks.values().cloned().collect()
    }

    fn start_scheduler(&self) {
        let ocr_queue = Arc::clone(&self.ocr_queue);
        let translation_queue = Arc::clone(&self.translation_queue);
        let active_tasks = Arc::clone(&self.active_tasks);
        let all_tasks = Arc::clone(&self.all_tasks);
        let executor = Arc::clone(&self.executor);
        let ocr_active = Arc::clone(&self.ocr_active_count);
        let translation_active = Arc::clone(&self.translation_active_count);
        let scheduler_running = Arc::clone(&self.scheduler_running);
        let max_ocr = self.max_concurrent_ocr;
        let max_trans = self.max_concurrent_translation;

        rayon::spawn(move || {
            while scheduler_running.load(Ordering::SeqCst) {
                Self::schedule_ocr_tasks(
                    &ocr_queue,
                    &active_tasks,
                    &all_tasks,
                    &executor,
                    &ocr_active,
                    max_ocr,
                );

                Self::schedule_translation_tasks(
                    &translation_queue,
                    &active_tasks,
                    &all_tasks,
                    &executor,
                    &translation_active,
                    max_trans,
                );

                Self::cleanup_completed_tasks(&active_tasks, &all_tasks, &ocr_active, &translation_active);

                #[cfg(not(target_arch = "wasm32"))]
                std::thread::sleep(std::time::Duration::from_millis(100));

                #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
                {
                    let start = js_sys::Date::now() as u64;
                    while js_sys::Date::now() as u64 - start < 100 {}
                }
            }
        });
    }

    fn schedule_ocr_tasks(
        queue: &Arc<Mutex<VecDeque<QueuedTask>>>,
        active_tasks: &Arc<RwLock<HashMap<String, ActiveTask>>>,
        all_tasks: &Arc<RwLock<HashMap<String, BunnyTask>>>,
        executor: &Arc<TaskExecutor>,
        active_count: &Arc<AtomicUsize>,
        max_concurrent: usize,
    ) {
        while active_count.load(Ordering::SeqCst) < max_concurrent {
            let task_to_execute = {
                let mut queue = queue.lock().unwrap();
                queue.pop_front()
            };

            if let Some(queued_task) = task_to_execute {
                let mut task = queued_task.task;
                task.status = TaskStatus::Processing;
                task.started_at = Some(get_timestamp_millis());

                {
                    let mut all_tasks_guard = all_tasks.write().unwrap();
                    all_tasks_guard.insert(task.id.clone(), task.clone());
                }

                let progress = Arc::new(AtomicU64::new(0));
                let active_task = ActiveTask {
                    task: task.clone(),
                    cancellation_token: Arc::clone(&queued_task.cancellation_token),
                    progress: Arc::clone(&progress),
                };

                {
                    let mut active_tasks_guard = active_tasks.write().unwrap();
                    active_tasks_guard.insert(task.id.clone(), active_task);
                }
                active_count.fetch_add(1, Ordering::SeqCst);

                let event = BunnyTaskEvent {
                    event_type: "task_started".to_string(),
                    task_id: task.id.clone(),
                    marker_id: task.marker_id,
                    task_type: task.task_type.clone(),
                    status: TaskStatus::Processing,
                    progress: Some(0),
                    data: None,
                };

                if let Ok(json) = serde_json::to_value(&event) {
                    let _ = EVENT_SYSTEM.emit_business_event("bunny:task_started".to_string(), json);
                }

                let all_tasks_clone = Arc::clone(&all_tasks);
                executor.execute_task(task, queued_task.cancellation_token, progress, all_tasks_clone);
            } else {
                break;
            }
        }
    }

    fn schedule_translation_tasks(
        queue: &Arc<Mutex<VecDeque<QueuedTask>>>,
        active_tasks: &Arc<RwLock<HashMap<String, ActiveTask>>>,
        all_tasks: &Arc<RwLock<HashMap<String, BunnyTask>>>,
        executor: &Arc<TaskExecutor>,
        active_count: &Arc<AtomicUsize>,
        max_concurrent: usize,
    ) {
        while active_count.load(Ordering::SeqCst) < max_concurrent {
            let task_to_execute = {
                let mut queue = queue.lock().unwrap();
                queue.pop_front()
            };

            if let Some(queued_task) = task_to_execute {
                let mut task = queued_task.task;
                task.status = TaskStatus::Processing;
                task.started_at = Some(get_timestamp_millis());

                {
                    let mut all_tasks_guard = all_tasks.write().unwrap();
                    all_tasks_guard.insert(task.id.clone(), task.clone());
                }

                let progress = Arc::new(AtomicU64::new(0));
                let active_task = ActiveTask {
                    task: task.clone(),
                    cancellation_token: Arc::clone(&queued_task.cancellation_token),
                    progress: Arc::clone(&progress),
                };

                {
                    let mut active_tasks_guard = active_tasks.write().unwrap();
                    active_tasks_guard.insert(task.id.clone(), active_task);
                }
                active_count.fetch_add(1, Ordering::SeqCst);

                let event = BunnyTaskEvent {
                    event_type: "task_started".to_string(),
                    task_id: task.id.clone(),
                    marker_id: task.marker_id,
                    task_type: task.task_type.clone(),
                    status: TaskStatus::Processing,
                    progress: Some(0),
                    data: None,
                };

                if let Ok(json) = serde_json::to_value(&event) {
                    let _ = EVENT_SYSTEM.emit_business_event("bunny:task_started".to_string(), json);
                }

                let all_tasks_clone = Arc::clone(&all_tasks);
                executor.execute_task(task, queued_task.cancellation_token, progress, all_tasks_clone);
            } else {
                break;
            }
        }
    }

    fn cleanup_completed_tasks(
        active_tasks: &Arc<RwLock<HashMap<String, ActiveTask>>>,
        all_tasks: &Arc<RwLock<HashMap<String, BunnyTask>>>,
        ocr_active: &Arc<AtomicUsize>,
        translation_active: &Arc<AtomicUsize>,
    ) {
        let mut to_remove = Vec::new();

        {
            let active_tasks_guard = active_tasks.read().unwrap();
            let all_tasks_guard = all_tasks.read().unwrap();

            for (task_id, active_task) in active_tasks_guard.iter() {
                // Check if task status in all_tasks indicates completion
                let should_remove = if let Some(task) = all_tasks_guard.get(task_id) {
                    matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled | TaskStatus::Failed)
                } else {
                    // Also check progress and cancellation token
                    let progress_value = active_task.progress.load(Ordering::SeqCst);
                    progress_value >= 100 || active_task.cancellation_token.load(Ordering::SeqCst)
                };

                if should_remove {
                    to_remove.push((task_id.clone(), active_task.task.task_type.clone()));
                }
            }
        }

        if !to_remove.is_empty() {
            let mut active_tasks_guard = active_tasks.write().unwrap();
            for (task_id, task_type) in to_remove {
                active_tasks_guard.remove(&task_id);
                match task_type {
                    TaskType::OCR => ocr_active.fetch_sub(1, Ordering::SeqCst),
                    TaskType::Translation => translation_active.fetch_sub(1, Ordering::SeqCst),
                };
            }
        }
    }

    pub fn clear_all_tasks(&self) -> Result<(), String> {
        // Get all active task IDs
        let mut task_ids = Vec::new();

        // Get all task IDs from all_tasks
        {
            let all_tasks = self.all_tasks.read().unwrap();
            for (task_id, task) in all_tasks.iter() {
                if task.status == TaskStatus::Queued || task.status == TaskStatus::Processing {
                    task_ids.push(task_id.clone());
                }
            }
        }

        // Cancel each task
        for task_id in task_ids {
            let _ = self.cancel_task(&task_id);
        }

        // Clear the queues
        {
            let mut ocr_queue = self.ocr_queue.lock().unwrap();
            ocr_queue.clear();
        }
        {
            let mut translation_queue = self.translation_queue.lock().unwrap();
            translation_queue.clear();
        }

        Ok(())
    }

    pub fn shutdown(&self) {
        self.scheduler_running.store(false, Ordering::SeqCst);
        self.cancellation_manager.clear_all();
    }
}

impl Drop for TaskQueueSystem {
    fn drop(&mut self) {
        self.shutdown();
    }
}