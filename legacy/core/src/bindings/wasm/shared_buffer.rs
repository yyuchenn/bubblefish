
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// SharedArrayBuffer streaming implementation for WASM
/// Matches the TypeScript implementation for efficient data transfer
#[cfg(feature = "wasm")]
pub mod wasm_stream {
    use js_sys::{SharedArrayBuffer, Int32Array, Uint8Array};
    
    const HEADER_SIZE: usize = 32;
    const HEADER_ELEMENTS: usize = HEADER_SIZE / 4; // Int32Array elements
    
    #[derive(Debug, Clone, Copy)]
    pub enum StreamStatus {
        Idle = 0,
        Writing = 1,
        Reading = 2,
        Complete = 3,
        Error = 4,
    }
    
    #[derive(Debug, Clone, Copy)]
    pub enum DataFormatEnum {
        // Image formats
        Jpeg = 0,
        Png = 1,
        Gif = 2,
        Webp = 3,
        Bmp = 4,
        // Project formats
        Labelplus = 10,
        Bubblefish = 11,
    }
    
    impl DataFormatEnum {
        pub fn to_image_format(&self) -> Option<crate::common::dto::image::ImageFormat> {
            match self {
                DataFormatEnum::Jpeg => Some(crate::common::dto::image::ImageFormat::Jpeg),
                DataFormatEnum::Png => Some(crate::common::dto::image::ImageFormat::Png),
                DataFormatEnum::Gif => Some(crate::common::dto::image::ImageFormat::Gif),
                DataFormatEnum::Webp => Some(crate::common::dto::image::ImageFormat::Webp),
                DataFormatEnum::Bmp => Some(crate::common::dto::image::ImageFormat::Bmp),
                _ => None,
            }
        }
        
        pub fn to_project_format(&self) -> Option<crate::common::dto::project_format::ProjectFormat> {
            match self {
                DataFormatEnum::Labelplus => Some(crate::common::dto::project_format::ProjectFormat::Labelplus),
                DataFormatEnum::Bubblefish => Some(crate::common::dto::project_format::ProjectFormat::Bubblefish),
                _ => None,
            }
        }
        
        pub fn from_image_format(format: crate::common::dto::image::ImageFormat) -> Self {
            match format {
                crate::common::dto::image::ImageFormat::Jpeg => DataFormatEnum::Jpeg,
                crate::common::dto::image::ImageFormat::Png => DataFormatEnum::Png,
                crate::common::dto::image::ImageFormat::Gif => DataFormatEnum::Gif,
                crate::common::dto::image::ImageFormat::Webp => DataFormatEnum::Webp,
                crate::common::dto::image::ImageFormat::Bmp => DataFormatEnum::Bmp,
            }
        }
        
        pub fn from_project_format(format: crate::common::dto::project_format::ProjectFormat) -> Self {
            match format {
                crate::common::dto::project_format::ProjectFormat::Labelplus => DataFormatEnum::Labelplus,
                crate::common::dto::project_format::ProjectFormat::Bubblefish => DataFormatEnum::Bubblefish,
            }
        }
    }
    
    pub struct SharedBufferReader {
        header_array: Int32Array,
        data_array: Uint8Array,
        pub buffer_data_size: usize,
    }
    
    impl SharedBufferReader {
        /// Create a new reader from a SharedArrayBuffer
        pub fn new(buffer: SharedArrayBuffer) -> Result<Self, String> {
            let buffer_length = buffer.byte_length() as usize;
            if buffer_length < HEADER_SIZE {
                return Err("Buffer too small for header".to_string());
            }
            
            // Create views for header and data
            let header_array = Int32Array::new_with_byte_offset_and_length(
                &buffer,
                0,
                HEADER_ELEMENTS as u32
            );
            
            let data_array = Uint8Array::new_with_byte_offset(
                &buffer,
                HEADER_SIZE as u32
            );
            
            let buffer_data_size = buffer_length - HEADER_SIZE;
            
            Ok(Self {
                header_array,
                data_array,
                buffer_data_size,
            })
        }
        
        /// Read header information atomically
        pub fn read_header(&self) -> StreamHeader {
            StreamHeader {
                writer_position: self.atomic_load(0) as usize,
                reader_position: self.atomic_load(1) as usize,
                total_size: self.atomic_load(2) as usize,
                chunk_size: self.atomic_load(3) as usize,
                status: self.atomic_load(4),
                data_id: self.atomic_load(5) as u32,
                format: self.atomic_load(6),
                reserved: self.atomic_load(7),
            }
        }
        
