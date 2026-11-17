use bubblefish_core::*;

fn assistance(image_id: &str, marker_id: &str) -> AssistanceUpdate {
    AssistanceUpdate {
        image_id: image_id.into(),
        marker_id: marker_id.into(),
        ..Default::default()
    }
}

fn translation(image_id: &str, marker_id: &str, value: &str) -> TranslationUpdate {
    TranslationUpdate {
        image_id: image_id.into(),
        marker_id: marker_id.into(),
        translation: text(value),
    }
}

#[test]
fn translation_updates_and_assistance_form_one_undo_step_without_changing_metadata() {
    let mut h = Harness::new();
    for (page, id) in [("page1", "m1"), ("page2", "m2")] {
        h.call(Command::AddMarker {
            image_id: page.into(),
            marker: marker(id),
        });
    }
    let before = h.doc();
    let mut original = assistance("page1", "m1");
    original.original_text = Some(Some("new original".into()));
    let patch = h.call(Command::Batch {
        commands: vec![
            Command::UpdateTranslations {
                updates: vec![
                    translation("page1", "m1", "first"),
                    translation("page2", "m2", "second"),
                ],
            },
            Command::UpdateAssistance {
                updates: vec![original],
            },
        ],
        expected_state_id: None,
    });
    assert_eq!(patch.history_depth, 3);
    assert_eq!(patch.upsert_images.len(), 2);
    let after = h.doc();
    assert_eq!(after.images[0].markers[0].translation, text("first"));
    assert_eq!(after.images[1].markers[0].translation, text("second"));
    for (previous, current) in before.images.iter().zip(&after.images) {
        assert_eq!(previous.markers[0].geometry, current.markers[0].geometry);
        assert_eq!(previous.markers[0].style, current.markers[0].style);
    }
    assert_eq!(
        after.images[1].markers[0].bunny_cache,
        before.images[1].markers[0].bunny_cache
    );
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
    h.call(Command::Redo);
    assert_eq!(h.doc(), after);
}

#[test]
fn translation_updates_reject_missing_duplicate_and_invalid_targets_atomically() {
    let mut h = Harness::new();
    for id in ["m1", "m2"] {
        h.call(Command::AddMarker {
            image_id: "page1".into(),
            marker: marker(id),
        });
    }
    let before = h.doc();
    let history = h.engine.history("p", HistoryQuery::default()).unwrap();
    let first = translation("page1", "m1", "changed");
    let mut invalid = translation("page1", "m2", "invalid");
    invalid.translation.runs[0].marks = vec![TextMark::Bold, TextMark::Bold];
    for (updates, code) in [
        (
            vec![first.clone(), translation("missing", "m2", "missing")],
            "imageNotFound",
        ),
        (
            vec![first.clone(), translation("page1", "missing", "missing")],
            "markerNotFound",
        ),
        (
            vec![first.clone(), first.clone()],
            "duplicateTranslationUpdate",
        ),
        (vec![first.clone(), invalid], "invalidMarks"),
    ] {
        h.fail(Command::UpdateTranslations { updates }, code);
        assert_eq!(h.doc(), before);
        assert_eq!(
            h.engine.history("p", HistoryQuery::default()).unwrap(),
            history
        );
    }
}

#[test]
fn translation_update_preview_is_read_only_and_checks_the_base_state() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let before = h.doc();
    let history = h.engine.history("p", HistoryQuery::default()).unwrap();
    let command = Command::UpdateTranslations {
        updates: vec![translation("page1", "m1", "preview")],
    };
    let preview = h.engine.preview("p", vec![command.clone()], None).unwrap();
    assert_eq!(preview.images[0].markers[0].translation, text("preview"));
    assert_eq!(h.doc(), before);
    assert_eq!(
        h.engine.history("p", HistoryQuery::default()).unwrap(),
        history
    );
    assert_eq!(
        h.engine
            .preview("p", vec![command], Some("stale".into()))
            .unwrap_err()
            .code,
        "stateConflict"
    );
}

#[test]
fn translation_updates_cover_fifteen_thousand_markers_in_one_history_entry() {
    let mut h = Harness {
        engine: Engine::new(),
        next: 0,
    };
    let mut document = document("p");
    document.images = (0..500)
        .map(|page| {
            let mut image = image(&format!("page-{page}"));
            image.markers = (0..30)
                .map(|index| marker(&format!("marker-{page}-{index}")))
                .collect();
            image
        })
        .collect();
    let before = document.clone();
    let updates = document
        .images
        .iter()
        .flat_map(|image| {
            image
                .markers
                .iter()
                .map(|marker| translation(&image.id, &marker.id, "replaced"))
        })
        .collect();
    h.call(Command::CreateProject {
        document,
        saved: true,
    });
    let patch = h.call(Command::UpdateTranslations { updates });
    assert_eq!(patch.history_depth, 1);
    assert_eq!(patch.upsert_images.len(), 500);
    assert!(h
        .doc()
        .images
        .iter()
        .flat_map(|image| &image.markers)
        .all(|marker| marker.translation == text("replaced")));
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
}

