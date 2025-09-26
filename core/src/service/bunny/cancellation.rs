use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::Mutex;

pub struct CancellationManager {
    tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl CancellationManager {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_token(&self, task_id: String) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        let mut tokens = self.tokens.lock().unwrap();
        tokens.insert(task_id, Arc::clone(&token));
        token
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        let tokens = self.tokens.lock().unwrap();
        if let Some(token) = tokens.get(task_id) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }


    pub fn clear_all(&self) {
        let mut tokens = self.tokens.lock().unwrap();
        for (_, token) in tokens.iter() {
            token.store(true, Ordering::SeqCst);
        }
        tokens.clear();
    }
}