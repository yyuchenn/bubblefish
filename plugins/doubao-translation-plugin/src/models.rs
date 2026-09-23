use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "doubao-seed-2-1-pro-260915";

// https://docs.volcengine.com/docs/ark/model-list?lang=zh (2026-09-22)
pub const MODELS: &[(&str, &str)] = &[
    (DEFAULT_MODEL, "Seed 2.1 Pro（2026-09-15，默认）"),
    ("doubao-seed-2-1-lite-260915", "Seed 2.1 Lite（2026-09-15）"),
    (
        "doubao-seed-2-1-turbo-260628",
        "Seed 2.1 Turbo（2026-06-28）",
    ),
    ("doubao-seed-2-1-pro-260628", "Seed 2.1 Pro（2026-06-28）"),
];

const LEGACY_MODELS: &[&str] = &[
    "doubao-seed-1-6-250615",
    "doubao-seed-1-6-flash-250828",
    "doubao-1-5-pro-32k-250115",
];

pub fn resolve_model(model: Option<&str>) -> &str {
    match model.map(str::trim) {
        Some(model) if !model.is_empty() && !LEGACY_MODELS.contains(&model) => model,
        _ => DEFAULT_MODEL,
    }
}

/// Update only the model key in the host's own store. A failed read never writes.
pub fn migrate_legacy_model(
    plugin_id: &str,
    mut config_call: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<(), String> {
    let model = config_call("get", json!({ "plugin_id": plugin_id, "key": "model" }))?;
    if model
        .as_str()
        .is_some_and(|model| LEGACY_MODELS.contains(&model.trim()))
    {
        let result = config_call(
            "set",
            json!({ "plugin_id": plugin_id, "key": "model", "value": DEFAULT_MODEL }),
        )?;
        // Also handle hosts that report service failures in a JSON envelope.
        if let Some(error) = result.get("error") {
            return Err(format!("Failed to save model migration: {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_models_migrate_once_without_changing_other_settings() {
        for legacy in LEGACY_MODELS {
            let mut config = json!({
                "model": legacy, "api_key": "test-key", "system_prompt": "custom prompt",
                "extra": { "preserve": true }
            });
            let mut writes = 0;
            for _ in 0..2 {
                migrate_legacy_model("doubao-translation-plugin", |method, params| {
                    assert_eq!(params["plugin_id"], "doubao-translation-plugin");
                    assert_eq!(params["key"], "model");
                    match method {
                        "get" => Ok(config["model"].clone()),
                        "set" => {
                            assert!(params.get("config").is_none());
                            config["model"] = params["value"].clone();
                            writes += 1;
                            Ok(json!({ "success": true }))
                        }
                        _ => panic!("unexpected config call"),
                    }
                })
                .unwrap();
            }
            assert_eq!(writes, 1);
            assert_eq!(
                config,
                json!({
                    "model": DEFAULT_MODEL, "api_key": "test-key", "system_prompt": "custom prompt",
                    "extra": { "preserve": true }
                })
            );
        }
    }

    #[test]
    fn current_models_and_custom_endpoint_ids_are_preserved() {
        for model in MODELS.iter().map(|(id, _)| *id).chain(["ep-custom"]) {
            assert_eq!(resolve_model(Some(model)), model);
            migrate_legacy_model("test", |method, _| {
                assert_eq!(method, "get");
                Ok(json!(model))
            })
            .unwrap();
        }
    }

    #[test]
    fn missing_and_legacy_settings_resolve_to_default() {
        for model in LEGACY_MODELS.iter().copied().chain(["", "   "]) {
            assert_eq!(resolve_model(Some(model)), DEFAULT_MODEL);
        }
        assert_eq!(resolve_model(None), DEFAULT_MODEL);
    }

    #[test]
    fn migration_failures_preserve_request_fallback() {
        let legacy = LEGACY_MODELS[0];
        let result = migrate_legacy_model("test", |method, _| match method {
            "get" => Ok(json!(legacy)),
            _ => Err("disk full".into()),
        });
        assert_eq!(result.unwrap_err(), "disk full");
        assert_eq!(resolve_model(Some(legacy)), DEFAULT_MODEL);

        let result = migrate_legacy_model("test", |method, _| {
            assert_eq!(method, "get");
            Err("cannot read config".into())
        });
        assert!(result.is_err());

        assert!(migrate_legacy_model("test", |method, _| Ok(match method {
            "get" => json!(legacy),
            _ => json!({ "error": "disk full" }),
        }))
        .is_err());
    }
}