        /// Read all available data from the stream
        pub async fn read_data(&self) -> Result<Vec<u8>, String> {
            let header = self.read_header();
            let total_size = header.total_size;
            let mut data = Vec::with_capacity(total_size);
            let mut total_read = 0;
            
            // Set status to reading
            self.atomic_store(4, StreamStatus::Reading as i32);
            
            while total_read < total_size {
                let writer_pos = self.atomic_load(0) as usize;
                let reader_pos = self.atomic_load(1) as usize;
                
                // Calculate available data
                let available = if writer_pos >= reader_pos {
                    writer_pos - reader_pos
                } else {
                    self.buffer_data_size - reader_pos + writer_pos
                };
                
                if available == 0 {
                    // No data available, check status
                    let status = self.atomic_load(4);
                    if status == StreamStatus::Complete as i32 && total_read >= total_size {
                        break;
                    }
                    if status == StreamStatus::Error as i32 {
                        return Err("Stream error".to_string());
                    }
                    
                    // Wait for more data
                    self.wait_for_data().await;
                    continue;
                }
                
                // Read available data
                let read_size = available.min(total_size - total_read);
                
                if reader_pos + read_size <= self.buffer_data_size {
                    // Simple case: continuous read
                    let chunk = self.read_chunk(reader_pos, read_size)?;
                    data.extend_from_slice(&chunk);
                } else {
                    // Wrap around case
                    let first_part = self.buffer_data_size - reader_pos;
                    let second_part = read_size - first_part;
                    
                    let chunk1 = self.read_chunk(reader_pos, first_part)?;
                    data.extend_from_slice(&chunk1);
                    
                    let chunk2 = self.read_chunk(0, second_part)?;
                    data.extend_from_slice(&chunk2);
                }
                
                total_read += read_size;
                
                // Update reader position
                let new_reader_pos = (reader_pos + read_size) % self.buffer_data_size;
                self.atomic_store(1, new_reader_pos as i32);
                
                // Notify writer that space is available
                self.notify_writer();
            }
            
            // Verify we read the expected amount
            if data.len() != total_size {
                return Err(format!("Read size mismatch: expected {}, got {}", total_size, data.len()));
            }
            
            Ok(data)
        }
        
        /// Read a chunk of data from the buffer
        pub fn read_chunk(&self, offset: usize, length: usize) -> Result<Vec<u8>, String> {
            // Ensure we don't read beyond the buffer bounds
            if offset >= self.buffer_data_size {
                return Err(format!("Offset {} is beyond buffer size {}", offset, self.buffer_data_size));
            }
            
            let actual_length = length.min(self.buffer_data_size - offset);
            let mut chunk = vec![0u8; actual_length];
            
            for i in 0..actual_length {
                chunk[i] = self.data_array.get_index((offset + i) as u32) as u8;
            }
            Ok(chunk)
        }
        
        /// Atomic load operation
        pub fn atomic_load(&self, index: usize) -> i32 {
            self.header_array.get_index(index as u32)
        }
        
        /// Atomic store operation
        pub fn atomic_store(&self, index: usize, value: i32) {
            self.header_array.set_index(index as u32, value);
        }
        
        /// Wait for new data to be available
        async fn wait_for_data(&self) {
            // In WASM, we can't use Atomics.wait, so we'll use a small delay
            wasm_bindgen_futures::JsFuture::from(
                js_sys::Promise::new(&mut |resolve, _| {
                    web_sys::window()
                        .unwrap()
                        .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 1)
                        .unwrap();
                })
            ).await.unwrap();
        }
        
        /// Notify writer that reader has consumed data
        fn notify_writer(&self) {
            // In JS, this would be Atomics.notify
            // Since we can't directly call it from Rust, we'll rely on polling
        }
    }
    
    #[derive(Debug)]
    pub struct StreamHeader {
        pub writer_position: usize,
        pub reader_position: usize,
        pub total_size: usize,
        pub chunk_size: usize,
        pub status: i32,
        pub data_id: u32,
        pub format: i32,
        pub reserved: i32,
    }
}

/// Non-WASM placeholder
#[cfg(not(feature = "wasm"))]
pub mod wasm_stream {
    pub struct SharedBufferReader;
    
    impl SharedBufferReader {
        pub fn new(_buffer: ()) -> Result<Self, String> {
            Err("SharedArrayBuffer is only available in WASM".to_string())
        }
    }
}

// Re-export for easier access
pub use wasm_stream::SharedBufferReader;


// Re-export SharedArrayBuffer init function for data_bindings
#[cfg(feature = "wasm")]
pub use wasm_stream::DataFormatEnum;

// Thread-local storage for SharedBufferReader to avoid Send issues
#[cfg(feature = "wasm")]
thread_local! {
    static SHARED_BUFFER_READER: std::cell::RefCell<Option<SharedBufferReader>> = std::cell::RefCell::new(None);
}

