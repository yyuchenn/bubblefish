use bubblefish_core::*;

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
