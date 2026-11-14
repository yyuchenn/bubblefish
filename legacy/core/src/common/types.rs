use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};

// Language enum for source and target languages
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    Japanese,
    English,
    SimplifiedChinese,
    TraditionalChinese,
}

impl Default for Language {
    fn default() -> Self {
        Language::Japanese
    }
}

impl Language {
    pub fn default_source() -> Self {
        Language::Japanese
    }
    
    pub fn default_target() -> Self {
        Language::SimplifiedChinese
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Language::Japanese => write!(f, "Japanese"),
            Language::English => write!(f, "English"),
            Language::SimplifiedChinese => write!(f, "SimplifiedChinese"),
            Language::TraditionalChinese => write!(f, "TraditionalChinese"),
        }
    }
}

// Type-safe ID wrappers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ImageId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MarkerId(pub u32);

// Display implementations
impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Project({})", self.0)
    }
}

impl fmt::Display for ImageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Image({})", self.0)
    }
}

impl fmt::Display for MarkerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Marker({})", self.0)
    }
}

// ID generators
pub struct IdGenerator<T> {
    counter: AtomicU32,
    _phantom: std::marker::PhantomData<T>,
}

impl<T> IdGenerator<T> {
    pub const fn new() -> Self {
        Self {
            counter: AtomicU32::new(1),
            _phantom: std::marker::PhantomData,
        }
    }
}

impl IdGenerator<ProjectId> {
    pub fn next(&self) -> ProjectId {
        ProjectId(self.counter.fetch_add(1, Ordering::SeqCst))
    }
}

impl IdGenerator<ImageId> {
    pub fn next(&self) -> ImageId {
        ImageId(self.counter.fetch_add(1, Ordering::SeqCst))
    }
}

impl IdGenerator<MarkerId> {
    pub fn next(&self) -> MarkerId {
        MarkerId(self.counter.fetch_add(1, Ordering::SeqCst))
    }
}

// Global ID generators
pub static PROJECT_ID_GENERATOR: IdGenerator<ProjectId> = IdGenerator::new();
pub static IMAGE_ID_GENERATOR: IdGenerator<ImageId> = IdGenerator::new();
pub static MARKER_ID_GENERATOR: IdGenerator<MarkerId> = IdGenerator::new();

// Conversion traits for backward compatibility during migration
impl From<u32> for ProjectId {
    fn from(id: u32) -> Self {
        ProjectId(id)
    }
}

impl From<u32> for ImageId {
    fn from(id: u32) -> Self {
        ImageId(id)
    }
}

impl From<u32> for MarkerId {
    fn from(id: u32) -> Self {
        MarkerId(id)
    }
}

impl From<ProjectId> for u32 {
    fn from(id: ProjectId) -> Self {
        id.0
    }
}

impl From<ImageId> for u32 {
    fn from(id: ImageId) -> Self {
        id.0
    }
}

impl From<MarkerId> for u32 {
    fn from(id: MarkerId) -> Self {
        id.0
    }
}