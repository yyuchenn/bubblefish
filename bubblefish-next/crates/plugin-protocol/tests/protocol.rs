use bubblefish_plugin_protocol::*;
use serde_json::json;

#[test]
fn command_tasks_are_additive_to_version_one() {
    let legacy: PluginCommandInvocation =
        serde_json::from_value(json!({"commandId":"inspect"})).unwrap();
    assert!(legacy.task_id.is_none());
    assert_eq!(legacy.params, serde_json::Value::Null);
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        json!({"commandId":"inspect","params":null})
    );
    let current: PluginCommandInvocation = serde_json::from_value(json!({
        "commandId":"inspect", "params":{"verbose":true}, "taskId":"run-1"
    }))
    .unwrap();
    assert_eq!(current.task_id.as_deref(), Some("run-1"));
    let progress = PluginTaskProgress {
        task_id: "run-1".into(),
        progress: json!({"completed":1,"total":2}),
    };
    assert_eq!(
        serde_json::to_value(progress).unwrap(),
        json!({"taskId":"run-1","progress":{"completed":1,"total":2}})
    );
    let summary = PluginTaskSummary {
        task_id: "run-1".into(),
        message: "Ready".into(),
    };
    assert_eq!(
        serde_json::to_value(summary).unwrap(),
        json!({"taskId":"run-1","message":"Ready"})
    );
}
use std::io::{self, Read};

fn frame() -> Frame {
    Frame {
        message: PluginMessage::Request(PluginRequest {
            api_version: 1,
            id: "image-1".into(),
            method: "ocr.recognize".into(),
            params: json!({"providerId":"ocr","input":{"language":"ja"}}),
            binary: Some(BinaryAttachment {
                byte_length: 4,
                mime_type: Some("image/png".into()),
            }),
        }),
        binary: vec![0, 127, 128, 255],
    }
}

#[test]
fn binary_roundtrip_accepts_fragmented_and_consecutive_frames() {
    struct Fragmented<'a>(&'a [u8]);
    impl Read for Fragmented<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = buffer.len().min(self.0.len()).min(3);
            buffer[..count].copy_from_slice(&self.0[..count]);
            self.0 = &self.0[count..];
            Ok(count)
        }
    }
    let original = frame();
    let encoded = encode_frame(&original).unwrap();
    assert_eq!(decode_frame(&encoded).unwrap(), original);
    let bytes = [encoded.clone(), encoded].concat();
    let mut reader = Fragmented(&bytes);
    assert_eq!(read_frame(&mut reader).unwrap(), Some(original.clone()));
    assert_eq!(read_frame(&mut reader).unwrap(), Some(original));
    assert_eq!(read_frame(&mut reader).unwrap(), None);
    assert!(decode_frame(&bytes).is_err());
}

#[test]
fn local_resource_metadata_uses_numeric_lengths_and_binary_chunks() {
    let value = json!({"id":"kha-model","files":[{"path":"encoder.onnx","byteLength":343483354,"sha256":"a".repeat(64)}]});
    let metadata: PluginLocalResourceImport = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(metadata.files[0].byte_length, 343_483_354);
    assert_eq!(serde_json::to_value(metadata).unwrap(), value);
    let mut packet = frame();
    if let PluginMessage::Request(request) = &mut packet.message {
        request.method = "resources.local.writeChunk".into();
        request.params = json!({"token":"instance-token","path":"encoder.onnx","offset":0});
    }
    assert_eq!(
        decode_frame(&encode_frame(&packet).unwrap()).unwrap(),
        packet
    );
    let invalid = json!({"id":"model","files":[{"path":"encoder.onnx","byteLength":-1,"sha256":"a".repeat(64)}]});
    assert!(serde_json::from_value::<PluginLocalResourceImport>(invalid).is_err());
    assert_eq!(MAX_LOCAL_RESOURCE_CHUNK_BYTES, 4 * 1024 * 1024);
}

#[test]
fn malformed_lengths_versions_and_truncated_frames_fail() {
    let encoded = encode_frame(&frame()).unwrap();
    for length in [1, 7, encoded.len() - 1] {
        assert!(decode_frame(&encoded[..length]).is_err());
    }
    let mut invalid = frame();
    invalid.binary.pop();
    assert!(encode_frame(&invalid).is_err());
    let mut invalid = frame();
    if let PluginMessage::Request(request) = &mut invalid.message {
        request.api_version = 2;
    }
    assert!(encode_frame(&invalid).is_err());
    let header = [
        (MAX_JSON_BYTES as u32 + 1).to_le_bytes(),
        0u32.to_le_bytes(),
    ]
    .concat();
    assert!(decode_frame(&header).is_err());
}