/// Initialize the shared buffer reader with a SharedArrayBuffer from JS (internal implementation)
#[cfg(feature = "wasm")]
pub fn init_shared_buffer_impl(buffer: js_sys::SharedArrayBuffer) -> Result<(), JsValue> {
    let reader = SharedBufferReader::new(buffer)
        .map_err(|e| JsValue::from_str(&e))?;
    
    SHARED_BUFFER_READER.with(|r| {
        *r.borrow_mut() = Some(reader);
    });
    
    Ok(())
}

/// Read data from the shared buffer
#[cfg(feature = "wasm")]
pub async fn read_data_from_shared_buffer() -> Result<(u32, DataFormatEnum, Vec<u8>), String> {
    // We need to clone the data out of the RefCell to avoid holding the borrow across await
    let (data_id, format_num, total_size) = SHARED_BUFFER_READER.with(|r| {
        let reader_ref = r.borrow();
        let reader = reader_ref.as_ref()
            .ok_or("Shared buffer not initialized")?;
        
        let header = reader.read_header();
        Ok::<_, String>((header.data_id, header.format, header.total_size))
    })?;
    
    let format = match format_num {
        0 => DataFormatEnum::Jpeg,
        1 => DataFormatEnum::Png,
        2 => DataFormatEnum::Gif,
        3 => DataFormatEnum::Webp,
        4 => DataFormatEnum::Bmp,
        10 => DataFormatEnum::Labelplus,
        _ => return Err("Invalid data format".to_string()),
    };
    
    // Read the actual image data in chunks to avoid holding the borrow
    let mut data = Vec::with_capacity(total_size);
    let mut total_read = 0;
    
    while total_read < total_size {
        // Read a chunk
        let chunk = SHARED_BUFFER_READER.with(|r| {
            let reader_ref = r.borrow();
            let reader = reader_ref.as_ref()
                .ok_or("Shared buffer not initialized")?;
            
            let header = reader.read_header();
            let writer_pos = header.writer_position;
            let reader_pos = header.reader_position;
            
            // Calculate available data
            let available = if writer_pos >= reader_pos {
                writer_pos - reader_pos
            } else {
                reader.buffer_data_size - reader_pos + writer_pos
            };
            
            if available == 0 {
                return Ok::<Option<Vec<u8>>, String>(None);
            }
            
            // Read available data
            let read_size = available.min(total_size - total_read);
            let chunk = reader.read_chunk(reader_pos, read_size)?;
            
            // Update reader position
            let new_reader_pos = (reader_pos + read_size) % reader.buffer_data_size;
            reader.atomic_store(1, new_reader_pos as i32);
            
            Ok(Some(chunk))
        })?;
        
        match chunk {
            Some(chunk_data) => {
                total_read += chunk_data.len();
                data.extend_from_slice(&chunk_data);
            }
            None => {
                // Check if complete
                let status = SHARED_BUFFER_READER.with(|r| {
                    let reader_ref = r.borrow();
                    let reader = reader_ref.as_ref().unwrap();
                    reader.atomic_load(4)
                });
                
                if status == 3 && total_read >= total_size {
                    break;
                }
                if status == 4 {
                    return Err("Stream error".to_string());
                }
                
                // Wait a bit
                wasm_bindgen_futures::JsFuture::from(
                    js_sys::Promise::new(&mut |resolve, _| {
                        web_sys::window()
                            .unwrap()
                            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 1)
                            .unwrap();
                    })
                ).await.unwrap();
            }
        }
    }
    
    Ok((data_id, format, data))
}

/// Add image from SharedArrayBuffer (internal implementation)
#[cfg(feature = "wasm")]
pub async fn add_image_from_shared_buffer_impl(project_id: u32, name: Option<String>) -> Result<u32, JsValue> {
    // Read data from shared buffer
    let (_, format, data) = read_data_from_shared_buffer().await
        .map_err(|e| JsValue::from_str(&e))?;
    
    // Convert format and add to project
    let image_format = format.to_image_format()
        .ok_or_else(|| JsValue::from_str("Not an image format"))?;
    
    let image_id = crate::api::add_image_from_binary_to_project(project_id, image_format, data, name)
        .ok_or_else(|| JsValue::from_str("Failed to add image to project"))?;
    
    Ok(image_id)
}


/// Create opening project from SharedArrayBuffer with file type detection (internal implementation)
#[cfg(feature = "wasm")]
pub async fn create_opening_project_from_shared_buffer_with_type_impl(file_extension: String, project_name: String) -> Result<u32, JsValue> {
    // Read data from shared buffer
    let (_, format, data) = read_data_from_shared_buffer().await
        .map_err(|e| JsValue::from_str(&e))?;
    
    // Verify it's a project format
    if format.to_project_format().is_none() {
        return Err(JsValue::from_str("Not a project format"));
    }
    
    // Create opening project with file type
    crate::api::create_opening_project_from_binary(data, file_extension, project_name)
        .map_err(|e| JsValue::from_str(&e))
}

