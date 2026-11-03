//! Build with `cargo build -p bubblefish-plugin-sdk-next --example echo`.
//! Run the resulting executable as a native plugin; stdout contains only frames.
use bubblefish_plugin_sdk_next::*;
use serde_json::json;

#[derive(Default)]
pub struct Echo;
impl Plugin for Echo {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "example.echo".into(),
            name: "Echo example".into(),
            version: "0.1.0".into(),
            api_version: PLUGIN_API_VERSION,
            description: None,
            entrypoints: PluginEntrypoints {
                web: Some("entry.js".into()),
                native: None,
            },
            contributes: PluginContributions {
                before_commit_hooks: Some(vec![BeforeCommitHookInfo {
                    id: "normalize-text".into(),
                    priority: Some(20),
                    operations: Some(vec!["translation.set".into()]),
                }]),
                commands: Some(vec![
                    CommandInfo {
                        id: "inspect-document".into(),
                        title: "Rust: inspect document and history".into(),
                    },
                    CommandInfo {
                        id: "duplicate-image".into(),
                        title: "Rust: duplicate first image".into(),
                    },
                    CommandInfo {
                        id: "task-demo".into(),
                        title: "Rust: task progress and cancellation".into(),
                    },
                ]),
                ocr: Some(vec![ProviderInfo {
                    id: "echo-ocr".into(),
                    name: "Echo OCR".into(),
                    languages: None,
                }]),
                translation: Some(vec![ProviderInfo {
                    id: "prefix-translation".into(),
                    name: "Prefix translation example".into(),
                    languages: None,
                }]),
                ..Default::default()
            },
            permissions: Some(
                [
                    "document.read",
                    "document.write",
                    "images.read",
                    "images.write",
                    "history.read",
                    "history.control",
                    "document.intercept",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            activation_events: None,
        }
    }
    fn handle<'a>(
        &'a mut self,
        request: PluginRequest,
        binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginFuture<'a> {
        Box::pin(async move {
            match request.method.as_str() {
                "activate" => {
                    if context.runtime_role == PluginRuntimeRole::Hooks {
                        context
                            .register_before_commit(BeforeCommitHookInfo {
                                id: "normalize-text".into(),
                                priority: Some(20),
                                operations: Some(vec!["translation.set".into()]),
                            })
                            .await?;
                        return Ok(PluginOutput::json(serde_json::Value::Null));
                    }
                    context
                        .register_ocr(ProviderInfo {
                            id: "echo-ocr".into(),
                            name: "Echo OCR".into(),
                            languages: None,
                        })
                        .await?;
                    context
                        .register_translation(ProviderInfo {
                            id: "prefix-translation".into(),
                            name: "Prefix translation example".into(),
                            languages: None,
                        })
                        .await?;
                    for command in self.manifest().contributes.commands.into_iter().flatten() {
                        context.register_command(command).await?;
                    }
                    context
                        .events_subscribe("document.changed", PluginEventOptions::default())
                        .await?;
                    Ok(PluginOutput::json(serde_json::Value::Null))
                }
                "deactivate" => Ok(PluginOutput::json(serde_json::Value::Null)),
                "echo" => Ok(PluginOutput {
                    result: request.params,
                    binary,
                    mime_type: request.binary.and_then(|binary| binary.mime_type),
                }),
                "host.echo" => {
                    context
                        .call_host(
                            "log",
                            json!({"level":"info", "message":"Echo host callback"}),
                            Vec::new(),
                            None,
                        )
                        .await
                }
                "hooks.beforeCommit" => {
                    let proposal: PluginMutationProposal = serde_json::from_value(
                        request.params["proposal"].clone(),
                    )
                    .map_err(|error| PluginRpcError::new("invalidProposal", error.to_string()))?;
                    // Read-only host calls remain available on the independent hooks instance.
                    context
                        .history_list(PluginHistoryQuery {
                            project_id: proposal.project_id.clone(),
                            offset: Some(0),
                            limit: Some(1),
                        })
                        .await?;
                    let mut operations = proposal.operations;
                    let mut changed = false;
                    for operation in &mut operations {
                        if let PluginOperation::TranslationSet {
                            value: PluginTranslation::Text(text),
                            ..
                        } = operation
                        {
                            let normalized = text.trim().replace("\r\n", "\n");
                            changed |= normalized != *text;
                            *text = normalized;
                        }
                    }
                    let result = if changed {
                        BeforeCommitHookResult::Replace { operations }
                    } else {
                        BeforeCommitHookResult::Continue
                    };
                    Ok(PluginOutput::json(serde_json::to_value(result).unwrap()))
                }
                "commands.execute" => {
                    if request.params["commandId"] == "task-demo" {
                        let total = request.params["params"]["steps"]
                            .as_u64()
                            .unwrap_or(100)
                            .min(200);
                        for completed in 0..total {
                            context.check_cancelled()?;
                            context.report_progress(json!({"phase":"working","message":"Rust command step","completed":completed,"total":total}))?;
                            yield_step().await;
                        }
                        context.summary("Rust command completed")?;
                        return Ok(PluginOutput::json(json!({"completed":total})));
                    }
                    let document = context.document_read(serde_json::Value::Null).await?;
                    let project_id = document
                        .get("projectId")
                        .or_else(|| document.get("id"))
                        .and_then(|value| value.as_str())
                        .ok_or_else(|| PluginRpcError::new("noProject", "Open a project first"))?;
                    let history = context
                        .history_list(PluginHistoryQuery {
                            project_id: project_id.into(),
                            offset: Some(0),
                            limit: Some(20),
                        })
                        .await?;
                    let images = context.images_list(project_id).await?;
                    let Some(image) = images.first() else {
                        return Ok(PluginOutput::json(json!({"history":history,"images":0})));
                    };
                    let bytes = context.images_read(project_id, &image.id, None).await?;
                    if request.params["commandId"] == "duplicate-image" {
                        let staged = context
                            .images_stage(project_id, Some(&image.filename), bytes.binary)
                            .await?;
                        let id = context.create_id();
                        let result = context
                            .history_push(PluginTransaction {
                                project_id: project_id.into(),
                                label: "Rust: duplicate image".into(),
                                operations: vec![PluginOperation::ImageCreate {
                                    id: id.clone(),
                                    staged_resource: staged.staged_resource,
                                    filename: Some(format!("copy-{}", image.filename)),
                                }],
                                expected_state_id: None,
                                causation_id: None,
                            })
                            .await?;
                        Ok(PluginOutput::json(json!({"imageId":id,"result":result})))
                    } else {
                        context.call_host("log", json!({"level":"info","message":format!("{} images, {} undo entries; first image has {} bytes", images.len(), history.undo_total, bytes.binary.len())}), vec![], None).await?;
                        Ok(PluginOutput::json(
                            json!({"history":history,"metadata":bytes.metadata}),
                        ))
                    }
                }
                "ocr.recognize" => {
                    if binary.is_empty() {
                        return Err(PluginRpcError::new(
                            "invalidInput",
                            "OCR example expects a binary image attachment",
                        ));
                    }
                    let task_id = request
                        .params
                        .get("taskId")
                        .and_then(|id| id.as_str())
                        .unwrap_or("example");
                    context.progress(task_id, json!({"completed":1,"total":1}))?;
                    Ok(PluginOutput::json(
                        json!({"text":format!("Received {} image bytes", binary.len())}),
                    ))
                }
                "translation.translate" => {
                    let input = request
                        .params
                        .get("input")
                        .and_then(|input| input.get("text"))
                        .and_then(|text| text.as_str())
                        .ok_or_else(|| {
                            PluginRpcError::new(
                                "invalidInput",
                                "Translation example expects input.text",
                            )
                        })?;
                    Ok(PluginOutput::json(
                        json!({"text":format!("[example] {input}")}),
                    ))
                }
                _ => Err(PluginRpcError::new(
                    "methodNotFound",
                    "The echo example does not implement this method",
                )),
            }
        })
    }
    fn on_event(&mut self, event: PluginEvent, _binary: Vec<u8>) -> Result<(), PluginRpcError> {
        if event.event == "$cancel" {
            eprintln!("Cancelled request: {}", event.data);
        }
        Ok(())
    }
    fn on_event_with_context<'a>(
        &'a mut self,
        event: PluginEvent,
        binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginEventFuture<'a> {
        Box::pin(async move {
            if event.event == "document.changed" {
                if let Some(project_id) =
                    event.data.get("projectId").and_then(|value| value.as_str())
                {
                    let history = context
                        .history_list(PluginHistoryQuery {
                            project_id: project_id.into(),
                            offset: Some(0),
                            limit: Some(1),
                        })
                        .await?;
                    context.call_host("log", json!({"level":"info","message":format!("Committed history revision {}", history.history_revision)}), vec![], None).await?;
                }
                Ok(())
            } else {
                self.on_event(event, binary)
            }
        })
    }
}

async fn yield_step() {
    #[cfg(not(target_arch = "wasm32"))]
    std::thread::sleep(std::time::Duration::from_millis(10));
    #[cfg(target_arch = "wasm32")]
    {
        use bubblefish_plugin_sdk_next::wasm::{
            js_sys,
            wasm_bindgen::{JsCast, JsValue},
            wasm_bindgen_futures::JsFuture,
        };
        let global = js_sys::global();
        let timer = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .unwrap()
            .dyn_into::<js_sys::Function>()
            .unwrap();
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            timer
                .call2(&global, &resolve, &JsValue::from_f64(10.0))
                .unwrap();
        });
        JsFuture::from(promise).await.unwrap();
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    if let Err(error) = native::serve_stdio(Echo) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