#[test]
fn assistance_updates_preserve_unknown_cache_and_form_one_undo_step() {
    let mut h = Harness::new();
    let mut first = marker("m1");
    first.bunny_cache = Some(
        serde_json::json!({"originalText":"old","futureField":{"keep":true},"lastOcrModel":"old-model"}),
    );
    first.translation = text("人工译文");
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: first,
    });
    h.call(Command::AddMarker {
        image_id: "page2".into(),
        marker: marker("m2"),
    });
    let before = h.doc();
    let mut update1 = assistance("page1", "m1");
    update1.original_text = Some(Some("new".into()));
    update1.last_ocr_model = Some(None);
    let mut update2 = assistance("page2", "m2");
    update2.machine_translation = Some(Some("机器译文".into()));
    let patch = h.call(Command::UpdateAssistance {
        updates: vec![update1, update2],
    });
    assert_eq!(patch.history_depth, 3);
    assert_eq!(patch.upsert_images.len(), 2);
    let after = h.doc();
    let first = &after.images[0].markers[0];
    assert_eq!(first.translation, text("人工译文"));
    assert_eq!(
        first.bunny_cache,
        Some(serde_json::json!({"originalText":"new","futureField":{"keep":true}}))
    );
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
    h.call(Command::Redo);
    assert_eq!(h.doc(), after);
}

#[test]
fn assistance_batches_reject_missing_targets_and_duplicate_updates_atomically() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let before = h.doc();
    let mut update = assistance("page1", "m1");
    update.original_text = Some(Some("changed".into()));
    h.fail(
        Command::UpdateAssistance {
            updates: vec![update.clone(), assistance("page1", "missing")],
        },
        "markerNotFound",
    );
    assert_eq!(h.doc(), before);
    h.fail(
        Command::UpdateAssistance {
            updates: vec![update.clone(), update],
        },
        "duplicateAssistanceUpdate",
    );
    assert_eq!(h.doc(), before);
}

#[test]
fn assistance_preconditions_reject_stale_geometry_asset_text_and_languages() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let before = h.doc();
    let stale = [
        AssistanceExpected {
            asset_id: Some("wrong".into()),
            ..Default::default()
        },
        AssistanceExpected {
            geometry: Some(Geometry::Point { x: 0.1, y: 0.2 }),
            ..Default::default()
        },
        AssistanceExpected {
            original_text: Some(Some("different".into())),
            ..Default::default()
        },
        AssistanceExpected {
            original_text: Some(None),
            ..Default::default()
        },
        AssistanceExpected {
            machine_translation: Some(Some("different".into())),
            ..Default::default()
        },
        AssistanceExpected {
            source_language: Some("different".into()),
            ..Default::default()
        },
        AssistanceExpected {
            target_language: Some("different".into()),
            ..Default::default()
        },
    ];
    for expected in stale {
        let mut update = assistance("page1", "m1");
        update.machine_translation = Some(Some("must not persist".into()));
        update.expected = Some(expected);
        h.fail(
            Command::UpdateAssistance {
                updates: vec![update],
            },
            "assistanceConflict",
        );
        assert_eq!(h.doc(), before);
    }
    let mut valid = assistance("page1", "m1");
    valid.machine_translation = Some(Some("机器译文".into()));
    valid.expected = Some(AssistanceExpected {
        asset_id: Some("asset-page1".into()),
        geometry: Some(Geometry::Point { x: 0.25, y: 0.5 }),
        original_text: Some(Some("原文".into())),
        machine_translation: Some(None),
        source_language: Some("japanese".into()),
        target_language: Some("simplifiedChinese".into()),
    });
    h.call(Command::UpdateAssistance {
        updates: vec![valid],
    });
}

#[test]
fn assistance_wire_distinguishes_omitted_and_cleared_fields() {
    let command: Command = serde_json::from_value(serde_json::json!({"type":"updateAssistance","updates":[{"imageId":"page1","markerId":"m1","originalText":null,"expected":{"originalText":null}}]})).unwrap();
    let Command::UpdateAssistance { updates } = &command else {
        panic!("unexpected command")
    };
    assert_eq!(updates[0].original_text, Some(None));
    assert_eq!(updates[0].machine_translation, None);
    assert_eq!(
        updates[0].expected.as_ref().unwrap().original_text,
        Some(None)
    );
    let encoded = serde_json::to_value(command).unwrap();
    assert!(encoded["updates"][0].get("machineTranslation").is_none());
    assert_eq!(
        encoded["updates"][0]["originalText"],
        serde_json::Value::Null
    );
}

