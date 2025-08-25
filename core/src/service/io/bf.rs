use crate::common::{CoreError, CoreResult};
use crate::storage::state::APP_STATE;
use crate::storage::traits::Storage;
use flate2::write::GzEncoder;
use flate2::read::GzDecoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Write, Read};
use tar::{Archive, Builder};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub format_version: String,
    pub export_date: String,
    pub project_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_language: Option<crate::common::Language>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_language: Option<crate::common::Language>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyleEntry {
    id: String,
    #[serde(rename = "overlayText")]
    overlay_text: bool,
    horizontal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageEntry {
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    checksum: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MarkerEntry {
    Point {
        position: [f64; 2],
        style: String,
        text: String,
    },
    Rectangle {
        position: [f64; 2],
        size: [f64; 2],
        style: String,
        text: String,
    },
}

pub fn save_project_to_path(project_id: crate::common::ProjectId, path: &str) -> CoreResult<Vec<u8>> {
    let data = save_project(project_id)?;
    
    // Update the project's file path in storage
    crate::storage::project::update_project_file_path_storage(project_id, Some(path.to_string()))?;
    
    Ok(data)
}

pub fn save_project(project_id: crate::common::ProjectId) -> CoreResult<Vec<u8>> {
    let project = APP_STATE.get_project(project_id)?
        .ok_or_else(|| CoreError::NotFound(format!("Project with id {} not found", project_id.0)))?;
    
    let current_datetime = chrono::Utc::now().to_rfc3339();
    
    // 1. Create metadata.json
    let metadata = ProjectMetadata {
        format_version: "1.0".to_string(),
        export_date: current_datetime,
        project_name: project.name.clone(),
        source_language: Some(project.source_language),
        target_language: Some(project.target_language),
    };
    let metadata_json = serde_json::to_string_pretty(&metadata)?;
    
    // 2. Collect all unique styles and create styles.json
    let mut style_map = HashMap::new();
    let mut style_id_counter = 0;
    let mut styles_list = Vec::new();
    
    // Iterate through all images and markers to collect unique styles
    for image_id in &project.image_ids {
        // Get image to access its marker_ids
        if let Ok(Some(image)) = APP_STATE.get_image(*image_id) {
            for marker_id in &image.marker_ids {
                // Get marker from storage
                let markers_storage = APP_STATE.markers.read()?;
                if let Some(marker) = markers_storage.get(marker_id) {
                    let style_key = (marker.style.overlay_text, marker.style.horizontal);
                    
                    if !style_map.contains_key(&style_key) {
                        let style_id = style_id_counter.to_string();
                        style_map.insert(style_key, style_id.clone());
                        
                        styles_list.push(StyleEntry {
                            id: style_id,
                            overlay_text: marker.style.overlay_text,
                            horizontal: marker.style.horizontal,
                        });
                        
                        style_id_counter += 1;
                    }
                }
            }
        }
    }
    
    // If no styles found, add a default style
    if styles_list.is_empty() {
        styles_list.push(StyleEntry {
            id: "0".to_string(),
            overlay_text: false,
            horizontal: false,
        });
        style_map.insert((false, false), "0".to_string());
    }
    
    let styles_json = serde_json::to_string_pretty(&styles_list)?;
    
    // 3. Create images.json
    let mut images_list = Vec::new();
    for (index, image_id) in project.image_ids.iter().enumerate() {
        if let Ok(Some(image)) = APP_STATE.get_image(*image_id) {
            // Use the original image name if available, otherwise fallback to page_xxx.jpg
            let filename = if let Some(ref name) = image.metadata.name {
                name.clone()
            } else {
                format!("page_{:03}.jpg", index + 1)
            };
            let checksum = image.metadata.checksum.as_ref().map(|cs| format!("md5:{}", cs));
            
            images_list.push(ImageEntry {
                filename,
                checksum,
            });
        }
    }
    let images_json = serde_json::to_string_pretty(&images_list)?;
    
    // 4. Create markers.json
    let mut markers_list = Vec::new();
    
    for image_id in &project.image_ids {
        let mut image_markers = Vec::new();
        
        // Get image to access its marker_ids
        if let Ok(Some(image)) = APP_STATE.get_image(*image_id) {
            for marker_id in &image.marker_ids {
                // Get marker from storage
                let markers_storage = APP_STATE.markers.read()?;
                if let Some(marker) = markers_storage.get(marker_id) {
                    let style_key = (marker.style.overlay_text, marker.style.horizontal);
                    let style_id = style_map.get(&style_key)
                        .ok_or_else(|| CoreError::Internal("Style ID not found".to_string()))?;
                    
                    // Create marker entry based on geometry type
                    let marker_entry = match &marker.geometry {
                        crate::storage::marker::MarkerGeometry::Point { x, y } => {
                            MarkerEntry::Point {
                                position: [*x, *y],
                                style: style_id.clone(),
                                text: marker.translation.clone(),
                            }
                        }
                        crate::storage::marker::MarkerGeometry::Rectangle { x, y, width, height } => {
                            MarkerEntry::Rectangle {
                                position: [*x, *y],
                                size: [*width, *height],
                                style: style_id.clone(),
                                text: marker.translation.clone(),
                            }
                        }
                    };
                    image_markers.push(marker_entry);
                }
            }
        }
        
        markers_list.push(image_markers);
    }
    
    let markers_json = serde_json::to_string_pretty(&markers_list)?;
    
    // 5. Create tar archive with gzip compression
    let tar_gz_data = Vec::new();
    let encoder = GzEncoder::new(tar_gz_data, Compression::default());
    let mut tar = Builder::new(encoder);
    
    // Add files to tar
    add_json_to_tar(&mut tar, "metadata.json", metadata_json.as_bytes())?;
    add_json_to_tar(&mut tar, "styles.json", styles_json.as_bytes())?;
    add_json_to_tar(&mut tar, "images.json", images_json.as_bytes())?;
    add_json_to_tar(&mut tar, "markers.json", markers_json.as_bytes())?;
    
    // Finish writing the tar archive
    let encoder = tar.into_inner()?;
    let compressed_data = encoder.finish()?;
    
    Ok(compressed_data)
}

fn add_json_to_tar<W: Write>(tar: &mut Builder<W>, name: &str, data: &[u8]) -> CoreResult<()> {
    let mut header = tar::Header::new_gnu();
    header.set_path(name)?;
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    
    tar.append(&header, data)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BfProjectData {
    pub metadata: ProjectMetadata,
    pub styles: Vec<StyleEntry>,
    pub images: Vec<ImageEntry>,
    pub markers: Vec<Vec<MarkerEntry>>,
}

pub fn parse_bf_file(data: &[u8]) -> CoreResult<BfProjectData> {
    // Decompress the gzip data
    let mut decoder = GzDecoder::new(data);
    let mut decompressed = Vec::new();
    decoder.read_to_end(&mut decompressed)
        .map_err(|e| CoreError::ValidationFailed {
            field: "bf_file".to_string(),
            reason: format!("Failed to decompress: {}", e),
        })?;
    
    // Parse tar archive
    let mut archive = Archive::new(&decompressed[..]);
    let mut metadata_json = None;
    let mut styles_json = None;
    let mut images_json = None;
    let mut markers_json = None;
    
    for entry_result in archive.entries()? {
        let mut entry = entry_result?;
        let path = entry.path()?.to_string_lossy().to_string();
        
        let mut content = String::new();
        entry.read_to_string(&mut content)?;
        
        match path.as_str() {
            "metadata.json" => metadata_json = Some(content),
            "styles.json" => styles_json = Some(content),
            "images.json" => images_json = Some(content),
            "markers.json" => markers_json = Some(content),
            _ => {}
        }
    }
    
    // Parse JSON files
    let metadata: ProjectMetadata = serde_json::from_str(
        metadata_json.as_ref()
            .ok_or_else(|| CoreError::ValidationFailed {
                field: "metadata.json".to_string(),
                reason: "Missing metadata.json in BF file".to_string(),
            })?
    )?;
    
    let styles: Vec<StyleEntry> = serde_json::from_str(
        styles_json.as_ref()
            .ok_or_else(|| CoreError::ValidationFailed {
                field: "styles.json".to_string(),
                reason: "Missing styles.json in BF file".to_string(),
            })?
    )?;
    
    let images: Vec<ImageEntry> = serde_json::from_str(
        images_json.as_ref()
            .ok_or_else(|| CoreError::ValidationFailed {
                field: "images.json".to_string(),
                reason: "Missing images.json in BF file".to_string(),
            })?
    )?;
    
    let markers: Vec<Vec<MarkerEntry>> = serde_json::from_str(
        markers_json.as_ref()
            .ok_or_else(|| CoreError::ValidationFailed {
                field: "markers.json".to_string(),
                reason: "Missing markers.json in BF file".to_string(),
            })?
    )?;
    
    // Validate data consistency
    if markers.len() != images.len() {
        return Err(CoreError::ValidationFailed {
            field: "markers".to_string(),
            reason: format!("Markers array length ({}) doesn't match images array length ({})", 
                markers.len(), images.len()),
        });
    }
    
    Ok(BfProjectData {
        metadata,
        styles,
        images,
        markers,
    })
}

pub fn import_bf_data_direct(
    project_id: crate::common::ProjectId,
    bf_data: BfProjectData,
) -> CoreResult<()> {
    use crate::common::{ImageId, MarkerId, MARKER_ID_GENERATOR};
    use crate::storage::marker::{Marker, MarkerStyle};
    use std::sync::Arc;
    
    // Get project images to match with BF file image names
    let project_storage = APP_STATE.projects.read()?;
    let project = project_storage.get(&project_id)
        .ok_or_else(|| CoreError::NotFound(format!("Project with id {} not found", project_id.0)))?;
    let image_ids = project.image_ids.clone();
    drop(project_storage);
    
    // Build image name/checksum to ID mapping
    let mut image_mapping: Vec<Option<ImageId>> = Vec::new();
    let image_storage = APP_STATE.images.read()?;
    
    for bf_image in &bf_data.images {
        let mut matched_image_id = None;
        
        // First try to match by checksum if available
        if let Some(ref checksum) = bf_image.checksum {
            // Remove "md5:" prefix if present
            let checksum_value = checksum.strip_prefix("md5:").unwrap_or(checksum);
            
            for image_id in &image_ids {
                if let Some(image) = image_storage.get(image_id) {
                    if let Some(ref img_checksum) = image.metadata.checksum {
                        if img_checksum == checksum_value {
                            matched_image_id = Some(*image_id);
                            break;
                        }
                    }
                }
            }
        }
        
        // If no checksum match, try to match by filename
        if matched_image_id.is_none() {
            for image_id in &image_ids {
                if let Some(image) = image_storage.get(image_id) {
                    if let Some(ref name) = image.metadata.name {
                        if name == &bf_image.filename {
                            matched_image_id = Some(*image_id);
                            break;
                        }
                    }
                }
            }
        }
        
        image_mapping.push(matched_image_id);
    }
    drop(image_storage);
    
    // Build style ID to MarkerStyle mapping
    let mut style_map: HashMap<String, MarkerStyle> = HashMap::new();
    for style in &bf_data.styles {
        style_map.insert(style.id.clone(), MarkerStyle {
            overlay_text: style.overlay_text,
            horizontal: style.horizontal,
        });
    }
    
    // Import markers for each image
    let mut marker_storage = APP_STATE.markers.write()?;
    let mut image_updates: HashMap<ImageId, Vec<MarkerId>> = HashMap::new();
    
    for (_image_index, (image_markers, matched_image_id)) in bf_data.markers.iter().zip(image_mapping.iter()).enumerate() {
        if let Some(image_id) = matched_image_id {
            let mut marker_ids_for_image = Vec::new();
            
            // Import markers for this image
            for (marker_index, bf_marker) in image_markers.iter().enumerate() {
                let marker_id = MARKER_ID_GENERATOR.next();
                
                // Get style and text based on marker type
                let (style_id, text) = match bf_marker {
                    MarkerEntry::Point { style, text, .. } => (style, text),
                    MarkerEntry::Rectangle { style, text, .. } => (style, text),
                };
                
                // Get style from style map
                let style = style_map.get(style_id)
                    .cloned()
                    .unwrap_or(MarkerStyle {
                        overlay_text: false,
                        horizontal: false,
                    });
                
                // Create geometry based on marker type
                let geometry = match bf_marker {
                    MarkerEntry::Point { position, .. } => {
                        crate::storage::marker::MarkerGeometry::Point {
                            x: position[0],
                            y: position[1],
                        }
                    }
                    MarkerEntry::Rectangle { position, size, .. } => {
                        crate::storage::marker::MarkerGeometry::Rectangle {
                            x: position[0],
                            y: position[1],
                            width: size[0],
                            height: size[1],
                        }
                    }
                };
                
                let marker = Marker {
                    id: marker_id,
                    image_id: *image_id,
                    geometry,
                    translation: text.clone(),
                    style,
                    image_index: (marker_index + 1) as u32,
                };
                
                // Insert directly into storage
                marker_storage.markers.insert(marker_id, marker);
                marker_storage.by_image.entry(*image_id).or_default().push(marker_id);
                marker_ids_for_image.push(marker_id);
            }
            
            // Collect marker IDs to update images later
            if !marker_ids_for_image.is_empty() {
                image_updates.insert(*image_id, marker_ids_for_image);
            }
        }
    }
    
    // Release marker storage lock before updating images
    drop(marker_storage);
    
    // Update all images with their new markers in a single operation
    let mut image_storage = APP_STATE.images.write()?;
    for (image_id, marker_ids) in image_updates {
        if let Some(image_arc) = image_storage.get_mut(&image_id) {
            // We need to clone the Arc to modify the image
            if let Some(image) = Arc::get_mut(image_arc) {
                image.marker_ids.extend(marker_ids);
            } else {
                // If we can't get mutable access, we need to clone
                let mut image = (**image_arc).clone();
                image.marker_ids.extend(marker_ids);
                *image_arc = Arc::new(image);
            }
        }
    }
    drop(image_storage);
    
    Ok(())
}