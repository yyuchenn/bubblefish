// Opening Project service模块
mod core;
mod service;
mod handlers;

pub use service::OpeningProjectService;
pub use core::{OpeningProject, OPENING_PROJECTS};
pub use crate::common::dto::opening_project::OpeningProjectDTO;