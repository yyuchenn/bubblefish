use wasm_bindgen::prelude::*;
use js_sys::{SharedArrayBuffer, Int32Array, Uint8Array};
use std::sync::atomic::{AtomicI32, Ordering};

/// SharedArrayBuffer ring buffer communication protocol
/// 
/// Memory layout:
/// [0-31]   : Header (8 x i32)
///   [0-3]   : Status (0=idle, 1=request, 2=response, 3=error)
///   [4-7]   : Request ID
///   [8-11]  : Writer position in ring buffer
///   [12-15] : Reader position in ring buffer
///   [16-19] : Total data size
///   [20-23] : Chunk size for transfers
///   [24-27] : Error code
///   [28-31] : Reserved
/// [32-...] : Ring buffer for data
pub struct SharedBufferChannel {
    buffer: SharedArrayBuffer,
    header_array: Int32Array,
    data_array: Uint8Array,
    request_id: AtomicI32,
    data_start_offset: u32,
    ring_buffer_size: u32,
}

// Status constants
const STATUS_IDLE: i32 = 0;
const STATUS_REQUEST: i32 = 1;
const STATUS_RESPONSE: i32 = 2;
const STATUS_ERROR: i32 = 3;

// Header offsets (in i32 indices)
const OFFSET_STATUS: u32 = 0;
const OFFSET_REQUEST_ID: u32 = 1;
const OFFSET_WRITER_POS: u32 = 2;
const OFFSET_READER_POS: u32 = 3;
const OFFSET_TOTAL_SIZE: u32 = 4;
const OFFSET_CHUNK_SIZE: u32 = 5;
const OFFSET_ERROR_CODE: u32 = 6;
const _OFFSET_RESERVED: u32 = 7;

// Sizes
const HEADER_SIZE: u32 = 32;  // 8 x 4 bytes
const DEFAULT_BUFFER_SIZE: u32 = 10 * 1024 * 1024;  // 10MB total
const DEFAULT_CHUNK_SIZE: u32 = 64 * 1024;  // 64KB chunks

impl SharedBufferChannel {
    /// Create new SharedBuffer ring buffer channel
    pub fn new(buffer_size: Option<u32>) -> Result<Self, JsValue> {
        let size = buffer_size.unwrap_or(DEFAULT_BUFFER_SIZE);
        
        // Create SharedArrayBuffer
        let buffer = SharedArrayBuffer::new(size);
        
        // Create views
        let header_array = Int32Array::new_with_byte_offset_and_length(
            &buffer, 
            0, 
            (HEADER_SIZE / 4) as u32
        );
        
        let data_array = Uint8Array::new(&buffer);
        
        let ring_buffer_size = size - HEADER_SIZE;
        
        Ok(Self {
            buffer: buffer.clone(),
            header_array,
            data_array,
            request_id: AtomicI32::new(1),
            data_start_offset: HEADER_SIZE,
            ring_buffer_size,
        })
    }
    
    /// Create channel from existing SharedArrayBuffer
    pub fn from_buffer(buffer: SharedArrayBuffer) -> Result<Self, JsValue> {
        let size = buffer.byte_length();
        
        let header_array = Int32Array::new_with_byte_offset_and_length(
            &buffer, 
            0, 
            (HEADER_SIZE / 4) as u32
        );
        
        let data_array = Uint8Array::new(&buffer);
        
        let ring_buffer_size = size - HEADER_SIZE;
        
        Ok(Self {
            buffer: buffer.clone(),
            header_array,
            data_array,
            request_id: AtomicI32::new(1),
            data_start_offset: HEADER_SIZE,
            ring_buffer_size,
        })
    }
    
    /// Send synchronous request and wait for response
    pub fn call_sync(&self, service: &str, method: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
        // Generate unique request ID
        let request_id = self.request_id.fetch_add(1, Ordering::SeqCst);
        
        // Prepare request data
        let request_data = serde_json::json!({
            "service": service,
            "method": method,
            "params": params
        });
        
        let request_bytes = serde_json::to_vec(&request_data)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;
        
        // Wait for channel to be idle
        self.wait_for_idle()?;
        
        // Reset positions for new request
        self.atomics_store(OFFSET_WRITER_POS, 0);
        self.atomics_store(OFFSET_READER_POS, 0);
        
        // Write request using ring buffer
        self.write_data_streaming(&request_bytes, request_id)?;
        
        // Set status to request
        self.set_status(STATUS_REQUEST);
        
        // Notify main thread
        self.atomics_notify(OFFSET_STATUS);
        
        // Wait for response
        self.wait_for_response(request_id)?;
        
        // Read response using ring buffer
        let response = self.read_data_streaming()?;
        
        // Reset status to idle
        self.set_status(STATUS_IDLE);
        
        Ok(response)
    }
    
