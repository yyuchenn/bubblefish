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

pub fn check_cancellation_with_delay(token: &Arc<AtomicBool>, delay_ms: u64) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Check periodically during the delay instead of sleeping the entire time
        let check_interval = 100; // Check every 100ms
        let mut elapsed = 0;

        while elapsed < delay_ms {
            // Check if cancelled
            if token.load(Ordering::SeqCst) {
                return true;
            }

            // Sleep for the smaller of remaining time or check interval
            let sleep_time = std::cmp::min(check_interval, delay_ms - elapsed);
            std::thread::sleep(std::time::Duration::from_millis(sleep_time));
            elapsed += sleep_time;
        }

        // Final check
        token.load(Ordering::SeqCst)
    }
    #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
    {
        let start = js_sys::Date::now() as u64;
        while js_sys::Date::now() as u64 - start < delay_ms {
            if token.load(Ordering::SeqCst) {
                return true;
            }
        }
        false
    }
    #[cfg(all(target_arch = "wasm32", not(feature = "wasm")))]
    {
        let _ = delay_ms;
        token.load(Ordering::SeqCst)
    }
}