#[test]
fn assistance_null_preconditions_do_not_match_unknown_nontext_cache_values() {
    let mut h = Harness::new();
    let mut value = marker("m1");
    value.bunny_cache = Some(serde_json::json!({"originalText":{"future":"format"},"unknown":42}));
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: value,
    });
    let before = h.doc();
    let mut update = assistance("page1", "m1");
    update.original_text = Some(Some("new".into()));
    update.expected = Some(AssistanceExpected {
        original_text: Some(None),
        ..Default::default()
    });
    h.fail(
        Command::UpdateAssistance {
            updates: vec![update],
        },
        "assistanceConflict",
    );
    assert_eq!(h.doc(), before);
}

fn marker(id: &str) -> Marker {
    Marker {
        id: id.into(),
        geometry: Geometry::Point { x: 0.25, y: 0.5 },
        translation: RichText::default(),
        style: MarkerStyle::default(),
        bunny_cache: Some(serde_json::json!({"originalText":"原文"})),
    }
}
fn image(id: &str) -> ImageDocument {
    ImageDocument {
        id: id.into(),
        asset_id: format!("asset-{id}"),
        filename: format!("{id}.png"),
        width: 1200,
        height: 1800,
        checksum: None,
        markers: vec![],
    }
}
fn document(id: &str) -> ProjectDocument {
    ProjectDocument {
        id: id.into(),
        name: "测试漫画".into(),
        source_language: "japanese".into(),
        target_language: "simplifiedChinese".into(),
        images: vec![image("page1"), image("page2")],
    }
}
fn text(value: &str) -> RichText {
    RichText {
        runs: vec![TextRun {
            text: value.into(),
            marks: vec![],
        }],
        raw: None,
    }
}
fn bookmark(anchor: u32, head: u32) -> EditorBookmark {
    EditorBookmark {
        image_id: "page1".into(),
        marker_id: "m1".into(),
        anchor,
        head,
        stored_marks: vec![TextMark::Bold],
        focus_editor: None,
    }
}
struct Harness {
    engine: Engine,
    next: u32,
}
impl Harness {
    fn new() -> Self {
        let mut harness = Self {
            engine: Engine::new(),
            next: 0,
        };
        harness.call(Command::CreateProject {
            document: document("p"),
            saved: true,
        });
        harness
    }
    fn envelope(&mut self, command: Command, history: Option<HistoryMeta>) -> Envelope {
        self.next += 1;
        Envelope {
            command_id: self.next.to_string(),
            session_id: "test".into(),
            project_id: Some("p".into()),
            command,
            history,
            expected_state_id: None,
        }
    }
    fn call(&mut self, command: Command) -> ProjectPatch {
        self.group(command, None)
    }
    fn group(&mut self, command: Command, history: Option<HistoryMeta>) -> ProjectPatch {
        let envelope = self.envelope(command, history);
        let reply = self.engine.dispatch(envelope);
        assert!(reply.error.is_none(), "{:?}", reply.error);
        reply.patch.unwrap()
    }
    fn fail(&mut self, command: Command, expected: &str) {
        let envelope = self.envelope(command, None);
        let reply = self.engine.dispatch(envelope);
        assert_eq!(reply.error.unwrap().code, expected);
    }
    fn doc(&self) -> ProjectDocument {
        self.engine.document("p").unwrap()
    }
}

#[test]
fn mutations_are_atomic_and_patches_only_include_changed_pages() {
    let mut h = Harness::new();
    let before = h.doc();
    h.fail(
        Command::AddImages {
            images: vec![image("new"), image("page1")],
        },
        "duplicateId",
    );
    assert_eq!(h.doc(), before);
    let patch = h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    assert_eq!(patch.upsert_images.len(), 1);
    assert_eq!(patch.upsert_images[0].id, "page1");
    assert_eq!(patch.history_depth, 1);
    h.fail(
        Command::UpdateMarker {
            image_id: "page1".into(),
            marker_id: "m1".into(),
            geometry: Some(Geometry::Point {
                x: f64::NAN,
                y: 0.5,
            }),
            translation: Some(text("must not persist")),
            style: None,
        },
        "invalidGeometry",
    );
    assert_eq!(
        h.doc().images[0].markers[0].translation,
        RichText::default()
    );
}

#[test]
fn remove_image_restores_markers_cache_and_exact_order() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let before = h.doc();
    let removed = h.call(Command::RemoveImage {
        image_id: "page1".into(),
    });
    assert_eq!(removed.removed_image_ids, ["page1"]);
    assert_eq!(h.doc().images.len(), 1);
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
    h.call(Command::Redo);
    assert_eq!(h.doc().images[0].id, "page2");
}

