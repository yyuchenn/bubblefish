use serde::{Deserialize, Serialize};

/// Type of configuration field
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigFieldType {
    Text,
    Password,
    Number,
    Select,
    Switch,
    Textarea,
}

/// Option for select field
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

/// Validation rules for configuration fields
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigValidation {
    MinLength(usize),
    MaxLength(usize),
    Pattern(String),
    Min(f64),
    Max(f64),
}

/// Configuration field definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    /// Unique key for this field
    pub key: String,

    /// Display label
    pub label: String,

    /// Field type
    pub field_type: ConfigFieldType,

    /// Whether this field is required
    #[serde(default)]
    pub required: bool,

    /// Placeholder text for input fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,

    /// Help text displayed below the field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_text: Option<String>,

    /// Default value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,

    /// Options for select field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SelectOption>>,

    /// Validation rules
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<Vec<ConfigValidation>>,

    /// Whether this field should be disabled
    #[serde(default)]
    pub disabled: bool,
}

/// Configuration section for grouping fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSection {
    /// Section title
    pub title: String,

    /// Section description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Fields in this section
    pub fields: Vec<ConfigField>,
}

/// Complete configuration schema for a plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSchema {
    /// Configuration sections
    pub sections: Vec<ConfigSection>,
}

impl ConfigSchema {
    /// Create a simple schema with a single section
    pub fn simple(fields: Vec<ConfigField>) -> Self {
        Self {
            sections: vec![ConfigSection {
                title: "配置".to_string(),
                description: None,
                fields,
            }],
        }
    }
}

/// Helper builders for common field types
impl ConfigField {
    /// Create a text input field
    pub fn text(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Text,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: None,
            options: None,
            validation: None,
            disabled: false,
        }
    }

    /// Create a password input field
    pub fn password(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Password,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: None,
            options: None,
            validation: None,
            disabled: false,
        }
    }

    /// Create a select dropdown field
    pub fn select(key: impl Into<String>, label: impl Into<String>, options: Vec<SelectOption>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Select,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: None,
            options: Some(options),
            validation: None,
            disabled: false,
        }
    }

    /// Create a switch/toggle field
    pub fn switch(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Switch,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: Some("false".to_string()),
            options: None,
            validation: None,
            disabled: false,
        }
    }

    /// Create a textarea field for multi-line text input
    pub fn textarea(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Textarea,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: None,
            options: None,
            validation: None,
            disabled: false,
        }
    }

    /// Create a number input field
    pub fn number(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            field_type: ConfigFieldType::Number,
            required: false,
            placeholder: None,
            help_text: None,
            default_value: None,
            options: None,
            validation: None,
            disabled: false,
        }
    }

    /// Set this field as required
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    /// Set placeholder text
    pub fn with_placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    /// Set help text
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help_text = Some(help.into());
        self
    }

    /// Set default value
    pub fn with_default(mut self, default: impl Into<String>) -> Self {
        self.default_value = Some(default.into());
        self
    }

    /// Add validation rules
    pub fn with_validation(mut self, validation: Vec<ConfigValidation>) -> Self {
        self.validation = Some(validation);
        self
    }
}