    /// Write data using ring buffer streaming
    fn write_data_streaming(&self, data: &[u8], request_id: i32) -> Result<(), String> {
        // Set metadata
        self.atomics_store(OFFSET_REQUEST_ID, request_id);
        self.atomics_store(OFFSET_TOTAL_SIZE, data.len() as i32);
        self.atomics_store(OFFSET_CHUNK_SIZE, DEFAULT_CHUNK_SIZE as i32);
        
        let total_size = data.len();
        let mut written = 0;
        
        while written < total_size {
            let writer_pos = self.atomics_load(OFFSET_WRITER_POS) as u32;
            let reader_pos = self.atomics_load(OFFSET_READER_POS) as u32;
            
            // Calculate available space in ring buffer
            let available_space = if writer_pos >= reader_pos {
                self.ring_buffer_size - writer_pos + reader_pos
            } else {
                reader_pos - writer_pos
            };
            
            if available_space <= 1 {
                // Buffer full, wait a bit
                self.atomics_wait(OFFSET_READER_POS, reader_pos as i32, 1);
                continue;
            }
            
            // Calculate how much to write (leave 1 byte to distinguish full from empty)
            let remaining = total_size - written;
            let write_size = remaining.min((available_space - 1) as usize).min(DEFAULT_CHUNK_SIZE as usize);
            
            // Write to ring buffer
            let write_end = writer_pos + write_size as u32;
            if write_end <= self.ring_buffer_size {
                // Simple case: continuous write
                for i in 0..write_size {
                    self.data_array.set_index(
                        self.data_start_offset + writer_pos + i as u32,
                        data[written + i]
                    );
                }
            } else {
                // Wrap around case
                let first_part = (self.ring_buffer_size - writer_pos) as usize;
                for i in 0..first_part {
                    self.data_array.set_index(
                        self.data_start_offset + writer_pos + i as u32,
                        data[written + i]
                    );
                }
                let second_part = write_size - first_part;
                for i in 0..second_part {
                    self.data_array.set_index(
                        self.data_start_offset + i as u32,
                        data[written + first_part + i]
                    );
                }
            }
            
            written += write_size;
            
            // Update writer position
            let new_writer_pos = write_end % self.ring_buffer_size;
            self.atomics_store(OFFSET_WRITER_POS, new_writer_pos as i32);
            
            // Notify reader
            self.atomics_notify(OFFSET_WRITER_POS);
        }
        
        Ok(())
    }
    
    /// Read data using ring buffer streaming
    fn read_data_streaming(&self) -> Result<serde_json::Value, String> {
        let total_size = self.atomics_load(OFFSET_TOTAL_SIZE) as usize;
        
        if total_size == 0 {
            return Ok(serde_json::Value::Null);
        }
        
        let mut data = Vec::with_capacity(total_size);
        let mut read = 0;
        
        while read < total_size {
            let writer_pos = self.atomics_load(OFFSET_WRITER_POS) as u32;
            let reader_pos = self.atomics_load(OFFSET_READER_POS) as u32;
            
            // Calculate available data
            let available = if writer_pos >= reader_pos {
                writer_pos - reader_pos
            } else {
                self.ring_buffer_size - reader_pos + writer_pos
            };
            
            if available == 0 {
                // No data available, wait
                self.atomics_wait(OFFSET_WRITER_POS, writer_pos as i32, 10);
                continue;
            }
            
            // Calculate how much to read
            let remaining = total_size - read;
            let read_size = remaining.min(available as usize);
            
            // Read from ring buffer
            let read_end = reader_pos + read_size as u32;
            if read_end <= self.ring_buffer_size {
                // Simple case: continuous read
                for i in 0..read_size {
                    data.push(self.data_array.get_index(
                        self.data_start_offset + reader_pos + i as u32
                    ));
                }
            } else {
                // Wrap around case
                let first_part = (self.ring_buffer_size - reader_pos) as usize;
                for i in 0..first_part {
                    data.push(self.data_array.get_index(
                        self.data_start_offset + reader_pos + i as u32
                    ));
                }
                let second_part = read_size - first_part;
                for i in 0..second_part {
                    data.push(self.data_array.get_index(
                        self.data_start_offset + i as u32
                    ));
                }
            }
            
            read += read_size;
            
            // Update reader position
            let new_reader_pos = read_end % self.ring_buffer_size;
            self.atomics_store(OFFSET_READER_POS, new_reader_pos as i32);
            
            // Notify writer
            self.atomics_notify(OFFSET_READER_POS);
        }
        
        // Parse JSON response
        serde_json::from_slice(&data)
            .map_err(|e| format!("Failed to parse response: {}", e))
    }
    
