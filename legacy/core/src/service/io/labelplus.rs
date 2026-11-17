use crate::common::{CoreError, CoreResult};
use crate::common::{ProjectId, ImageId, MarkerId, MARKER_ID_GENERATOR};
use crate::storage::state::APP_STATE;
use crate::storage::traits::Storage;
use crate::storage::marker::{Marker, MarkerStyle, MarkerGeometry};
use std::collections::HashMap;
use std::sync::Arc;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerTypeStyleConfig {
    pub overlay_text: bool,
    pub horizontal: bool,
}

impl Default for MarkerTypeStyleConfig {
    fn default() -> Self {
        Self {
            overlay_text: false,
            horizontal: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerTypeMapping {
    pub name: String,
    pub style: MarkerTypeStyleConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerTypeStyleMapping {
    // Use Vec to maintain order - first match wins
    pub type_mappings: Vec<MarkerTypeMapping>,
    pub fallback_style: MarkerTypeStyleConfig,
}

impl Default for MarkerTypeStyleMapping {
    fn default() -> Self {
        Self {
            type_mappings: Vec::new(),
            fallback_style: MarkerTypeStyleConfig::default(),
        }
    }
}

// 获取默认的样式映射配置
// 在这里配置类型名称到样式的映射
// 优先匹配排在前面的
fn get_default_style_mapping() -> MarkerTypeStyleMapping {
    let type_mappings = vec![
        MarkerTypeMapping {
            name: "inside+vertical".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: false,
                horizontal: false,
            },
        },

        MarkerTypeMapping {
            name: "overlay+vertical".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: true,
                horizontal: false,
            },
        },

        MarkerTypeMapping {
            name: "inside+horizontal".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: false,
                horizontal: true,
            },
        },

        MarkerTypeMapping {
            name: "overlay+horizontal".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: true,
                horizontal: true,
            },
        },

        // 框外 - 兼容旧版本, 只在导入时使用
        MarkerTypeMapping {
            name: "框外".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: true,
                horizontal: false,
            },
        },
        // 框内 - 兼容旧版本, 只在导入时使用
        MarkerTypeMapping {
            name: "框内".to_string(),
            style: MarkerTypeStyleConfig {
                overlay_text: false,
                horizontal: false,
            },
        },
    ];
    
    MarkerTypeStyleMapping {
        type_mappings,
        fallback_style: MarkerTypeStyleConfig {
            overlay_text: false,
            horizontal: false,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelplusMarkerType {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelplusMarker {
    pub image_index: u32,
    pub x: f64,
    pub y: f64,
    pub type_id: u32,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelplusData {
    pub marker_types: Vec<LabelplusMarkerType>,
    pub markers_by_image: HashMap<String, Vec<LabelplusMarker>>,
    pub image_order: Vec<String>,  // 保持图片的原始顺序
}

pub fn parse_labelplus_file(content: &str) -> CoreResult<LabelplusData> {
    // Remove UTF-8 BOM if present
    let content = if content.starts_with('\u{feff}') {
        &content[3..]  // UTF-8 BOM is 3 bytes
    } else {
        content
    };
    
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Err(CoreError::ValidationFailed {
            field: "content".to_string(),
            reason: "空文件".to_string(),
        });
    }

    // Parse header
    let mut idx = 0;
    
    // Parse magic number (always "1,0")
    let magic = lines[idx].trim();
    if magic != "1,0" {
        return Err(CoreError::ValidationFailed {
            field: "magic_number".to_string(),
            reason: format!("无效的魔法数字，期望 '1,0'，实际为 '{}'", magic),
        });
    }
    idx += 1;

    // Check separator
    if idx >= lines.len() || lines[idx].trim() != "-" {
        return Err(CoreError::ValidationFailed {
            field: "separator".to_string(),
            reason: "缺少分隔符'-'".to_string(),
        });
    }
    idx += 1;

    // Parse type names until we find the second separator
    let mut marker_types = Vec::new();
    let mut type_id = 1u32;
    
    while idx < lines.len() && lines[idx].trim() != "-" {
        let type_name = lines[idx].to_string();
        
        // Only add first 9 types
        if type_id <= 9 {
            marker_types.push(LabelplusMarkerType {
                id: type_id,
                name: type_name,
            });
            type_id += 1;
        }
        
        idx += 1;
    }

    // Check second separator
    if idx >= lines.len() || lines[idx].trim() != "-" {
        return Err(CoreError::ValidationFailed {
            field: "separator".to_string(),
            reason: "缺少第二个分隔符'-'".to_string(),
        });
    }
    idx += 1;

    // Skip project comments until we find image separator
    while idx < lines.len() && !lines[idx].starts_with(">>>>>>>>") {
        idx += 1;
    }

    // Parse image data
    let mut markers_by_image = HashMap::new();
    let mut image_order = Vec::new();  // 记录图片顺序
    let mut current_image: Option<String> = None;
    let mut current_markers: Vec<LabelplusMarker> = Vec::new();

    while idx < lines.len() {
        let line = lines[idx];
        
        // Check for image separator
        if line.starts_with(">>>>>>>>[") && line.ends_with("]<<<<<<<<") {
            // Save previous image markers (even if empty)
            if let Some(img_name) = current_image.take() {
                // Always insert the image, even with empty markers
                markers_by_image.insert(img_name, std::mem::take(&mut current_markers));
            }
            
            // Extract new image name
            let start = line.find('[').unwrap() + 1;
            let end = line.rfind(']').unwrap();
            let img_name = line[start..end].to_string();
            image_order.push(img_name.clone());  // 记录图片顺序
            current_image = Some(img_name);
            idx += 1;
            continue;
        }
        
        // Check for marker separator
        if line.starts_with("----------------[") && line.contains("]----------------[") {
            // Parse marker info
            let parts: Vec<&str> = line.split("]----------------[").collect();
            if parts.len() != 2 {
                return Err(CoreError::ValidationFailed {
                    field: "marker_format".to_string(),
                    reason: "无效的标记格式".to_string(),
                });
            }
            
            // Extract index
            let index_str = parts[0].trim_start_matches('-').trim_start_matches('[');
            let image_index = index_str.parse::<u32>()
                .map_err(|e| CoreError::ValidationFailed {
                    field: "image_index".to_string(),
                    reason: format!("无效的标记序号: {}", e),
                })?;
            
            // Extract coordinates and type
            let coord_part = parts[1].trim_end_matches(']');
            let coords: Vec<&str> = coord_part.split(',').collect();
            if coords.len() != 3 {
                return Err(CoreError::ValidationFailed {
                    field: "coordinates".to_string(),
                    reason: "坐标格式错误".to_string(),
                });
            }
            
            let x = coords[0].trim().parse::<f64>()
                .map_err(|e| CoreError::ValidationFailed {
                    field: "x_coordinate".to_string(),
                    reason: format!("无效的X坐标: {}", e),
                })?;
            let y = coords[1].trim().parse::<f64>()
                .map_err(|e| CoreError::ValidationFailed {
                    field: "y_coordinate".to_string(),
                    reason: format!("无效的Y坐标: {}", e),
                })?;
            let type_id = coords[2].trim().parse::<u32>()
                .map_err(|e| CoreError::ValidationFailed {
                    field: "marker_type_id".to_string(),
                    reason: format!("无效的类型ID: {}", e),
                })?;
            
            // Validate type_id exists (1-9 or matches defined types)
            if type_id < 1 || type_id > marker_types.len() as u32 {
                return Err(CoreError::ValidationFailed {
                    field: "type_id".to_string(),
                    reason: format!("未定义的类型ID: {}，应在1-{}范围内", type_id, marker_types.len()),
                });
            }
            
            // Read translation text
            let mut translation_lines = Vec::new();
            idx += 1;
            
            while idx < lines.len() {
                let next_line = lines[idx];
                if next_line.starts_with("----------------[") || next_line.starts_with(">>>>>>>>") {
                    break;
                }
                translation_lines.push(next_line);
                idx += 1;
            }
            
            // Remove trailing empty lines
            while translation_lines.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
                translation_lines.pop();
            }
            
            let translation = translation_lines.join("\n");
            
            current_markers.push(LabelplusMarker {
                image_index,
                x,
                y,
                type_id,
                translation,
            });
            
            continue;
        }
        
        idx += 1;
    }
    
    // Save last image markers (even if empty)
    if let Some(img_name) = current_image {
        // Always insert the image, even with empty markers
        markers_by_image.insert(img_name, current_markers);
    }

    Ok(LabelplusData {
        marker_types,
        markers_by_image,
        image_order,
    })
}

// Direct import without triggering undo/redo
pub fn import_labelplus_data_direct(
    project_id: ProjectId,
    labelplus_data: LabelplusData,
) -> CoreResult<()> {
    // 使用内置的默认样式映射
    let style_mapping = Some(get_default_style_mapping());
    // Get project images to match with translation file image names
    let project_storage = APP_STATE.projects.read()?;
    let project = project_storage.get(&project_id)
        .ok_or_else(|| CoreError::NotFound(format!("Project with id {} not found", project_id.0)))?;
    let image_ids = project.image_ids.clone();
    drop(project_storage);

    // Build image name to ID mapping
    let mut image_name_to_id = HashMap::new();
    let image_storage = APP_STATE.images.read()?;
    for image_id in &image_ids {
        if let Some(image) = image_storage.get(image_id) {
            let name = image.metadata.name.clone().unwrap_or_else(|| format!("image_{}", image_id.0));
            image_name_to_id.insert(name, *image_id);
        }
    }
    drop(image_storage);

    // Build type_id to name mapping for style lookup (types are numbered 1-9)
    let mut type_id_to_name: HashMap<u32, String> = HashMap::new();
    for marker_type in &labelplus_data.marker_types {
        type_id_to_name.insert(marker_type.id, marker_type.name.clone());
    }
    
    // Import markers for each image
    let mut marker_storage = APP_STATE.markers.write()?;
    let mut image_updates: HashMap<ImageId, Vec<MarkerId>> = HashMap::new();
    
    for (image_name, markers) in labelplus_data.markers_by_image {
        if let Some(&image_id) = image_name_to_id.get(&image_name) {
            let mut marker_ids_for_image = Vec::new();
            
            // Import markers for this image
            for trans_marker in markers {
                let marker_id = MARKER_ID_GENERATOR.next();
                
                // Convert normalized coordinates (0-1) to percentage (0-100)
                // Frontend uses percentage coordinates, not pixel coordinates
                let percentage_x = trans_marker.x * 100.0;
                let percentage_y = trans_marker.y * 100.0;
                
                // Determine style based on type mapping
                let style = if let Some(ref mapping) = style_mapping {
                    // Try to find the type name for this type_id
                    if let Some(type_name) = type_id_to_name.get(&trans_marker.type_id) {
                        // Try to find a style mapping for this type name (first match wins)
                        let style_config = mapping.type_mappings.iter()
                            .find(|m| &m.name == type_name)
                            .map(|m| &m.style);
                        
                        if let Some(style_config) = style_config {
                            MarkerStyle {
                                overlay_text: style_config.overlay_text,
                                horizontal: style_config.horizontal,
                            }
                        } else {
                            // Use fallback style if no mapping found
                            MarkerStyle {
                                overlay_text: mapping.fallback_style.overlay_text,
                                horizontal: mapping.fallback_style.horizontal,
                            }
                        }
                    } else {
                        // Type ID not found, use fallback
                        MarkerStyle {
                            overlay_text: mapping.fallback_style.overlay_text,
                            horizontal: mapping.fallback_style.horizontal,
                        }
                    }
                } else {
                    // No style mapping provided, use default behavior
                    MarkerStyle {
                        overlay_text: trans_marker.type_id == 0,
                        horizontal: false,
                    }
                };
                
                // LabelPlus格式只支持点型标记
                let marker = Marker {
                    id: marker_id,
                    image_id,
                    geometry: MarkerGeometry::Point { x: percentage_x, y: percentage_y },
                    translation: trans_marker.translation,
                    style,
                    image_index: trans_marker.image_index,
                };
                
                // Insert directly into storage
                marker_storage.markers.insert(marker_id, marker);
                marker_storage.by_image.entry(image_id).or_default().push(marker_id);
                marker_ids_for_image.push(marker_id);
            }
            
            // Collect marker IDs to update images later
            image_updates.insert(image_id, marker_ids_for_image);
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

// Validate labelplus file without importing
pub fn validate_labelplus_file(content: &str) -> CoreResult<LabelplusData> {
    parse_labelplus_file(content)
}

// Export project data to labelplus format
pub fn export_labelplus_data(project_id: ProjectId) -> CoreResult<String> {
    // Get project data
    let project_storage = APP_STATE.projects.read()?;
    let project = project_storage.get(&project_id)
        .ok_or_else(|| CoreError::NotFound(format!("Project with id {} not found", project_id.0)))?;
    let image_ids = project.image_ids.clone();
    let source_language = project.source_language;
    let target_language = project.target_language;
    drop(project_storage);

    // Get markers and build type mappings
    let marker_storage = APP_STATE.markers.read()?;
    let mut markers_by_image: HashMap<String, Vec<LabelplusMarker>> = HashMap::new();
    
    // Collect all unique marker styles
    let mut unique_styles: Vec<(bool, bool)> = Vec::new();
    let mut style_to_type_id: HashMap<(bool, bool), u32> = HashMap::new();
    
    for image_id in &image_ids {
        if let Some(marker_ids) = marker_storage.by_image.get(image_id) {
            for marker_id in marker_ids {
                if let Some(marker) = marker_storage.markers.get(marker_id) {
                    let style_key = (marker.style.overlay_text, marker.style.horizontal);
                    if !unique_styles.contains(&style_key) {
                        unique_styles.push(style_key);
                    }
                }
            }
        }
    }
    
    // Assign type IDs (1-9) to unique styles
    let style_mapping = get_default_style_mapping();
    let mut type_id_to_name: Vec<String> = Vec::new();
    
    for (index, style_key) in unique_styles.iter().enumerate() {
        let type_id = if index < 9 {
            (index + 1) as u32
        } else {
            9u32  // All styles beyond 9 use type ID 9
        };
        
        style_to_type_id.insert(*style_key, type_id);
        
        // Only add type names up to 9
        if type_id_to_name.len() < 9 {
            // Find matching type name from style mapping
            let found_name = style_mapping.type_mappings.iter()
                .find(|m| m.style.overlay_text == style_key.0 && m.style.horizontal == style_key.1)
                .map(|m| m.name.clone());
            
            let type_name = if index >= 8 && unique_styles.len() > 9 {
                // If this is type 9 and there are more than 9 types, name it "others"
                "others".to_string()
            } else {
                // Use found name or "fallback" if not found in mapping
                found_name.unwrap_or_else(|| "fallback".to_string())
            };
            
            type_id_to_name.push(type_name);
        }
    }
    
    // If no markers found, create a single fallback type
    if unique_styles.is_empty() {
        type_id_to_name.push("fallback".to_string());
        // Map the fallback style to type ID 1
        style_to_type_id.insert((false, false), 1);
    }
    
    // Get image names and collect markers
    let image_storage = APP_STATE.images.read()?;
    let mut ordered_images: Vec<(String, ImageId)> = Vec::new();
    
    for image_id in &image_ids {
        if let Some(image) = image_storage.get(image_id) {
            let name = image.metadata.name.clone()
                .unwrap_or_else(|| format!("{:02}.jpeg", ordered_images.len()));
            ordered_images.push((name.clone(), *image_id));
            
            // Collect markers for this image
            if let Some(marker_ids) = marker_storage.by_image.get(image_id) {
                let mut image_markers = Vec::new();
                
                for marker_id in marker_ids {
                    if let Some(marker) = marker_storage.markers.get(marker_id) {
                        // 根据marker的geometry类型导出不同的坐标
                        let (export_x, export_y) = match &marker.geometry {
                            MarkerGeometry::Point { x, y } => (*x, *y),
                            MarkerGeometry::Rectangle { x, y, width, .. } => {
                                // 矩形上边中点坐标
                                (x + width / 2.0, *y)
                            }
                        };
                        
                        // Convert percentage coordinates (0-100) to normalized (0-1)
                        let normalized_x = export_x / 100.0;
                        let normalized_y = export_y / 100.0;
                        
                        // Get type ID for this marker's style
                        let style_key = (marker.style.overlay_text, marker.style.horizontal);
                        let type_id = *style_to_type_id.get(&style_key).unwrap_or(&1);
                        
                        image_markers.push(LabelplusMarker {
                            image_index: marker.image_index,
                            x: normalized_x,
                            y: normalized_y,
                            type_id,
                            translation: marker.translation.clone(),
                        });
                    }
                }
                
                // Sort markers by image_index to maintain order
                image_markers.sort_by_key(|m| m.image_index);
                
                if !image_markers.is_empty() {
                    markers_by_image.insert(name, image_markers);
                }
            }
        }
    }
    
    drop(image_storage);
    drop(marker_storage);
    
    // Build the output string
    let mut output = String::new();
    
    // Write magic number (always "1,0")
    output.push_str("1,0\r\n");
    
    // Write separator
    output.push_str("-\r\n");
    
    // Write type names (up to 9)
    for type_name in &type_id_to_name {
        output.push_str(type_name);
        output.push_str("\r\n");
    }
    
    // Write second separator
    output.push_str("-\r\n");
    
    // Write optional project comment with language info
    output.push_str(&format!("Exported from Bubblefish | Source: {} | Target: {}\r\n", 
        source_language, target_language));
    
    // Write image data
    for (image_name, _) in ordered_images {
        // Always write image separator, even if no markers
        output.push_str(&format!(">>>>>>>>[{}]<<<<<<<<\r\n", image_name));
        
        // Write markers if they exist
        if let Some(markers) = markers_by_image.get(&image_name) {
            // Write markers for this image
            for (index, marker) in markers.iter().enumerate() {
                // Write marker header
                let marker_number = index + 1; // Marker numbers start from 1
                output.push_str(&format!(
                    "----------------[{}]----------------[{},{},{}]\r\n",
                    marker_number,
                    marker.x,
                    marker.y,
                    marker.type_id
                ));
                
                // Write translation text
                let translation_lines: Vec<&str> = marker.translation.lines().collect();
                for line in translation_lines {
                    output.push_str(line);
                    output.push_str("\r\n");
                }
            }
        }
    }
    
    Ok(output)
}