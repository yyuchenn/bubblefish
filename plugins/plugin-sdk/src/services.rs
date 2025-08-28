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
    pub permissions: Vec<String>,
}

impl PluginContext {
    pub fn new(plugin_id: String) -> Self {
        Self {
            plugin_id,
            permissions: Vec::new(),
        }
    }

    pub fn with_permissions(plugin_id: String, permissions: Vec<String>) -> Self {
        Self {
            plugin_id,
            permissions,
        }
    }

    /// 调用Core服务
    pub fn call_service(&self, service: &str, method: &str, params: Value) -> Result<Value, String> {
        // 这里需要通过WASM边界调用Core服务
        // 实际实现会通过JS桥接到Core WASM
        web_sys::console::log_1(&format!(
            "[Plugin {}] Calling {}.{} with params: {:?}",
            self.plugin_id, service, method, params
        ).into());
        
        Ok(json!({"mock": "response"}))
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