#[test]
fn successful_null_response_remains_distinct_from_missing_result() {
    let message: PluginMessage =
        serde_json::from_value(json!({"kind":"response","apiVersion":1,"id":"1","result":null}))
            .unwrap();
    let frame = Frame {
        message,
        binary: vec![],
    };
    frame.validate().unwrap();
    assert_eq!(decode_frame(&encode_frame(&frame).unwrap()).unwrap(), frame);
    let missing: PluginMessage =
        serde_json::from_value(json!({"kind":"response","apiVersion":1,"id":"1"})).unwrap();
    assert!(Frame {
        message: missing,
        binary: vec![]
    }
    .validate()
    .is_err());
}

#[test]
fn manifest_paths_and_configuration_defaults_are_validated() {
    let mut manifest: PluginManifest = serde_json::from_value(json!({
        "id":"example.ocr","name":"OCR","version":"1.0.0","apiVersion":1,
        "entrypoints":{"web":"web/index.js","native":{"aarch64-apple-darwin":"bin/ocr"}},
        "contributes":{"configuration":[{"key":"enabled","label":"Enabled","type":"boolean","default":true}]}
    })).unwrap();
    validate_manifest(&manifest).unwrap();
    for path in [
        "../outside",
        "/outside",
        "a//b",
        "a/./b",
        "C:/outside",
        "a\\b",
        "%2e%2e/path",
    ] {
        assert!(validate_package_path(path).is_err(), "{path}");
    }
    manifest.contributes.configuration.as_mut().unwrap()[0].default = Some(json!("true"));
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn activation_events_are_opt_in_and_use_public_event_names() {
    let mut manifest: PluginManifest = serde_json::from_value(json!({
        "id":"example.observer","name":"Observer","version":"1.0.0","apiVersion":1,
        "entrypoints":{"web":"observer.js"},"contributes":{},
        "activationEvents":["startup","event:context.changed","event:document.changed","event:project.closed"]
    })).unwrap();
    validate_manifest(&manifest).unwrap();
    manifest.activation_events = Some(vec!["event:internal.store.changed".into()]);
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn version_one_roles_and_hook_manifests_remain_additive() {
    let old: PluginHandshakeRequest = serde_json::from_value(json!({
        "apiVersion":1,"pluginId":"example.guard","hostVersion":"test","platform":"web","permissions":[]
    })).unwrap();
    assert_eq!(
        old.runtime_role.unwrap_or_default(),
        PluginRuntimeRole::Main
    );
    let mut manifest: PluginManifest = serde_json::from_value(json!({
        "id":"example.guard","name":"Guard","version":"1.0.0","apiVersion":1,
        "entrypoints":{"web":"guard.js"},"permissions":["document.intercept"],
        "contributes":{"beforeCommitHooks":[{"id":"normalize","priority":-10,"operations":["translation.set"]}]},
        "activationEvents":["event:transaction.committed","event:image.updated","event:history.changed"]
    })).unwrap();
    validate_manifest(&manifest).unwrap();
    assert_eq!(
        manifest.contributes.before_commit_hooks.as_ref().unwrap()[0].priority,
        Some(-10)
    );
    manifest.permissions = None;
    assert_eq!(
        validate_manifest(&manifest).unwrap_err().code,
        "invalidManifest"
    );
    manifest.permissions = Some(vec!["document.intercept".into()]);
    let duplicate = manifest.contributes.before_commit_hooks.as_ref().unwrap()[0].clone();
    manifest
        .contributes
        .before_commit_hooks
        .as_mut()
        .unwrap()
        .push(duplicate);
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn typed_transactions_preserve_rich_text_unknown_cache_and_null_patches() {
    let wire = json!({
        "projectId":"project","label":"batch","expectedStateId":"project:3",
        "operations":[
            {"type":"image.create","id":"new-image","stagedResource":"lease"},
            {"type":"marker.create","imageId":"new-image","marker":{
                "id":"new-marker","geometry":{"type":"point","x":0.2,"y":0.3},
                "translation":{"runs":[{"text":"styled","marks":["bold","emphasis"]}],"raw":"preserved"},
                "style":{"overlayText":true,"horizontal":false},"bunnyCache":{"future":{"value":7}}
            }},
            {"type":"translation.set","imageId":"new-image","markerId":"new-marker","value":"plain"},
            {"type":"assistance.update","imageId":"new-image","markerId":"new-marker","patch":{"originalText":null},"expected":{"machineTranslation":null}}
        ]
    });
    let transaction: PluginTransaction = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&transaction).unwrap(), wire);
    if let PluginOperation::AssistanceUpdate {
        patch, expected, ..
    } = &transaction.operations[3]
    {
        assert_eq!(patch.original_text, Some(None));
        assert_eq!(patch.machine_translation, None);
        assert_eq!(expected.as_ref().unwrap().machine_translation, Some(None));
    } else {
        panic!("wrong operation")
    }
    let decision: BeforeCommitHookResult =
        serde_json::from_value(json!({"action":"replace","operations":transaction.operations}))
            .unwrap();
    assert!(matches!(decision, BeforeCommitHookResult::Replace { .. }));
    assert_eq!(
        serde_json::to_value(PluginRuntimeRole::Hooks).unwrap(),
        "hooks"
    );
}
