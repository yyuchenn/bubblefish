#![cfg(not(target_arch = "wasm32"))]
use bubblefish_plugin_sdk_next::*;
use serde_json::json;

struct TestPlugin;
impl Plugin for TestPlugin {
    fn manifest(&self) -> PluginManifest {
        serde_json::from_value(json!({"id":"test.echo","name":"Echo","version":"1","apiVersion":1,"entrypoints":{"web":"echo.js"},"contributes":{}})).unwrap()
    }
    fn handle<'a>(
        &'a mut self,
        request: PluginRequest,
        binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginFuture<'a> {
        Box::pin(async move {
            match request.method.as_str() {
                "activate" => Ok(PluginOutput::json(serde_json::Value::Null)),
                "echo" => {
                    context.progress("task1", json!(0.5))?;
                    Ok(PluginOutput {
                        result: request.params,
                        binary,
                        mime_type: request.binary.and_then(|binary| binary.mime_type),
                    })
                }
                "read" => {
                    context
                        .call_host("resources.read", json!({"path":"image.png"}), vec![], None)
                        .await
                }
                "role" => Ok(PluginOutput::json(
                    serde_json::to_value(context.runtime_role).unwrap(),
                )),
                "busy" => {
                    context.report_progress(json!({"message":"started"}))?;
                    for _ in 0..2_000 {
                        context.check_cancelled()?;
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Ok(PluginOutput::json(json!("finished")))
                }
                "command-result" => {
                    assert_eq!(context.request_id(), Some("command"));
                    assert_eq!(context.task_id(), Some("task-command"));
                    context.report_progress(json!({"completed":1,"total":1}))?;
                    context.summary("检查完成")?;
                    Ok(PluginOutput::json(json!(false)))
                }
                "commit" => {
                    let result = context
                        .call_host(
                            "document.transaction",
                            json!({"label":"committed"}),
                            vec![],
                            None,
                        )
                        .await?;
                    context.emit("ack.consumed", result.result.clone())?;
                    Ok(result)
                }
                "inspect" => {
                    let images = context.images_list("p").await?;
                    let bytes = context.images_read("p", &images[0].id, None).await?;
                    let staged = context
                        .images_stage("p", Some("copy.png"), bytes.binary)
                        .await?;
                    let history = context
                        .history_list(PluginHistoryQuery {
                            project_id: "p".into(),
                            offset: Some(0),
                            limit: Some(1),
                        })
                        .await?;
                    Ok(PluginOutput::json(
                        json!({"staged":staged.staged_resource,"historyRevision":history.history_revision}),
                    ))
                }
                "register-hook" => {
                    context
                        .register_before_commit(BeforeCommitHookInfo {
                            id: "check".into(),
                            priority: None,
                            operations: None,
                        })
                        .await?;
                    Ok(PluginOutput::json(serde_json::Value::Null))
                }
                "read-staged" => {
                    let image = context.images_read_staged("p", "lease", None).await?;
                    Ok(PluginOutput {
                        result: serde_json::to_value(image.metadata).unwrap(),
                        binary: image.binary,
                        mime_type: Some("image/png".into()),
                    })
                }
                "missing-image" => Ok(PluginOutput::json(
                    serde_json::to_value(context.images_get("p", "missing").await?).unwrap(),
                )),
                "local-resources" => {
                    let input: PluginLocalResourceImport =
                        serde_json::from_value(request.params).unwrap();
                    let imported = context.resources_local_begin_import(input).await?;
                    context
                        .resources_local_write_chunk(&imported.token, "encoder.onnx", 0, binary)
                        .await?;
                    let committed = context
                        .resources_local_commit_import(&imported.token)
                        .await?;
                    let sets = context.resources_local_list().await?;
                    let bytes = context
                        .resources_local_read(&committed.id, "encoder.onnx")
                        .await?;
                    context.resources_local_remove(&committed.id).await?;
                    context
                        .resources_local_abort_import("aborted-token")
                        .await?;
                    Ok(PluginOutput {
                        result: json!({"sets":sets.len()}),
                        binary: bytes,
                        mime_type: None,
                    })
                }
                _ => Err(PluginRpcError::new("methodNotFound", "Unknown method")),
            }
        })
    }
    fn on_event_with_context<'a>(
        &'a mut self,
        event: PluginEvent,
        _binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginEventFuture<'a> {
        Box::pin(async move {
            if event.event == "document.changed" {
                context
                    .history_list(PluginHistoryQuery {
                        project_id: "p".into(),
                        offset: None,
                        limit: None,
                    })
                    .await?;
            }
            Ok(())
        })
    }
}
fn request(id: &str, method: &str, params: serde_json::Value, binary: Vec<u8>) -> Frame {
    let attachment = (!binary.is_empty()).then_some(BinaryAttachment {
        byte_length: binary.len() as u32,
        mime_type: Some("image/png".into()),
    });
    Frame {
        message: PluginMessage::Request(PluginRequest {
            api_version: 1,
            id: id.into(),
            method: method.into(),
            params,
            binary: attachment,
        }),
        binary,
    }
}
fn handshake() -> Frame {
    request(
        "hello",
        "handshake",
        json!({"apiVersion":1,"pluginId":"test.echo","hostVersion":"1","platform":"native","permissions":[]}),
        vec![],
    )
}
fn run(frames: &[Frame]) -> Vec<Frame> {
    let input: Vec<u8> = frames
        .iter()
        .flat_map(|frame| encode_frame(frame).unwrap())
        .collect();
    let mut output = Vec::new();
    native::serve(TestPlugin, &input[..], &mut output).unwrap();
    let mut reader = &output[..];
    let mut frames = Vec::new();
    while let Some(frame) = read_frame(&mut reader).unwrap() {
        frames.push(frame);
    }
    frames
}
fn response(id: &str, result: serde_json::Value, binary: Vec<u8>) -> Frame {
    Frame {
        message: PluginMessage::Response(PluginResponse {
            api_version: 1,
            id: id.into(),
            result: Some(result),
            error: None,
            binary: (!binary.is_empty()).then_some(BinaryAttachment {
                byte_length: binary.len() as u32,
                mime_type: Some("image/png".into()),
            }),
        }),
        binary,
    }
}

