/// Native platform support for plugins
use std::os::raw::{c_char, c_void};
use std::ffi::{CStr, CString};
use serde_json::Value;

/// FFI function types for calling back to host
#[repr(C)]
pub struct HostCallbacks {
    /// Call a core service
    pub call_service: extern "C" fn(
        plugin_id: *const c_char,
        service: *const c_char,
        method: *const c_char,
        params: *const c_char,
    ) -> *mut c_char,
    
    /// Read an image file (optimized for desktop)
    pub read_image_file: extern "C" fn(
        file_path: *const c_char,
        data_ptr: *mut *mut u8,
        data_len: *mut usize,
    ) -> i32,
    
    /// Free memory allocated by host
    pub free_host_memory: extern "C" fn(ptr: *mut c_void),
    
    /// Log a message
    pub log_message: extern "C" fn(level: i32, message: *const c_char),
}

static mut HOST_CALLBACKS: Option<HostCallbacks> = None;

/// Set the host callbacks (called during plugin initialization)
#[no_mangle]
pub extern "C" fn plugin_set_host_callbacks(callbacks: HostCallbacks) {
    unsafe {
        HOST_CALLBACKS = Some(callbacks);
    }
}

/// Call a core service through FFI
pub fn call_service_native(plugin_id: &str, service: &str, method: &str, params: Value) -> Result<Value, String> {
    unsafe {
        if let Some(ref callbacks) = HOST_CALLBACKS {
            let plugin_id_c = CString::new(plugin_id).map_err(|e| e.to_string())?;
            let service_c = CString::new(service).map_err(|e| e.to_string())?;
            let method_c = CString::new(method).map_err(|e| e.to_string())?;
            let params_json = serde_json::to_string(&params).map_err(|e| e.to_string())?;
            let params_c = CString::new(params_json).map_err(|e| e.to_string())?;
            
            let result_ptr = (callbacks.call_service)(
                plugin_id_c.as_ptr(),
                service_c.as_ptr(),
                method_c.as_ptr(),
                params_c.as_ptr(),
            );
            
            if result_ptr.is_null() {
                return Err("Service call returned null".to_string());
            }
            
            let result_str = CStr::from_ptr(result_ptr).to_string_lossy();
            let result: Value = serde_json::from_str(&result_str).map_err(|e| e.to_string())?;
            
            // Free the result string allocated by host
            (callbacks.free_host_memory)(result_ptr as *mut c_void);
            
            Ok(result)
        } else {
            Err("Host callbacks not initialized".to_string())
        }
    }
}

/// Read an image file directly (desktop only)
pub fn read_image_file_native(file_path: &str) -> Result<Vec<u8>, String> {
    unsafe {
        if let Some(ref callbacks) = HOST_CALLBACKS {
            let path_c = CString::new(file_path).map_err(|e| e.to_string())?;
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut data_len: usize = 0;
            
            let result = (callbacks.read_image_file)(
                path_c.as_ptr(),
                &mut data_ptr,
                &mut data_len,
            );
            
            if result != 0 || data_ptr.is_null() {
                return Err(format!("Failed to read image file: {}", file_path));
            }
            
            // Copy data to Vec
            let data = std::slice::from_raw_parts(data_ptr, data_len).to_vec();
            
            // Free the memory allocated by host
            (callbacks.free_host_memory)(data_ptr as *mut c_void);
            
            Ok(data)
        } else {
            Err("Host callbacks not initialized".to_string())
        }
    }
}

/// Log levels
#[repr(i32)]
pub enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

/// Log a message through host
pub fn log_native(level: LogLevel, message: &str) {
    unsafe {
        if let Some(ref callbacks) = HOST_CALLBACKS {
            if let Ok(message_c) = CString::new(message) {
                (callbacks.log_message)(level as i32, message_c.as_ptr());
            }
        }
    }
}