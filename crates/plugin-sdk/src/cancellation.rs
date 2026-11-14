use crate::PluginRpcError;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

/// A control plane independent of a plugin's exclusive, potentially async handler borrow.
/// Entries are registered before requests enter an execution queue and removed on settlement.
#[derive(Clone, Default)]
pub struct RequestCancellation {
    requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl RequestCancellation {
    pub fn register(&self, request_id: &str) {
        self.token(request_id);
    }
    pub fn cancel(&self, request_id: &str) {
        if let Some(token) = self.requests.lock().unwrap().get(request_id) {
            token.store(true, Ordering::Release);
        }
    }
    pub fn release(&self, request_id: &str) {
        self.requests.lock().unwrap().remove(request_id);
    }
    pub(crate) fn token(&self, request_id: &str) -> Arc<AtomicBool> {
        self.requests
            .lock()
            .unwrap()
            .entry(request_id.into())
            .or_default()
            .clone()
    }
}

pub(crate) fn check(token: &AtomicBool) -> Result<(), PluginRpcError> {
    if token.load(Ordering::Acquire) {
        Err(PluginRpcError::new(
            "cancelled",
            "Plugin request was cancelled",
        ))
    } else {
        Ok(())
    }
}
