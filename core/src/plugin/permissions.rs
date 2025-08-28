use serde::{Serialize, Deserialize};
use std::collections::HashSet;

/// 数据访问范围
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum DataScope {
    Project,
    Markers,
    Images,
    Translations,
    Stats,
    All,
}

/// 权限定义
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Permission {
    // Service权限
    ServiceAccess { 
        service: String, 
        methods: Vec<String> 
    },
    ServiceFullAccess { 
        service: String 
    },
    AllServicesAccess,
    
    // 事件权限
    EventSubscribe { 
        event_types: Vec<String> 
    },
    EventSubscribeAll,
    
    // 数据权限
    DataRead { 
        scope: DataScope 
    },
    DataWrite { 
        scope: DataScope 
    },
    DataFullAccess,
    
    // 系统权限
    SystemConfig,
    FileAccess { 
        paths: Vec<String> 
    },
    NetworkAccess { 
        urls: Vec<String> 
    },
    
    // 插件间通信权限
    PluginCommunication,
    PluginCommunicationWith { 
        plugin_ids: Vec<String> 
    },
}

/// 权限检查器
pub struct PermissionChecker {
    granted_permissions: HashSet<Permission>,
}

impl PermissionChecker {
    pub fn new(permissions: Vec<Permission>) -> Self {
        Self {
            granted_permissions: permissions.into_iter().collect(),
        }
    }

    /// 检查是否有Service访问权限
    pub fn can_access_service(&self, service: &str, method: &str) -> bool {
        // 检查是否有所有服务访问权限
        if self.granted_permissions.contains(&Permission::AllServicesAccess) {
            return true;
        }

        // 检查是否有该服务的完全访问权限
        if self.granted_permissions.contains(&Permission::ServiceFullAccess {
            service: service.to_string(),
        }) {
            return true;
        }

        // 检查是否有该服务特定方法的访问权限
        for perm in &self.granted_permissions {
            if let Permission::ServiceAccess { service: s, methods } = perm {
                if s == service && methods.contains(&method.to_string()) {
                    return true;
                }
            }
        }

        false
    }

    /// 检查是否可以订阅事件
    pub fn can_subscribe_event(&self, event_type: &str) -> bool {
        // 检查是否有订阅所有事件的权限
        if self.granted_permissions.contains(&Permission::EventSubscribeAll) {
            return true;
        }

        // 检查是否有订阅特定事件的权限
        for perm in &self.granted_permissions {
            if let Permission::EventSubscribe { event_types } = perm {
                if event_types.contains(&event_type.to_string()) || event_types.contains(&"*".to_string()) {
                    return true;
                }
            }
        }

        false
    }

    /// 检查是否有数据读取权限
    pub fn can_read_data(&self, scope: &DataScope) -> bool {
        // 检查完全数据访问权限
        if self.granted_permissions.contains(&Permission::DataFullAccess) {
            return true;
        }

        // 检查所有数据读取权限
        if self.granted_permissions.contains(&Permission::DataRead {
            scope: DataScope::All,
        }) {
            return true;
        }

        // 检查特定范围的读取权限
        self.granted_permissions.contains(&Permission::DataRead {
            scope: scope.clone(),
        })
    }

    /// 检查是否有数据写入权限
    pub fn can_write_data(&self, scope: &DataScope) -> bool {
        // 检查完全数据访问权限
        if self.granted_permissions.contains(&Permission::DataFullAccess) {
            return true;
        }

        // 检查所有数据写入权限
        if self.granted_permissions.contains(&Permission::DataWrite {
            scope: DataScope::All,
        }) {
            return true;
        }

        // 检查特定范围的写入权限
        self.granted_permissions.contains(&Permission::DataWrite {
            scope: scope.clone(),
        })
    }

    /// 检查是否可以与其他插件通信
    pub fn can_communicate_with_plugin(&self, plugin_id: &str) -> bool {
        // 检查是否有所有插件通信权限
        if self.granted_permissions.contains(&Permission::PluginCommunication) {
            return true;
        }

        // 检查是否有与特定插件通信的权限
        for perm in &self.granted_permissions {
            if let Permission::PluginCommunicationWith { plugin_ids } = perm {
                if plugin_ids.contains(&plugin_id.to_string()) {
                    return true;
                }
            }
        }

        false
    }

    /// 检查是否有文件访问权限
    pub fn can_access_file(&self, path: &str) -> bool {
        for perm in &self.granted_permissions {
            if let Permission::FileAccess { paths } = perm {
                for allowed_path in paths {
                    if path.starts_with(allowed_path) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// 检查是否有网络访问权限
    pub fn can_access_url(&self, url: &str) -> bool {
        for perm in &self.granted_permissions {
            if let Permission::NetworkAccess { urls } = perm {
                for allowed_url in urls {
                    if url.starts_with(allowed_url) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// 添加权限
    pub fn grant(&mut self, permission: Permission) {
        self.granted_permissions.insert(permission);
    }

    /// 移除权限
    pub fn revoke(&mut self, permission: &Permission) {
        self.granted_permissions.remove(permission);
    }

    /// 获取所有权限
    pub fn list_permissions(&self) -> Vec<Permission> {
        self.granted_permissions.iter().cloned().collect()
    }
}

/// 默认权限集合
pub struct DefaultPermissions;

impl DefaultPermissions {
    /// 最小权限集 - 只读基本数据
    pub fn minimal() -> Vec<Permission> {
        vec![
            Permission::DataRead { scope: DataScope::Project },
            Permission::EventSubscribe { 
                event_types: vec!["SystemReady".to_string()] 
            },
        ]
    }

    /// 标准权限集 - 读写标记和图片
    pub fn standard() -> Vec<Permission> {
        vec![
            Permission::DataRead { scope: DataScope::All },
            Permission::DataWrite { scope: DataScope::Markers },
            Permission::DataWrite { scope: DataScope::Translations },
            Permission::ServiceAccess {
                service: "markers".to_string(),
                methods: vec![
                    "get_all_markers".to_string(),
                    "get_marker".to_string(),
                    "update_marker".to_string(),
                ],
            },
            Permission::ServiceAccess {
                service: "project".to_string(),
                methods: vec!["get_current".to_string()],
            },
            Permission::EventSubscribe {
                event_types: vec![
                    "MarkerCreated".to_string(),
                    "MarkerUpdated".to_string(),
                    "MarkerDeleted".to_string(),
                    "MarkerSelected".to_string(),
                ],
            },
        ]
    }

    /// 完全权限集 - 所有权限
    pub fn full() -> Vec<Permission> {
        vec![
            Permission::AllServicesAccess,
            Permission::EventSubscribeAll,
            Permission::DataFullAccess,
            Permission::PluginCommunication,
            Permission::SystemConfig,
        ]
    }
}