    /// Wait for channel to be idle
    fn wait_for_idle(&self) -> Result<(), String> {
        let max_attempts = 1000;  // 1 second timeout
        for _ in 0..max_attempts {
            let status = self.atomics_load(OFFSET_STATUS);
            if status == STATUS_IDLE {
                return Ok(());
            }
            
            // Wait 1ms
            self.atomics_wait(OFFSET_STATUS, status, 1);
        }
        
        Err("Channel busy timeout".to_string())
    }
    
    /// Wait for response
    fn wait_for_response(&self, request_id: i32) -> Result<(), String> {
        let max_attempts = 10000;  // 10 second timeout
        
        for _ in 0..max_attempts {
            let status = self.atomics_load(OFFSET_STATUS);
            
            if status == STATUS_RESPONSE {
                // Verify request ID
                let response_id = self.atomics_load(OFFSET_REQUEST_ID);
                if response_id == request_id {
                    return Ok(());
                }
            } else if status == STATUS_ERROR {
                let error_code = self.atomics_load(OFFSET_ERROR_CODE);
                return Err(format!("Service call error: {}", error_code));
            }
            
            // Wait for status change
            self.atomics_wait(OFFSET_STATUS, STATUS_REQUEST, 10);
        }
        
        Err("Response timeout".to_string())
    }
    
    /// Atomics.load wrapper
    fn atomics_load(&self, offset: u32) -> i32 {
        #[wasm_bindgen(inline_js = "
            export function atomics_load(array, index) {
                return Atomics.load(array, index);
            }
        ")]
        extern "C" {
            fn atomics_load(array: &Int32Array, index: u32) -> i32;
        }
        
        atomics_load(&self.header_array, offset)
    }
    
    /// Atomics.store wrapper
    fn atomics_store(&self, offset: u32, value: i32) {
        #[wasm_bindgen(inline_js = "
            export function atomics_store(array, index, value) {
                return Atomics.store(array, index, value);
            }
        ")]
        extern "C" {
            fn atomics_store(array: &Int32Array, index: u32, value: i32) -> i32;
        }
        
        atomics_store(&self.header_array, offset, value);
    }
    
    /// Atomics.wait wrapper (only in Worker)
    fn atomics_wait(&self, offset: u32, value: i32, timeout: i32) {
        #[wasm_bindgen(inline_js = "
            export function atomics_wait(array, index, value, timeout) {
                try {
                    return Atomics.wait(array, index, value, timeout);
                } catch (e) {
                    // Atomics.wait may not be available in main thread
                    return 'not-equal';
                }
            }
        ")]
        extern "C" {
            fn atomics_wait(array: &Int32Array, index: u32, value: i32, timeout: i32) -> JsValue;
        }
        
        let _ = atomics_wait(&self.header_array, offset, value, timeout);
    }
    
    /// Atomics.notify wrapper
    fn atomics_notify(&self, offset: u32) {
        #[wasm_bindgen(inline_js = "
            export function atomics_notify(array, index, count) {
                return Atomics.notify(array, index, count);
            }
        ")]
        extern "C" {
            fn atomics_notify(array: &Int32Array, index: u32, count: i32) -> i32;
        }
        
        atomics_notify(&self.header_array, offset, 1);
    }
    
    /// Set status
    fn set_status(&self, status: i32) {
        self.atomics_store(OFFSET_STATUS, status);
    }
    
    /// Get SharedArrayBuffer
    pub fn get_buffer(&self) -> &SharedArrayBuffer {
        &self.buffer
    }
}

// Global SharedBuffer channel (thread-local storage)
thread_local! {
    static SHARED_CHANNEL: std::cell::RefCell<Option<SharedBufferChannel>> = std::cell::RefCell::new(None);
}

/// Initialize SharedBuffer channel
pub fn init_shared_channel(buffer: SharedArrayBuffer) {
    SHARED_CHANNEL.with(|channel| {
        match SharedBufferChannel::from_buffer(buffer) {
            Ok(ch) => *channel.borrow_mut() = Some(ch),
            Err(e) => web_sys::console::error_1(&format!("Failed to init shared channel: {:?}", e).into()),
        }
    });
}

/// Use SharedBuffer channel for synchronous calls
pub fn call_service_sync(service: &str, method: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    SHARED_CHANNEL.with(|channel| {
        let channel_ref = channel.borrow();
        match channel_ref.as_ref() {
            Some(ch) => ch.call_sync(service, method, params),
            None => Err("SharedBuffer channel not initialized".to_string())
        }
    })
}