#[test]
fn group_history_restores_full_editor_bookmarks() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    for (value, a, b) in [("中", 1, 2), ("中文😀", 2, 6)] {
        h.group(
            Command::UpdateMarker {
                image_id: "page1".into(),
                marker_id: "m1".into(),
                geometry: None,
                translation: Some(text(value)),
                style: None,
            },
            Some(HistoryMeta {
                group_id: Some("composition-1".into()),
                label: "输入译文".into(),
                origin: None,
                before: Some(bookmark(a, a)),
                after: Some(bookmark(b, 1)),
            }),
        );
    }
    assert_eq!(h.call(Command::EndGroup).history_depth, 2);
    let undo = h.call(Command::Undo);
    assert_eq!(undo.focus, Some(bookmark(1, 1)));
    assert_eq!(
        h.doc().images[0].markers[0].translation,
        RichText::default()
    );
    let redo = h.call(Command::Redo);
    assert_eq!(redo.focus, Some(bookmark(6, 1)));
    assert_eq!(h.doc().images[0].markers[0].translation, text("中文😀"));
}

#[test]
fn canvas_history_roundtrips_navigation_without_requesting_editor_focus() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let mut before = bookmark(1, 1);
    before.focus_editor = Some(false);
    let after = EditorBookmark {
        image_id: "page2".into(),
        marker_id: String::new(),
        anchor: 1,
        head: 1,
        stored_marks: vec![],
        focus_editor: Some(false),
    };
    h.group(
        Command::RemoveImage {
            image_id: "page1".into(),
        },
        Some(HistoryMeta {
            group_id: None,
            label: "删除图片".into(),
            origin: None,
            before: Some(before.clone()),
            after: Some(after.clone()),
        }),
    );
    assert_eq!(h.call(Command::Undo).focus, Some(before));
    assert_eq!(h.call(Command::Redo).focus, Some(after));
    assert!(serde_json::to_value(bookmark(1, 1))
        .unwrap()
        .get("focusEditor")
        .is_none());
    let restored = h.call(Command::Undo).focus.unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap()["focusEditor"],
        false
    );
}

#[test]
fn group_ends_on_explicit_barrier_and_undo_branch() {
    let mut h = Harness::new();
    let history = Some(HistoryMeta {
        group_id: Some("same".into()),
        label: "名称".into(),
        origin: None,
        before: None,
        after: None,
    });
    h.group(
        Command::UpdateProject {
            name: Some("一".into()),
            source_language: None,
            target_language: None,
        },
        history.clone(),
    );
    h.call(Command::EndGroup);
    let patch = h.group(
        Command::UpdateProject {
            name: Some("二".into()),
            source_language: None,
            target_language: None,
        },
        history.clone(),
    );
    assert_eq!(patch.history_depth, 2);
    h.call(Command::Undo);
    let patch = h.group(
        Command::UpdateProject {
            name: Some("三".into()),
            source_language: None,
            target_language: None,
        },
        history,
    );
    assert_eq!(patch.history_depth, 2);
    assert!(!patch.can_redo);
    h.call(Command::Undo);
    assert_eq!(h.doc().name, "一");
}

#[test]
fn saved_content_identity_survives_undo_and_async_save() {
    let mut h = Harness::new();
    let first = h
        .call(Command::UpdateProject {
            name: Some("已写出".into()),
            source_language: None,
            target_language: None,
        })
        .state_id;
    let second = h
        .call(Command::UpdateProject {
            name: Some("继续编辑".into()),
            source_language: None,
            target_language: None,
        })
        .state_id;
    let save = h.call(Command::MarkSaved {
        state_id: first.clone(),
    });
    assert_eq!(save.state_id, second);
    assert_eq!(save.saved_state_id, Some(first.clone()));
    let undo = h.call(Command::Undo);
    assert_eq!(undo.state_id, first);
    assert_eq!(undo.saved_state_id, Some(undo.state_id.clone()));
    h.fail(
        Command::MarkSaved {
            state_id: "not-produced".into(),
        },
        "unknownState",
    );
}

#[test]
fn retries_are_idempotent_and_sessions_are_isolated() {
    let mut h = Harness::new();
    let envelope = h.envelope(
        Command::AddMarker {
            image_id: "page1".into(),
            marker: marker("m1"),
        },
        None,
    );
    let first = h.engine.dispatch(envelope.clone());
    let repeated = h.engine.dispatch(envelope.clone());
    assert_eq!(first, repeated);
    assert_eq!(h.doc().images[0].markers.len(), 1);
    let mut different_session = envelope;
    different_session.session_id = "other-window".into();
    let error = h.engine.dispatch(different_session);
    assert_eq!(error.error.unwrap().code, "duplicateId");
    assert!(error.event_revision > first.event_revision);
}

#[test]
fn failed_commands_are_cached_without_consuming_state_ids() {
    let mut h = Harness::new();
    let bad = h.envelope(
        Command::ReorderImages {
            image_ids: vec!["page1".into(), "page1".into()],
        },
        None,
    );
    assert_eq!(h.engine.dispatch(bad.clone()), h.engine.dispatch(bad));
    let patch = h.call(Command::UpdateProject {
        name: Some("new".into()),
        source_language: None,
        target_language: None,
    });
    assert_eq!(patch.state_id, "p:1");
}

