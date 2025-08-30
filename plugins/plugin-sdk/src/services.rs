use serde::{Serialize, Deserialize};
use serde_json::{json, Value};

/// Service代理基础trait
pub trait ServiceProxy {
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}

/// 插件上下文 - 增强版
#[derive(Clone)]
pub struct PluginContext {
    pub plugin_id: String,
}

impl PluginContext {
    pub fn new(plugin_id: String) -> Self {
        Self {
            plugin_id,
        }
    }

    /// 调用Core服务
    pub fn call_service(&self, service: &str, method: &str, params: Value) -> Result<Value, String> {
        #[cfg(feature = "wasm")]
        {
            crate::shared_buffer::call_service_sync(service, method, &params)
                .map_err(|e| format!("Service call failed: {}", e))
        }
        
        #[cfg(feature = "native")]
        {
            crate::native::call_service_native(&self.plugin_id, service, method, params)
        }
        
        #[cfg(not(any(feature = "wasm", feature = "native")))]
        {
            Err("No platform feature enabled".to_string())
        }
    }
}

/// 标记服务代理
pub struct MarkerServiceProxy {
    context: PluginContext,
}

impl MarkerServiceProxy {
    pub fn new(context: PluginContext) -> Self {
        Self { context }
    }

    pub fn get_all_markers(&self, project_id: &str) -> Result<Vec<Marker>, String> {
        let result = self.context.call_service(
            "markers",
            "get_all_markers",
            json!({ "project_id": project_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn get_marker(&self, marker_id: &str) -> Result<Marker, String> {
        let result = self.context.call_service(
            "markers",
            "get_marker",
            json!({ "marker_id": marker_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn create_marker(&self, data: CreateMarkerRequest) -> Result<Marker, String> {
        let result = self.context.call_service(
            "markers",
            "create_marker",
            json!({ "data": data })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn update_marker(&self, marker_id: &str, data: UpdateMarkerRequest) -> Result<(), String> {
        self.context.call_service(
            "markers",
            "update_marker",
            json!({ 
                "marker_id": marker_id,
                "data": data 
            })
        )?;
        
        Ok(())
    }

    pub fn delete_marker(&self, marker_id: &str) -> Result<(), String> {
        self.context.call_service(
            "markers",
            "delete_marker",
            json!({ "marker_id": marker_id })
        )?;
        
        Ok(())
    }
}

/// 项目服务代理
pub struct ProjectServiceProxy {
    context: PluginContext,
}

impl ProjectServiceProxy {
    pub fn new(context: PluginContext) -> Self {
        Self { context }
    }

    pub fn get_current(&self) -> Result<Option<Project>, String> {
        let result = self.context.call_service(
            "project",
            "get_current",
            json!({})
        )?;
        
        if result.is_null() {
            Ok(None)
        } else {
            Ok(Some(serde_json::from_value(result).map_err(|e| e.to_string())?))
        }
    }

    pub fn create_project(&self, data: CreateProjectRequest) -> Result<Project, String> {
        let result = self.context.call_service(
            "project",
            "create_project",
            json!({ "data": data })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn save_project(&self) -> Result<(), String> {
        self.context.call_service(
            "project",
            "save_project",
            json!({})
        )?;
        
        Ok(())
    }
}

/// 图片服务代理
pub struct ImageServiceProxy {
    context: PluginContext,
}

impl ImageServiceProxy {
    pub fn new(context: PluginContext) -> Self {
        Self { context }
    }

    pub fn get_all_images(&self, project_id: &str) -> Result<Vec<Image>, String> {
        let result = self.context.call_service(
            "images",
            "get_all_images",
            json!({ "project_id": project_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn get_image(&self, image_id: &str) -> Result<Image, String> {
        let result = self.context.call_service(
            "images",
            "get_image",
            json!({ "image_id": image_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }

    pub fn get_image_data(&self, image_id: &str) -> Result<ImageData, String> {
        let result = self.context.call_service(
            "images",
            "get_image_data",
            json!({ "image_id": image_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }
    
    /// 获取图像的二进制数据
    /// 对于FilePath类型，会通过Core API读取文件内容
    /// 对于Binary类型，直接返回数据
    pub fn get_image_binary(&self, image_id: &str) -> Result<Vec<u8>, String> {
        let image_data = self.get_image_data(image_id)?;
        
        match image_data {
            ImageData::FilePath { path: _ } => {
                // 在桌面端，通过文件服务读取文件内容
                // 传递image_id，让服务端通过Core API获取数据
                self.read_image_file(image_id)
            }
            ImageData::Binary { data, .. } => {
                // 在Web端，直接返回二进制数据
                Ok(data)
            }
        }
    }
    
    /// 通过文件服务读取图片文件内容
    fn read_image_file(&self, image_id: &str) -> Result<Vec<u8>, String> {
        // 先尝试获取文件路径，用于native平台
        #[cfg(feature = "native")]
        {
            // 在native平台，先获取图片数据以拿到文件路径
            let image_data = self.get_image_data(image_id)?;
            if let ImageData::FilePath { path } = image_data {
                // 直接使用native方法读取文件
                return crate::native::read_image_file_native(&path);
            }
        }
        
        // WASM平台或者fallback方案
        let params = json!({
            "image_id": image_id
        });
        
        // 调用文件服务读取文件，传递image_id
        let result = self.context.call_service("files", "read_binary", params)?;
        
        // 解析返回的二进制数据
        if let Some(data) = result.as_array() {
            let bytes: Vec<u8> = data.iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v as u8)
                .collect();
            Ok(bytes)
        } else {
            Err("Failed to parse file data".to_string())
        }
    }

    pub fn add_image(&self, data: AddImageRequest) -> Result<Image, String> {
        let result = self.context.call_service(
            "images",
            "add_image",
            json!({ "data": data })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }
}

/// 统计服务代理
pub struct StatsServiceProxy {
    context: PluginContext,
}

impl StatsServiceProxy {
    pub fn new(context: PluginContext) -> Self {
        Self { context }
    }

    pub fn get_stats(&self, project_id: &str) -> Result<ProjectStats, String> {
        let result = self.context.call_service(
            "stats",
            "get_stats",
            json!({ "project_id": project_id })
        )?;
        
        Ok(serde_json::from_value(result).map_err(|e| e.to_string())?)
    }
}

/// 服务代理管理器
#[derive(Clone)]
pub struct ServiceProxyManager {
    context: PluginContext,
}

impl ServiceProxyManager {
    pub fn new(context: PluginContext) -> Self {
        Self { context }
    }

    pub fn markers(&self) -> MarkerServiceProxy {
        MarkerServiceProxy::new(self.context.clone())
    }

    pub fn project(&self) -> ProjectServiceProxy {
        ProjectServiceProxy::new(self.context.clone())
    }

    pub fn images(&self) -> ImageServiceProxy {
        ImageServiceProxy::new(self.context.clone())
    }

    pub fn stats(&self) -> StatsServiceProxy {
        StatsServiceProxy::new(self.context.clone())
    }
}

// 数据类型定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub image_id: String,
    pub text: String,
    pub translation: String,
    pub marker_type: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Image {
    pub id: String,
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ImageData {
    FilePath { path: String },
    Binary { data: Vec<u8>, format: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMarkerRequest {
    pub image_id: String,
    pub text: String,
    pub translation: Option<String>,
    pub marker_type: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMarkerRequest {
    pub text: Option<String>,
    pub translation: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddImageRequest {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub total_images: usize,
    pub total_markers: usize,
    pub translated_markers: usize,
    pub untranslated_markers: usize,
}

