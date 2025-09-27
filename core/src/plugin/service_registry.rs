use std::collections::HashMap;
use std::sync::Arc;
use serde::{Serialize, Deserialize};
use serde_json::Value;

/// Service接口定义，所有Service都需要实现这个trait来暴露给插件
pub trait ServiceInterface: Send + Sync {
    /// 调用Service的方法
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
    
    /// 列出Service支持的所有方法
    fn list_methods(&self) -> Vec<MethodInfo>;
    
    /// 获取Service名称
    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MethodInfo {
    pub name: String,
    pub description: String,
    pub params: Vec<ParamInfo>,
    pub returns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    pub param_type: String,
    pub required: bool,
    pub description: String,
}

/// Service注册表，管理所有可供插件访问的Service
pub struct ServiceRegistry {
    services: HashMap<String, Arc<dyn ServiceInterface>>,
}

impl ServiceRegistry {
    pub fn new() -> Self {
        Self {
            services: HashMap::new(),
        }
    }

    /// 注册一个Service
    pub fn register<S: ServiceInterface + 'static>(&mut self, service: Arc<S>) {
        let name = service.name().to_string();
        self.services.insert(name, service as Arc<dyn ServiceInterface>);
    }

    /// 调用Service方法
    pub fn call_service(&self, service_name: &str, method: &str, params: Value) -> Result<Value, String> {
        let service = self.services
            .get(service_name)
            .ok_or_else(|| format!("Service '{}' not found", service_name))?;
        
        service.call(method, params)
    }

    /// 获取Service
    pub fn get_service(&self, name: &str) -> Option<Arc<dyn ServiceInterface>> {
        self.services.get(name).cloned()
    }

    /// 列出所有注册的Service
    pub fn list_services(&self) -> Vec<ServiceInfo> {
        self.services
            .iter()
            .map(|(name, service)| ServiceInfo {
                name: name.clone(),
                methods: service.list_methods(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub name: String,
    pub methods: Vec<MethodInfo>,
}

// 为各个Service实现ServiceInterface的适配器
pub mod adapters {
    use super::*;
    use crate::service::{marker, project, image};
    use crate::storage::traits::Storage;
    
    /// Marker Service适配器
    pub struct MarkerServiceAdapter {
        service: Arc<marker::MarkerService>,
    }

    impl MarkerServiceAdapter {
        pub fn new(service: Arc<marker::MarkerService>) -> Self {
            Self { service }
        }
    }

    impl ServiceInterface for MarkerServiceAdapter {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            match method {
                "get_all_markers" => {
                    let project_id = params["project_id"]
                        .as_u64()
                        .ok_or("project_id required")? as u32;
                    
                    // 获取项目的所有标记
                    let image_ids = crate::storage::project::get_project_image_ids_storage(
                        crate::common::ProjectId::from(project_id)
                    ).map_err(|e| format!("Failed to get project images: {}", e))?;
                    
                    let storage = crate::storage::state::APP_STATE.markers
                        .read()
                        .map_err(|e| format!("Failed to read markers: {}", e))?;
                    
                    let mut all_markers = Vec::new();
                    for image_id in image_ids {
                        let markers = storage.get_by_image(&image_id);
                        all_markers.extend(markers.iter().map(|m| m.to_dto()));
                    }
                    
                    Ok(serde_json::to_value(all_markers).unwrap_or(serde_json::json!([])))
                }
                "get_marker" => {
                    let marker_id = params["marker_id"]
                        .as_u64()
                        .ok_or("marker_id required")? as u32;
                    
                    let marker_dto = self.service.get_marker(marker_id);
                    Ok(serde_json::to_value(marker_dto).unwrap_or(serde_json::json!(null)))
                }
                "create_marker" => {
                    let image_id = params["image_id"]
                        .as_u64()
                        .ok_or("image_id required")? as u32;
                    let x = params["x"]
                        .as_f64()
                        .ok_or("x coordinate required")?;
                    let y = params["y"]
                        .as_f64()
                        .ok_or("y coordinate required")?;
                    let translation = params["translation"]
                        .as_str()
                        .map(String::from);
                    
                    let marker_id = self.service.add_point_marker(image_id, x, y, translation);
                    Ok(serde_json::json!({
                        "id": marker_id,
                        "success": marker_id.is_some()
                    }))
                }
                "update_marker" => {
                    let marker_id = params["marker_id"]
                        .as_u64()
                        .ok_or("marker_id required")? as u32;
                    let translation = params["translation"]
                        .as_str()
                        .ok_or("translation required")?;
                    
                    let success = self.service.update_marker_translation(marker_id, translation.to_string());
                    Ok(serde_json::json!({"success": success}))
                }
                "delete_marker" => {
                    let _marker_id = params["marker_id"]
                        .as_u64()
                        .ok_or("marker_id required")? as u32;
                    
                    // TODO: Add delete_marker method to MarkerService
                    // For now, return not implemented
                    Err("delete_marker not yet implemented".to_string())
                }
                _ => Err(format!("Unknown method: {}", method))
            }
        }

        fn list_methods(&self) -> Vec<MethodInfo> {
            vec![
                MethodInfo {
                    name: "get_all_markers".to_string(),
                    description: "Get all markers for a project".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "project_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Project ID".to_string(),
                        }
                    ],
                    returns: "Marker[]".to_string(),
                },
                MethodInfo {
                    name: "get_marker".to_string(),
                    description: "Get a specific marker by ID".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "marker_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Marker ID".to_string(),
                        }
                    ],
                    returns: "Marker".to_string(),
                },
                MethodInfo {
                    name: "create_marker".to_string(),
                    description: "Create a new marker".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "data".to_string(),
                            param_type: "object".to_string(),
                            required: true,
                            description: "Marker creation data".to_string(),
                        }
                    ],
                    returns: "Marker".to_string(),
                },
                MethodInfo {
                    name: "update_marker".to_string(),
                    description: "Update an existing marker".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "marker_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Marker ID".to_string(),
                        },
                        ParamInfo {
                            name: "data".to_string(),
                            param_type: "object".to_string(),
                            required: true,
                            description: "Update data".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
                MethodInfo {
                    name: "delete_marker".to_string(),
                    description: "Delete a marker".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "marker_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Marker ID".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
            ]
        }