fn lifecycle_envelope(command_id: &str, command: Command) -> Envelope {
    Envelope {
        command_id: command_id.into(),
        session_id: "receipt-test".into(),
        project_id: Some("p".into()),
        command,
        history: None,
        expected_state_id: None,
    }
}

#[test]
fn acknowledged_replies_release_merged_versions_and_closed_project_documents() {
    use std::sync::Arc;

    let mut engine = Engine::new();
    let create = lifecycle_envelope(
        "create",
        Command::CreateProject {
            document: document("p"),
            saved: true,
        },
    );
    let created = engine.dispatch(create);
    let initial_images: Vec<_> = created
        .patch
        .as_ref()
        .unwrap()
        .upsert_images
        .iter()
        .map(Arc::downgrade)
        .collect();
    engine.acknowledge("receipt-test", "create");
    drop(created);

    let metadata = Some(HistoryMeta {
        group_id: Some("typing".into()),
        label: "Typing".into(),
        origin: None,
        before: None,
        after: None,
    });
    let mut first = lifecycle_envelope(
        "first",
        Command::AddMarker {
            image_id: "page1".into(),
            marker: marker("m1"),
        },
    );
    first.history = metadata.clone();
    let first_reply = engine.dispatch(first.clone());
    let intermediate = Arc::downgrade(&first_reply.patch.as_ref().unwrap().upsert_images[0]);
    let mut second = lifecycle_envelope(
        "second",
        Command::UpdateMarker {
            image_id: "page1".into(),
            marker_id: "m1".into(),
            geometry: None,
            translation: Some(text("translated")),
            style: None,
        },
    );
    second.history = metadata;
    let second_reply = engine.dispatch(second);
    let current = Arc::downgrade(&second_reply.patch.as_ref().unwrap().upsert_images[0]);
    assert_eq!(
        engine
            .history("p", HistoryQuery::default())
            .unwrap()
            .undo_total,
        1
    );
    // An unacknowledged reply must still survive later commands exactly.
    assert_eq!(engine.dispatch(first), first_reply);
    drop(first_reply);
    drop(second_reply);
    assert!(intermediate.upgrade().is_some());
    engine.acknowledge("receipt-test", "first");
    assert!(intermediate.upgrade().is_none());
    engine.acknowledge("receipt-test", "second");
    assert!(initial_images.iter().all(|image| image.upgrade().is_some()));
    assert!(current.upgrade().is_some());

    let close = lifecycle_envelope("close", Command::CloseProject);
    let closed = engine.dispatch(close.clone());
    assert_eq!(engine.dispatch(close), closed);
    engine.acknowledge("receipt-test", "close");
    assert!(initial_images.iter().all(|image| image.upgrade().is_none()));
    assert!(current.upgrade().is_none());
}

#[test]
fn acknowledgements_are_idempotent_and_isolate_existing_session_command_pairs() {
    let mut h = Harness::new();
    let invalid = h.envelope(
        Command::ReorderImages {
            image_ids: vec!["page1".into(), "page1".into()],
        },
        None,
    );
    let failed = h.engine.dispatch(invalid.clone());
    assert_eq!(failed.error.as_ref().unwrap().code, "invalidOrder");
    let mut other_session = invalid.clone();
    other_session.session_id = "other-session".into();
    let other_reply = h.engine.dispatch(other_session.clone());

    h.engine.acknowledge("unknown-session", &invalid.command_id);
    assert_eq!(h.engine.dispatch(invalid.clone()), failed);
    h.engine.acknowledge("test", &invalid.command_id);
    h.engine.acknowledge("test", &invalid.command_id);
    let retired = h.engine.dispatch(invalid);
    assert_eq!(retired.error.unwrap().code, "alreadyAcknowledged");
    assert_eq!(retired.event_revision, failed.event_revision);
    assert!(retired.patch.is_none());
    assert!(retired.closed_project_id.is_none());
    assert_eq!(h.engine.dispatch(other_session), other_reply);

    let future = h.envelope(
        Command::UpdateProject {
            name: Some("after receipt".into()),
            source_language: None,
            target_language: None,
        },
        None,
    );
    h.engine.acknowledge("test", &future.command_id);
    let reply = h.engine.dispatch(future);
    assert!(reply.error.is_none());
    assert_eq!(reply.event_revision, other_reply.event_revision + 1);
    assert_eq!(reply.patch.unwrap().state_id, "p:1");
}

