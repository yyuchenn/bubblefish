// Stats Service - 处理统计相关的业务逻辑
use crate::common::ProjectId;
use crate::api::image;
use crate::api::stats::{ProjectStats, SingleProjectStats};

pub struct StatsService;

impl StatsService {
    pub fn new() -> Self {
        Self
    }
    
    pub fn get_overall_stats(&self) -> ProjectStats {
        let services = crate::service::get_service();
        ProjectStats {
            project_count: services.project_service.project_count().unwrap_or(0),
            image_count: image::image_count().unwrap_or(0),
            marker_count: services.marker_service.marker_count().unwrap_or(0),
        }
    }
    
    pub fn get_project_stats(&self, project_id: u32) -> Option<SingleProjectStats> {
        let services = crate::service::get_service();
        if match services.project_service.project_exists_core(ProjectId::from(project_id)) {
            Ok(exists) => exists,
            Err(_) => false,
        } {
            let image_ids = match services.project_service.get_project_image_ids(ProjectId::from(project_id)) {
                Ok(ids) => ids,
                Err(_) => Vec::new()
            };
            let image_count = image_ids.len();
            
            let mut marker_count = 0;
            for image_id in image_ids {
                marker_count += match image::get_image_marker_ids(image_id.into()) {
                    Ok(ids) => ids.len(),
                    Err(_) => 0
                };
            }
            
            Some(SingleProjectStats {
                image_count,
                marker_count,
            })
        } else {
            None
        }
    }
}