// IO Service - 处理项目数据的导入导出业务逻辑
use std::sync::Arc;
use crate::common::{ProjectId, CoreResult};
use crate::service::events::EventBus;

pub struct IOService {
    #[allow(dead_code)]
    event_bus: Arc<EventBus>,
}

impl IOService {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }

    // BF格式导出
    pub fn export_bf(&self, project_id: ProjectId) -> CoreResult<Vec<u8>> {
        let result = super::bf::save_project(project_id)?;
        
        // 导出成功，不需要发布事件
        
        Ok(result)
    }

    // BF格式导入
    pub fn import_bf(&self, data: &[u8], _project_name: String) -> CoreResult<ProjectId> {
        let _bf_data = super::bf::parse_bf_file(data)?;
        
        // 创建新项目并导入数据
        // TODO: 实现完整的导入逻辑
        
        // 导入成功后会创建新项目，由项目服务发布事件
        
        todo!("Implement full BF import logic")
    }

    // LabelPlus格式导出
    pub fn export_labelplus(&self, project_id: ProjectId) -> CoreResult<String> {
        let result = super::labelplus::export_labelplus_data(project_id)?;
        
        // 导出成功，不需要发布事件
        
        Ok(result)
    }

    // LabelPlus格式导入
    pub fn import_labelplus(&self, project_id: ProjectId, content: &str) -> CoreResult<()> {
        let data = super::labelplus::validate_labelplus_file(content)?;
        super::labelplus::import_labelplus_data_direct(project_id, data)?;
        
        // 导入成功，标记已通过marker服务处理
        
        Ok(())
    }

    // 验证LabelPlus文件
    pub fn validate_labelplus(&self, content: &str) -> CoreResult<super::labelplus::LabelplusData> {
        super::labelplus::validate_labelplus_file(content)
    }
}