#[test]
fn retired_lifecycle_and_history_commands_cannot_mutate_a_reopened_project() {
    let mut engine = Engine::new();
    let create = lifecycle_envelope(
        "create",
        Command::CreateProject {
            document: document("p"),
            saved: true,
        },
    );
    let created = engine.dispatch(create.clone());
    engine.acknowledge("receipt-test", "create");
    let added = lifecycle_envelope(
        "add",
        Command::AddMarker {
            image_id: "page1".into(),
            marker: marker("m1"),
        },
    );
    assert!(engine.dispatch(added).error.is_none());
    engine.acknowledge("receipt-test", "add");
    let undo = lifecycle_envelope("undo", Command::Undo);
    let undone = engine.dispatch(undo.clone());
    engine.acknowledge("receipt-test", "undo");
    let close = lifecycle_envelope("close", Command::CloseProject);
    let closed = engine.dispatch(close.clone());
    engine.acknowledge("receipt-test", "close");

    // Retrying an acknowledged create must not resurrect a closed project.
    let retired_create = engine.dispatch(create);
    assert_eq!(retired_create.error.unwrap().code, "alreadyAcknowledged");
    assert_eq!(retired_create.event_revision, created.event_revision);
    assert!(engine.document("p").is_err());

    let reopen = lifecycle_envelope(
        "reopen",
        Command::CreateProject {
            document: document("p"),
            saved: true,
        },
    );
    assert!(engine.dispatch(reopen).error.is_none());
    let edit = lifecycle_envelope(
        "new-edit",
        Command::AddMarker {
            image_id: "page1".into(),
            marker: marker("new-marker"),
        },
    );
    let edited = engine.dispatch(edit);
    let before = engine.document("p").unwrap();
    let history = engine.history("p", HistoryQuery::default()).unwrap();
    for (command, expected_revision) in [
        (undo, undone.event_revision),
        (close, closed.event_revision),
    ] {
        let retired = engine.dispatch(command);
        assert_eq!(retired.error.unwrap().code, "alreadyAcknowledged");
        assert_eq!(retired.event_revision, expected_revision);
        assert!(retired.patch.is_none());
        assert!(retired.closed_project_id.is_none());
        assert_eq!(engine.document("p").unwrap(), before);
        assert_eq!(
            engine.history("p", HistoryQuery::default()).unwrap(),
            history
        );
    }
    let next = engine.dispatch(lifecycle_envelope("new-undo", Command::Undo));
    assert_eq!(next.event_revision, edited.event_revision + 1);
    assert!(engine.document("p").unwrap().images[0].markers.is_empty());
}

#[test]
fn marker_order_keeps_bunny_cache_attached_to_identity() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let mut other = marker("m2");
    other.bunny_cache = Some(serde_json::json!({"originalText":"二"}));
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: other,
    });
    h.fail(
        Command::ReorderMarkers {
            image_id: "page1".into(),
            marker_ids: vec!["m1".into()],
        },
        "invalidOrder",
    );
    h.call(Command::ReorderMarkers {
        image_id: "page1".into(),
        marker_ids: vec!["m2".into(), "m1".into()],
    });
    assert_eq!(
        h.doc().images[0].markers[0].bunny_cache,
        Some(serde_json::json!({"originalText":"二"}))
    );
    h.call(Command::Undo);
    assert_eq!(h.doc().images[0].markers[0].id, "m1");
}

#[test]
fn projects_have_separate_histories_and_can_remove_every_image() {
    let mut h = Harness::new();
    h.call(Command::RemoveImage {
        image_id: "page1".into(),
    });
    h.call(Command::RemoveImage {
        image_id: "page2".into(),
    });
    assert!(h.doc().images.is_empty());
    h.call(Command::AddImages {
        images: vec![image("again")],
    });
    let envelope = h.envelope(
        Command::CreateProject {
            document: document("other"),
            saved: false,
        },
        None,
    );
    assert!(h.engine.dispatch(envelope).error.is_none());
    let mut undo = h.envelope(Command::Undo, None);
    undo.project_id = Some("other".into());
    assert!(!h.engine.dispatch(undo).patch.unwrap().can_undo);
    assert_eq!(h.doc().images[0].id, "again");
}

#[test]
fn invalid_geometry_duplicates_and_missing_dimensions_are_validated() {
    let mut doc = document("p");
    doc.images[0].width = 0;
    doc.images[0].height = 0;
    assert!(validate_document(&doc).is_ok());
    doc.images[0].markers.push(marker("m1"));
    doc.images[1].markers.push(marker("m1"));
    assert_eq!(validate_document(&doc).unwrap_err().code, "duplicateId");
    doc.images[1].markers.clear();
    doc.images[0].markers[0].geometry = Geometry::Rectangle {
        x: 0.9,
        y: 0.1,
        width: 0.2,
        height: 0.5,
    };
    assert_eq!(validate_document(&doc).unwrap_err().code, "invalidGeometry");
}

#[test]
fn wire_protocol_uses_camel_case_and_plain_number_revisions() {
    let envelope: Envelope = serde_json::from_value(serde_json::json!({
        "sessionId":"session", "commandId":"1", "projectId":"p",
        "command":{"type":"updateMarker", "imageId":"i", "markerId":"m", "translation":{"runs":[]}}
    }))
    .unwrap();
    assert!(matches!(
        envelope.command,
        Command::UpdateMarker { geometry: None, .. }
    ));
    let value = serde_json::to_value(envelope).unwrap();
    assert_eq!(value["command"]["imageId"], "i");
    assert!(value["command"].get("image_id").is_none());
}

