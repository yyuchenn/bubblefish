use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ProjectFormat {
    Labelplus,
    Bubblefish,
}

impl ProjectFormat {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "txt" | "lp" => Some(Self::Labelplus),
            "bf" => Some(Self::Bubblefish),
            _ => None,
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self {
            Self::Labelplus => "text/plain",
            Self::Bubblefish => "application/gzip",
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Labelplus => "txt",
            Self::Bubblefish => "bf",
        }
    }
}