        fn name(&self) -> &'static str {
            "markers"
        }
    }

    /// Project Service适配器
    pub struct ProjectServiceAdapter {
        service: Arc<project::ProjectService>,
    }

    impl ProjectServiceAdapter {
        pub fn new(service: Arc<project::ProjectService>) -> Self {
            Self { service }
        }
    }

    impl ServiceInterface for ProjectServiceAdapter {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            match method {
                "get_current" => {
                    // 获取第一个项目作为当前项目（临时实现）
                    // TODO: 实现真正的当前项目追踪
                    let projects = self.service.get_all_projects();
                    if let Some(project) = projects.first() {
                        Ok(serde_json::to_value(project).unwrap_or(serde_json::json!(null)))
                    } else {
                        Ok(serde_json::json!(null))
                    }
                }
                "get_project" => {
                    let project_id = params["project_id"]
                        .as_u64()
                        .ok_or("project_id required")? as u32;
                    
                    let project_dto = self.service.get_project(project_id);
                    Ok(serde_json::to_value(project_dto).unwrap_or(serde_json::json!(null)))
                }
                "create_project" => {
                    let name = params["name"]
                        .as_str()
                        .ok_or("project name required")?;
                    
                    match self.service.create_project(name.to_string()) {
                        Ok(project_id) => Ok(serde_json::json!({
                            "id": u32::from(project_id),
                            "success": true
                        })),
                        Err(e) => Err(format!("Failed to create project: {}", e))
                    }
                }
                "open_project" => {
                    let _project_path = params["path"]
                        .as_str()
                        .ok_or("project path required")?;
                    
                    // TODO: Implement project file loading
                    Err("open_project not yet implemented".to_string())
                }
                "save_project" => {
                    // TODO: Implement project saving
                    Err("save_project not yet implemented".to_string())
                }
                "close_project" => {
                    // TODO: Implement project closing
                    Err("close_project not yet implemented".to_string())
                }
                "get_all_projects" => {
                    let projects = self.service.get_all_projects();
                    Ok(serde_json::to_value(projects).unwrap_or(serde_json::json!([])))
                }
                _ => Err(format!("Unknown method: {}", method))
            }
        }

        fn list_methods(&self) -> Vec<MethodInfo> {
            vec![
                MethodInfo {
                    name: "get_current".to_string(),
                    description: "Get the current open project".to_string(),
                    params: vec![],
                    returns: "Project".to_string(),
                },
                MethodInfo {
                    name: "create_project".to_string(),
                    description: "Create a new project".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "data".to_string(),
                            param_type: "object".to_string(),
                            required: true,
                            description: "Project creation data".to_string(),
                        }
                    ],
                    returns: "Project".to_string(),
                },
                MethodInfo {
                    name: "open_project".to_string(),
                    description: "Open an existing project".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "path".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Project file path".to_string(),
                        }
                    ],
                    returns: "Project".to_string(),
                },
            ]
        }

        fn name(&self) -> &'static str {
            "project"
        }
    }

    /// Image Service适配器
    pub struct ImageServiceAdapter {
        service: Arc<image::ImageService>,
    }

    impl ImageServiceAdapter {
        pub fn new(service: Arc<image::ImageService>) -> Self {
            Self { service }
        }
    }

    /// Bunny Service适配器 - 用于插件注册OCR/翻译服务
    pub struct BunnyServiceAdapter;

    impl BunnyServiceAdapter {
        pub fn new(_service: Arc<crate::service::bunny::BunnyService>) -> Self {
            Self
        }
    }

    impl ServiceInterface for ImageServiceAdapter {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            match method {
                "get_all_images" => {
                    let project_id = params["project_id"]
                        .as_u64()
                        .ok_or("project_id required")? as u32;
                    
                    // Get all images for the project
                    let image_ids = crate::storage::project::get_project_image_ids_storage(
                        crate::common::ProjectId::from(project_id)
                    ).map_err(|e| format!("Failed to get project images: {}", e))?;
                    
                    let mut images = Vec::new();
                    for image_id in image_ids {
                        if let Some(image) = self.service.get_image(u32::from(image_id)) {
                            images.push(image);
                        }
                    }
                    
                    Ok(serde_json::to_value(images).unwrap_or(serde_json::json!([])))
                }
                "get_image" => {
                    let image_id = params["image_id"]
                        .as_u64()
                        .ok_or("image_id required")? as u32;
                    
                    let image_dto = self.service.get_image(image_id);
                    Ok(serde_json::to_value(image_dto).unwrap_or(serde_json::json!(null)))
                }
                "get_image_data" => {
                    let image_id = params["image_id"]
                        .as_u64()
                        .ok_or("image_id required")? as u32;
                    
                    // Get image from storage
                    let storage = crate::storage::state::APP_STATE.images
                        .read()
                        .map_err(|e| format!("Failed to read images: {}", e))?;
                    
                    if let Some(image) = storage.get(&crate::common::ImageId::from(image_id)) {
                        // Return based on the image data type
                        match &image.data {
                            crate::storage::image_data::ImageData::FilePath(path) => {
                                Ok(serde_json::json!({
                                    "type": "FilePath",
                                    "path": path.to_string_lossy()
                                }))
                            }
                            crate::storage::image_data::ImageData::Binary { data, format } => {
                                Ok(serde_json::json!({
                                    "type": "Binary",
                                    "data": data.as_ref(),
                                    "format": format.extension()
                                }))
                            }
                            crate::storage::image_data::ImageData::SharedBuffer { .. } => {
                                // For shared buffer, we need to read the actual data
                                match image.data.read_data() {
                                    Ok(data) => Ok(serde_json::json!({
                                        "type": "Binary",
                                        "data": data,
                                        "format": image.data.get_format().map(|f| f.extension()).unwrap_or("png")
                                    })),
                                    Err(e) => Err(format!("Failed to read shared buffer: {}", e))
                                }
                            }
                        }
                    } else {
                        Err(format!("Image {} not found", image_id))
                    }
                }
                _ => Err(format!("Unknown method: {}", method))
            }
        }

        fn list_methods(&self) -> Vec<MethodInfo> {
            vec![
                MethodInfo {
                    name: "get_all_images".to_string(),
                    description: "Get all images for a project".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "project_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Project ID".to_string(),
                        }
                    ],
                    returns: "Image[]".to_string(),
                },
                MethodInfo {
                    name: "get_image".to_string(),
                    description: "Get a specific image by ID".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "image_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Image ID".to_string(),
                        }
                    ],
                    returns: "Image".to_string(),
                },
                MethodInfo {
                    name: "get_image_data".to_string(),
                    description: "Get image data (file path or binary)".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "image_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Image ID".to_string(),
                        }
                    ],
                    returns: "ImageData".to_string(),
                },
            ]
        }

        fn name(&self) -> &'static str {
            "images"
        }
    }

    impl ServiceInterface for BunnyServiceAdapter {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            match method {
                "register_ocr_service" => {
                    let plugin_id = params["plugin_id"]
                        .as_str()
                        .ok_or("plugin_id required")?;
                    let service_info = serde_json::from_value::<crate::service::bunny::OCRServiceInfo>(
                        params["service_info"].clone()
                    ).map_err(|e| format!("Invalid service info: {}", e))?;

                    crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .write()
                        .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                        .register_ocr_service(plugin_id.to_string(), service_info)?;

                    Ok(serde_json::json!({"success": true}))
                }
                "register_translation_service" => {
                    let plugin_id = params["plugin_id"]
                        .as_str()
                        .ok_or("plugin_id required")?;
                    let service_info = serde_json::from_value::<crate::service::bunny::TranslationServiceInfo>(
                        params["service_info"].clone()
                    ).map_err(|e| format!("Invalid service info: {}", e))?;

                    crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .write()
                        .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                        .register_translation_service(plugin_id.to_string(), service_info)?;

                    Ok(serde_json::json!({"success": true}))
                }
                "unregister_service" => {
                    let service_id = params["service_id"]
                        .as_str()
                        .ok_or("service_id required")?;

                    crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .write()
                        .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                        .unregister_service(service_id)?;

                    Ok(serde_json::json!({"success": true}))
                }
                "unregister_plugin_services" => {
                    let plugin_id = params["plugin_id"]
                        .as_str()
                        .ok_or("plugin_id required")?;

                    crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .write()
                        .map_err(|e| format!("Failed to acquire write lock: {}", e))?
                        .unregister_plugin_services(plugin_id);

                    Ok(serde_json::json!({"success": true}))
                }
                "get_ocr_services" => {
                    let services = crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .read()
                        .map_err(|e| format!("Failed to acquire read lock: {}", e))?
                        .get_ocr_services();
                    Ok(serde_json::to_value(services).unwrap_or(serde_json::json!([])))
                }
                "get_translation_services" => {
                    let services = crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .read()
                        .map_err(|e| format!("Failed to acquire read lock: {}", e))?
                        .get_translation_services();
                    Ok(serde_json::to_value(services).unwrap_or(serde_json::json!([])))
                }
                "get_plugin_for_service" => {
                    let service_id = params["service_id"]
                        .as_str()
                        .ok_or("service_id required")?;

                    let plugin_id = crate::service::bunny::BUNNY_SERVICE_REGISTRY
                        .read()
                        .map_err(|e| format!("Failed to acquire read lock: {}", e))?
                        .get_plugin_for_service(service_id);

                    Ok(serde_json::json!({"plugin_id": plugin_id}))
                }
                _ => Err(format!("Unknown method: {}", method))
            }
        }

        fn list_methods(&self) -> Vec<MethodInfo> {
            vec![
                MethodInfo {
                    name: "register_ocr_service".to_string(),
                    description: "Register an OCR service from a plugin".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "plugin_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Plugin ID".to_string(),
                        },
                        ParamInfo {
                            name: "service_info".to_string(),
                            param_type: "object".to_string(),
                            required: true,
                            description: "OCR service information".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
                MethodInfo {
                    name: "register_translation_service".to_string(),
                    description: "Register a translation service from a plugin".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "plugin_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Plugin ID".to_string(),
                        },
                        ParamInfo {
                            name: "service_info".to_string(),
                            param_type: "object".to_string(),
                            required: true,
                            description: "Translation service information".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
                MethodInfo {
                    name: "unregister_service".to_string(),
                    description: "Unregister a bunny service".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "service_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Service ID".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
                MethodInfo {
                    name: "unregister_plugin_services".to_string(),
                    description: "Unregister all services from a plugin".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "plugin_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Plugin ID".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
                MethodInfo {
                    name: "get_ocr_services".to_string(),
                    description: "Get all registered OCR services".to_string(),
                    params: vec![],
                    returns: "OCRServiceInfo[]".to_string(),
                },
                MethodInfo {
                    name: "get_translation_services".to_string(),
                    description: "Get all registered translation services".to_string(),
                    params: vec![],
                    returns: "TranslationServiceInfo[]".to_string(),
                },
                MethodInfo {
                    name: "get_plugin_for_service".to_string(),
                    description: "Get the plugin ID that provides a service".to_string(),
                    params: vec![
                        ParamInfo {
                            name: "service_id".to_string(),
                            param_type: "string".to_string(),
                            required: true,
                            description: "Service ID".to_string(),
                        }
                    ],
                    returns: "object".to_string(),
                },
            ]
        }

        fn name(&self) -> &'static str {
            "bunny"
        }
    }
}