#[test]
fn three_hundred_pages_fifty_markers_support_sparse_edits_and_history() {
    let mut h = Harness {
        engine: Engine::new(),
        next: 0,
    };
    let mut doc = document("p");
    doc.images = (0..300)
        .map(|page| {
            let mut i = image(&format!("page-{page}"));
            i.markers = (0..50).map(|m| marker(&format!("p{page}-m{m}"))).collect();
            i
        })
        .collect();
    h.call(Command::CreateProject {
        document: doc,
        saved: true,
    });
    for n in 0..30 {
        let patch = h.call(Command::UpdateMarker {
            image_id: format!("page-{n}"),
            marker_id: format!("p{n}-m0"),
            geometry: None,
            translation: Some(text("中文😀")),
            style: None,
        });
        assert_eq!(patch.upsert_images.len(), 1);
    }
    for _ in 0..30 {
        h.call(Command::Undo);
    }
    assert_eq!(
        h.doc()
            .images
            .iter()
            .flat_map(|i| &i.markers)
            .filter(|m| !m.translation.runs.is_empty())
            .count(),
        0
    );
}

#[test]
fn batch_can_reference_created_entities_and_records_one_atomic_undo() {
    let mut h = Harness::new();
    let before = h.doc();
    let patch = h.call(Command::Batch {
        expected_state_id: Some("p:0".into()),
        commands: vec![
            Command::AddImages {
                images: vec![image("plugin-page")],
            },
            Command::AddMarker {
                image_id: "plugin-page".into(),
                marker: marker("plugin-marker"),
            },
            Command::UpdateMarker {
                image_id: "plugin-page".into(),
                marker_id: "plugin-marker".into(),
                geometry: None,
                translation: Some(text("transaction")),
                style: None,
            },
        ],
    });
    assert_eq!(patch.history_depth, 1);
    assert_eq!(patch.history_revision, 1);
    assert_eq!(patch.state_id, "p:1");
    let after = h.doc();
    assert_eq!(after.images[2].markers[0].translation, text("transaction"));
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
    h.call(Command::Redo);
    assert_eq!(h.doc(), after);
}

#[test]
fn batches_roll_back_intermediate_failures_and_reject_control_commands() {
    let mut h = Harness::new();
    h.call(Command::UpdateProject {
        name: Some("branch".into()),
        source_language: None,
        target_language: None,
    });
    h.call(Command::Undo);
    let before = h.doc();
    let history = h.engine.history("p", HistoryQuery::default()).unwrap();
    for command in [
        Command::RemoveImage {
            image_id: "missing".into(),
        },
        Command::Undo,
        Command::Redo,
        Command::EndGroup,
        Command::CloseProject,
        Command::MarkSaved {
            state_id: "p:0".into(),
        },
        Command::CreateProject {
            document: document("other"),
            saved: false,
        },
        Command::Batch {
            commands: vec![],
            expected_state_id: None,
        },
    ] {
        let expected = if matches!(command, Command::RemoveImage { .. }) {
            "imageNotFound"
        } else {
            "invalidBatchCommand"
        };
        h.fail(
            Command::Batch {
                expected_state_id: Some("p:0".into()),
                commands: vec![
                    Command::AddImages {
                        images: vec![image("transient")],
                    },
                    command,
                ],
            },
            expected,
        );
        assert_eq!(h.doc(), before);
        assert_eq!(
            h.engine.history("p", HistoryQuery::default()).unwrap(),
            history
        );
    }
    let patch = h.call(Command::Batch {
        commands: vec![],
        expected_state_id: Some("p:0".into()),
    });
    assert_eq!(patch.history_revision, history.history_revision);
    assert!(patch.can_redo);
    h.fail(
        Command::Batch {
            commands: vec![],
            expected_state_id: Some("stale".into()),
        },
        "stateConflict",
    );
    let patch = h.call(Command::UpdateProject {
        name: Some("next".into()),
        source_language: None,
        target_language: None,
    });
    assert_eq!(patch.state_id, "p:2");
}

#[test]
fn image_replacement_history_retains_asset_metadata_and_normalized_markers() {
    let mut h = Harness::new();
    h.call(Command::AddMarker {
        image_id: "page1".into(),
        marker: marker("m1"),
    });
    let before = h.doc();
    let original_marker = before.images[0].markers[0].clone();
    h.call(Command::UpdateImage {
        image_id: "page1".into(),
        filename: Some("replacement.png".into()),
        asset_id: Some("new-asset".into()),
        width: Some(20),
        height: Some(30),
        checksum: Some("new-checksum".into()),
    });
    let replaced = h.doc();
    assert_eq!(replaced.images[0].markers[0], original_marker);
    assert_eq!(replaced.images[0].asset_id, "new-asset");
    assert_eq!(replaced.images[0].width, 20);
    h.call(Command::RemoveImage {
        image_id: "page1".into(),
    });
    h.call(Command::Undo);
    assert_eq!(h.doc(), replaced);
    h.call(Command::Undo);
    assert_eq!(h.doc(), before);
    h.call(Command::Redo);
    assert_eq!(h.doc(), replaced);
}