#[test]
fn typed_image_and_history_helpers_preserve_binary_golden_trace() {
    let image =
        json!({"id":"i","assetId":"a","filename":"image.png","width":2,"height":3,"markers":[]});
    let frames = run(&[
        handshake(),
        request("inspect", "inspect", json!({}), vec![]),
        response("test.echo:1", json!([image]), vec![]),
        response(
            "test.echo:2",
            json!({"image":image,"mimeType":"image/png","byteLength":4}),
            vec![0, 255, 128, 7],
        ),
        response(
            "test.echo:3",
            json!({"stagedResource":"lease","assetId":"new","width":2,"height":3,"checksum":"hash","filename":"copy.png","mimeType":"image/png"}),
            vec![],
        ),
        response(
            "test.echo:4",
            json!({"undo":[],"redo":[],"undoTotal":0,"redoTotal":0,"historyRevision":9}),
            vec![],
        ),
    ]);
    let methods: Vec<_> = frames
        .iter()
        .filter_map(|frame| match &frame.message {
            PluginMessage::Request(request) => Some(request.method.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        methods,
        [
            "document.images.list",
            "document.images.read",
            "document.images.stage",
            "history.list"
        ]
    );
    assert_eq!(frames[3].binary, [0, 255, 128, 7]);
    assert!(
        matches!(&frames[5].message, PluginMessage::Response(response) if response.result == Some(json!({"staged":"lease","historyRevision":9})))
    );
}

#[test]
fn hook_role_is_bound_by_handshake_and_async_events_can_query_host() {
    let mut hello = handshake();
    if let PluginMessage::Request(request) = &mut hello.message {
        request.params["runtimeRole"] = json!("hooks");
    }
    let frames = run(&[
        hello,
        request("register", "register-hook", json!({}), vec![]),
        response("test.echo:1", serde_json::Value::Null, vec![]),
        Frame {
            message: PluginMessage::Event(PluginEvent {
                api_version: 1,
                event: "document.changed".into(),
                data: json!({"projectId":"p"}),
                binary: None,
            }),
            binary: vec![],
        },
        // A queued request cannot change the role established by the handshake.
        request("role", "role", json!({"runtimeRole":"main"}), vec![]),
        response(
            "test.echo:2",
            json!({"undo":[],"redo":[],"undoTotal":0,"redoTotal":0,"historyRevision":0}),
            vec![],
        ),
    ]);
    assert!(
        matches!(&frames[1].message, PluginMessage::Request(request) if request.method == "hooks.register")
    );
    assert!(
        matches!(&frames[3].message, PluginMessage::Request(request) if request.method == "history.list")
    );
    assert!(
        matches!(&frames[4].message, PluginMessage::Response(response) if response.id == "role" && response.result == Some(json!("hooks")))
    );
}

#[test]
fn staged_reads_use_opaque_leases_and_get_preserves_missing_entities() {
    let image = json!({"id":"staged","assetId":"a","filename":"image.png","width":2,"height":3,"markers":[]});
    let frames = run(&[
        handshake(),
        request("read", "read-staged", json!({}), vec![]),
        response(
            "test.echo:1",
            json!({"image":image,"mimeType":"image/png","byteLength":3}),
            vec![0, 255, 128],
        ),
        request("missing", "missing-image", json!({}), vec![]),
        response("test.echo:2", serde_json::Value::Null, vec![]),
    ]);
    assert!(
        matches!(&frames[1].message, PluginMessage::Request(request) if request.params == json!({"projectId":"p","stagedResource":"lease"}))
    );
    assert_eq!(frames[2].binary, [0, 255, 128]);
    assert!(
        matches!(&frames[4].message, PluginMessage::Response(response) if response.result == Some(serde_json::Value::Null) && response.error.is_none())
    );
}

#[test]
fn handshake_lifecycle_progress_and_binary_use_the_same_stdio_protocol() {
    let frames = run(&[
        handshake(),
        request("activate", "activate", json!({"config":{}}), vec![]),
        request(
            "image",
            "echo",
            json!({"image":"metadata"}),
            vec![0, 128, 255],
        ),
    ]);
    assert_eq!(frames.len(), 4);
    assert!(
        matches!(&frames[0].message, PluginMessage::Response(response) if response.result.as_ref().unwrap()["pluginId"] == "test.echo")
    );
    assert!(
        matches!(&frames[1].message, PluginMessage::Response(response) if response.result == Some(serde_json::Value::Null))
    );
    assert!(
        matches!(&frames[2].message, PluginMessage::Event(event) if event.event == "task.progress")
    );
    assert_eq!(frames[3].binary, [0, 128, 255]);
}

#[test]
fn host_callbacks_correlate_and_preserve_queued_requests() {
    let host_response = Frame {
        message: PluginMessage::Response(PluginResponse {
            api_version: 1,
            id: "test.echo:1".into(),
            result: Some(json!({"ok":true})),
            error: None,
            binary: Some(BinaryAttachment {
                byte_length: 2,
                mime_type: None,
            }),
        }),
        binary: vec![5, 6],
    };
    // A request arriving while the plugin waits on a host call must not be lost.
    let frames = run(&[
        handshake(),
        request("read", "read", json!({}), vec![]),
        request("queued", "activate", json!({}), vec![]),
        host_response,
    ]);
    assert!(
        matches!(&frames[1].message, PluginMessage::Request(request) if request.method == "resources.read")
    );
    assert_eq!(frames[2].binary, [5, 6]);
    assert!(
        matches!(&frames[3].message, PluginMessage::Response(response) if response.id == "queued")
    );
}

#[test]
fn identity_mismatch_and_calls_before_handshake_return_errors() {
    let mut wrong = handshake();
    if let PluginMessage::Request(request) = &mut wrong.message {
        request.params["pluginId"] = json!("somebody.else");
    }
    let frames = run(&[request("early", "activate", json!({}), vec![]), wrong]);
    assert!(
        matches!(&frames[0].message, PluginMessage::Response(response) if response.error.as_ref().unwrap().code == "handshakeRequired")
    );
    assert!(
        matches!(&frames[1].message, PluginMessage::Response(response) if response.error.as_ref().unwrap().code == "incompatibleApi")
    );
}

#[test]
fn local_resource_helpers_use_bound_identity_and_binary_attachments() {
    let input = json!({"id":"model","files":[{"path":"encoder.onnx","byteLength":4,"sha256":"a".repeat(64)}]});
    let set = json!({"id":"model","files":input["files"],"createdAt":1234});
    let frames = run(&[
        handshake(),
        request(
            "local",
            "local-resources",
            input.clone(),
            vec![0, 255, 128, 7],
        ),
        response("test.echo:1", json!({"token":"token"}), vec![]),
        response("test.echo:2", serde_json::Value::Null, vec![]),
        response("test.echo:3", set.clone(), vec![]),
        response("test.echo:4", json!([set]), vec![]),
        response("test.echo:5", serde_json::Value::Null, vec![0, 255, 128, 7]),
        response("test.echo:6", serde_json::Value::Null, vec![]),
        response("test.echo:7", serde_json::Value::Null, vec![]),
    ]);
    let requests: Vec<_> = frames
        .iter()
        .filter_map(|frame| match &frame.message {
            PluginMessage::Request(request) => Some((request, &frame.binary)),
            _ => None,
        })
        .collect();
    assert_eq!(
        requests
            .iter()
            .map(|(request, _)| request.method.as_str())
            .collect::<Vec<_>>(),
        [
            "resources.local.beginImport",
            "resources.local.writeChunk",
            "resources.local.commitImport",
            "resources.local.list",
            "resources.local.read",
            "resources.local.remove",
            "resources.local.abortImport",
        ]
    );
    assert_eq!(requests[0].0.params, input);
    assert_eq!(
        requests[1].0.params,
        json!({"token":"token","path":"encoder.onnx","offset":0})
    );
    assert_eq!(*requests[1].1, [0, 255, 128, 7]);
    assert_eq!(
        requests[4].0.params,
        json!({"id":"model","path":"encoder.onnx"})
    );
    let last = frames.last().unwrap();
    assert_eq!(last.binary, [0, 255, 128, 7]);
    assert!(
        matches!(&last.message, PluginMessage::Response(response) if response.result == Some(json!({"sets":1})))
    );
}

#[test]
fn command_context_reports_summary_without_changing_raw_results() {
    let frames = run(&[
        handshake(),
        request(
            "command",
            "command-result",
            json!({"taskId":"task-command"}),
            vec![],
        ),
    ]);
    assert!(
        matches!(&frames[1].message, PluginMessage::Event(event) if event.event == "task.progress" && event.data["taskId"] == "task-command")
    );
    assert!(
        matches!(&frames[2].message, PluginMessage::Event(event) if event.event == "task.summary" && event.data == json!({"taskId":"task-command","message":"检查完成"}))
    );
    assert!(
        matches!(&frames[3].message, PluginMessage::Response(response) if response.result == Some(json!(false)))
    );
}

mod control {
    use super::*;
    use std::{
        io::{self, Cursor, Read, Write},
        sync::mpsc,
        time::Duration,
    };

    struct Reader {
        receiver: mpsc::Receiver<Vec<u8>>,
        current: Cursor<Vec<u8>>,
    }
    impl Read for Reader {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if bytes.is_empty() {
                return Ok(0);
            }
            loop {
                let count = self.current.read(bytes)?;
                if count != 0 {
                    return Ok(count);
                }
                match self.receiver.recv_timeout(Duration::from_secs(5)) {
                    Ok(next) => self.current = Cursor::new(next),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
                    Err(error) => return Err(io::Error::new(io::ErrorKind::TimedOut, error)),
                }
            }
        }
    }
    struct Writer(mpsc::Sender<Vec<u8>>);
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .send(bytes.to_vec())
                .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn pipe() -> (mpsc::Sender<Vec<u8>>, Reader) {
        let (send, receiver) = mpsc::channel();
        (
            send,
            Reader {
                receiver,
                current: Cursor::new(Vec::new()),
            },
        )
    }
    fn send(input: &mpsc::Sender<Vec<u8>>, frame: Frame) {
        input.send(encode_frame(&frame).unwrap()).unwrap();
    }
    fn next(output: &mut Reader) -> Frame {
        read_frame(output).unwrap().unwrap()
    }
    fn cancel(id: &str) -> Frame {
        Frame {
            message: PluginMessage::Event(PluginEvent {
                api_version: 1,
                event: "$cancel".into(),
                data: json!({"requestId":id}),
                binary: None,
            }),
            binary: vec![],
        }
    }

    #[test]
    fn busy_and_queued_requests_cancel_without_entering_queued_handler() {
        let (input, reader) = pipe();
        let (writer, mut output) = pipe();
        let server = std::thread::spawn(move || {
            native::serve_with_control(TestPlugin, reader, Writer(writer)).unwrap()
        });
        send(&input, handshake());
        next(&mut output);
        send(
            &input,
            request("active", "busy", json!({"taskId":"active-task"}), vec![]),
        );
        assert!(
            matches!(next(&mut output).message, PluginMessage::Event(event) if event.event == "task.progress")
        );
        send(&input, request("queued", "echo", json!({}), vec![]));
        send(&input, cancel("queued"));
        send(&input, cancel("active"));
        for id in ["active", "queued"] {
            assert!(
                matches!(next(&mut output).message, PluginMessage::Response(response) if response.id == id && response.error.as_ref().unwrap().code == "cancelled")
            );
        }
        send(&input, request("after", "role", json!({}), vec![]));
        assert!(
            matches!(next(&mut output).message, PluginMessage::Response(response) if response.id == "after" && response.result == Some(json!("main")))
        );
        drop(input);
        server.join().unwrap();
    }

    #[test]
    fn cancellation_does_not_skip_an_outstanding_mutation_ack() {
        let (input, reader) = pipe();
        let (writer, mut output) = pipe();
        let server = std::thread::spawn(move || {
            native::serve_with_control(TestPlugin, reader, Writer(writer)).unwrap()
        });
        send(&input, handshake());
        next(&mut output);
        send(
            &input,
            request("commit", "commit", json!({"taskId":"commit-task"}), vec![]),
        );
        let host_request = next(&mut output);
        assert!(
            matches!(&host_request.message, PluginMessage::Request(request) if request.method == "document.transaction")
        );
        send(&input, cancel("commit"));
        send(&input, request("queued", "role", json!({}), vec![]));
        send(
            &input,
            response("test.echo:1", json!({"applied":true}), vec![]),
        );
        assert!(
            matches!(next(&mut output).message, PluginMessage::Event(event) if event.event == "ack.consumed" && event.data["applied"] == true)
        );
        assert!(
            matches!(next(&mut output).message, PluginMessage::Response(response) if response.id == "commit" && response.error.as_ref().unwrap().code == "cancelled")
        );
        assert!(
            matches!(next(&mut output).message, PluginMessage::Response(response) if response.id == "queued" && response.result == Some(json!("main")))
        );
        drop(input);
        server.join().unwrap();
    }
}