#[test]
fn history_identity_survives_merge_and_moves_with_guards_and_pagination() {
    let mut h = Harness::new();
    let metadata = Some(HistoryMeta {
        group_id: Some("input".into()),
        label: "plugin input".into(),
        before: None,
        after: None,
        origin: Some(MutationOrigin {
            kind: "plugin".into(),
            plugin_id: Some("example.test".into()),
            label: None,
            causation_id: None,
        }),
    });
    h.group(
        Command::UpdateProject {
            name: Some("one".into()),
            source_language: None,
            target_language: None,
        },
        metadata.clone(),
    );
    let first = h.engine.history("p", HistoryQuery::default()).unwrap();
    h.group(
        Command::UpdateProject {
            name: Some("two".into()),
            source_language: None,
            target_language: None,
        },
        metadata,
    );
    let merged = h.engine.history("p", HistoryQuery::default()).unwrap();
    assert_eq!(merged.undo.len(), 1);
    assert_eq!(merged.undo[0].entry_id, first.undo[0].entry_id);
    assert_ne!(merged.undo[0].after_state_id, first.undo[0].after_state_id);
    assert_eq!(merged.history_revision, first.history_revision + 1);
    h.fail(
        Command::GuardedUndo {
            expected_entry_id: Some(first.undo[0].entry_id.clone()),
            expected_history_revision: Some(first.history_revision),
        },
        "historyConflict",
    );
    assert_eq!(h.doc().name, "two");
    h.call(Command::GuardedUndo {
        expected_entry_id: Some(merged.undo[0].entry_id.clone()),
        expected_history_revision: Some(merged.history_revision),
    });
    let undone = h.engine.history("p", HistoryQuery::default()).unwrap();
    assert_eq!(undone.redo[0], merged.undo[0]);
    h.fail(
        Command::GuardedRedo {
            expected_entry_id: Some("other-entry".into()),
            expected_history_revision: None,
        },
        "historyConflict",
    );
    h.call(Command::GuardedRedo {
        expected_entry_id: Some(undone.redo[0].entry_id.clone()),
        expected_history_revision: Some(undone.history_revision),
    });
    h.call(Command::UpdateProject {
        name: Some("three".into()),
        source_language: None,
        target_language: None,
    });
    let top = h
        .engine
        .history(
            "p",
            HistoryQuery {
                offset: Some(0),
                limit: Some(1),
            },
        )
        .unwrap();
    let next = h
        .engine
        .history(
            "p",
            HistoryQuery {
                offset: Some(1),
                limit: Some(1),
            },
        )
        .unwrap();
    assert_eq!(top.undo_total, 2);
    assert_eq!(top.undo.len(), 1);
    assert_eq!(next.undo[0], merged.undo[0]);
    assert_ne!(top.undo[0].entry_id, next.undo[0].entry_id);
    h.call(Command::Undo);
    h.call(Command::UpdateProject {
        name: Some("new branch".into()),
        source_language: None,
        target_language: None,
    });
    let branch = h.engine.history("p", HistoryQuery::default()).unwrap();
    assert!(branch.redo.is_empty());
    assert_ne!(branch.undo[0].entry_id, top.undo[0].entry_id);
}

#[test]
fn preview_and_envelope_guards_do_not_change_history_or_consume_state() {
    let mut h = Harness::new();
    let command = Command::UpdateProject {
        name: Some("preview".into()),
        source_language: None,
        target_language: None,
    };
    let preview = h
        .engine
        .preview("p", vec![command.clone()], Some("p:0".into()))
        .unwrap();
    assert_eq!(preview.name, "preview");
    assert_ne!(h.doc(), preview);
    assert_eq!(
        h.engine
            .history("p", HistoryQuery::default())
            .unwrap()
            .history_revision,
        0
    );
    assert_eq!(
        h.engine
            .preview("p", vec![command.clone()], Some("stale".into()))
            .unwrap_err()
            .code,
        "stateConflict"
    );
    assert_eq!(
        h.engine.preview("missing", vec![], None).unwrap_err().code,
        "projectNotFound"
    );
    let mut envelope = h.envelope(command.clone(), None);
    envelope.expected_state_id = Some("stale".into());
    assert_eq!(
        h.engine.dispatch(envelope).error.unwrap().code,
        "stateConflict"
    );
    assert_eq!(h.call(command).state_id, "p:1");
}
