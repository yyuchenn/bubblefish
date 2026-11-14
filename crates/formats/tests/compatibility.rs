use std::io::Write;

use bubblefish_core::{Geometry, RichText, TextMark, TextRun};
use bubblefish_formats::{
    export_project, import_project,
    richtext::{export_legacy_text, parse_legacy_text},
    Format, MAX_IMPORT_BYTES,
};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};

fn fixture_entries() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (
            "metadata.json",
            include_bytes!("fixtures/bf10/metadata.json").to_vec(),
        ),
        (
            "styles.json",
            include_bytes!("fixtures/bf10/styles.json").to_vec(),
        ),
        (
            "images.json",
            include_bytes!("fixtures/bf10/images.json").to_vec(),
        ),
        (
            "markers.json",
            include_bytes!("fixtures/bf10/markers.json").to_vec(),
        ),
        (
            "bunny_cache.json",
            include_bytes!("fixtures/bf10/bunny_cache.json").to_vec(),
        ),
    ]
}

fn archive(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    for (name, content) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, name, content.as_slice())
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn fixture() -> Vec<u8> {
    archive(fixture_entries())
}

fn mutate(filename: &str, update: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut entries = fixture_entries();
    let bytes = &mut entries
        .iter_mut()
        .find(|entry| entry.0 == filename)
        .unwrap()
        .1;
    let mut value = serde_json::from_slice(bytes).unwrap();
    update(&mut value);
    *bytes = serde_json::to_vec(&value).unwrap();
    archive(entries)
}

#[test]
fn hand_written_bf_roundtrips_semantically_and_deterministically() {
    let result = import_project(&fixture(), Format::Bf, "test".into()).unwrap();
    assert!(result.warnings.is_empty());
    assert!(!result.force_save_as);
    assert_eq!(result.document.images.len(), 2);
    assert_eq!(result.document.images[0].width, 0);
    assert_eq!(
        result.document.images[0].markers[0].geometry,
        Geometry::Point { x: 0.125, y: 0.5 }
    );
    assert!(result.document.images[1].markers.is_empty());
    let bytes = export_project(&result.document, Format::Bf).unwrap();
    assert_eq!(bytes, export_project(&result.document, Format::Bf).unwrap());
    assert_eq!(
        result.document,
        import_project(&bytes, Format::Bf, "test".into())
            .unwrap()
            .document
    );
}

#[test]
fn bunny_cache_follows_markers_after_reordering_and_deletion() {
    let mut document = import_project(&fixture(), Format::Bf, "test".into())
        .unwrap()
        .document;
    document.images[0].markers.swap(0, 1);
    let cache = document.images[0].markers[0].bunny_cache.clone();
    document.images[0].markers.remove(1);
    document.images.swap(0, 1);
    let document = import_project(
        &export_project(&document, Format::Bf).unwrap(),
        Format::Bf,
        "test".into(),
    )
    .unwrap()
    .document;
    assert_eq!(document.images[1].markers[0].bunny_cache, cache);
    assert_eq!(cache.unwrap()["customField"], json!({ "preserved": true }));
}

#[test]
fn unknown_extensions_require_save_as_without_corrupting_known_data() {
    let mut entries = fixture_entries();
    entries.push(("future_plugin.json", b"{}".to_vec()));
    let result = import_project(&archive(entries), Format::Bf, "test".into()).unwrap();
    assert!(result.force_save_as);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("future_plugin.json")));
    let bytes = mutate("images.json", |value| value[0]["futureField"] = json!(42));
    assert!(
        import_project(&bytes, Format::Bf, "test".into())
            .unwrap()
            .force_save_as
    );
}

#[test]
fn structural_errors_are_rejected() {
    for bytes in [
        mutate("metadata.json", |value| {
            value["formatVersion"] = json!("2.0")
        }),
        mutate("markers.json", |value| {
            value.as_array_mut().unwrap().pop().map(|_| ()).unwrap()
        }),
        mutate("markers.json", |value| {
            value[0][0]["position"] = json!([101, 0])
        }),
        mutate("markers.json", |value| value[0][1]["size"] = json!([-1, 5])),
        mutate("markers.json", |value| {
            value[0][0]["style"] = json!("missing")
        }),
        mutate("bunny_cache.json", |value| {
            value[0]["markerIndex"] = json!(999)
        }),
        mutate("bunny_cache.json", |value| {
            let first = value[0].clone();
            value.as_array_mut().unwrap().push(first);
        }),
    ] {
        assert!(import_project(&bytes, Format::Bf, "test".into()).is_err());
    }
    let mut entries = fixture_entries();
    entries.push(("metadata.json", b"{}".to_vec()));
    assert!(import_project(&archive(entries), Format::Bf, "test".into()).is_err());
    let mut entries = fixture_entries();
    entries.retain(|entry| entry.0 != "styles.json");
    assert!(import_project(&archive(entries), Format::Bf, "test".into()).is_err());
    assert!(import_project(b"broken", Format::Bf, "test".into()).is_err());
}

#[test]
fn decompression_limit_is_enforced_before_tar_parsing() {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let chunk = vec![0u8; 1024 * 1024];
    for _ in 0..=MAX_IMPORT_BYTES / chunk.len() {
        encoder.write_all(&chunk).unwrap();
    }
    let error = import_project(&encoder.finish().unwrap(), Format::Bf, "test".into()).unwrap_err();
    assert!(error.message.contains("64 MiB"));
}

#[test]
fn labelplus_accepts_bom_lf_crlf_and_legacy_style_names() {
    let source = include_str!("fixtures/legacy.lp");
    let result = import_project(source.as_bytes(), Format::Labelplus, "test".into()).unwrap();
    let crlf = format!("\u{feff}{}", source.replace('\n', "\r\n"));
    assert_eq!(
        result.document,
        import_project(crlf.as_bytes(), Format::Labelplus, "test".into())
            .unwrap()
            .document
    );
    assert_eq!(result.document.images.len(), 2);
    assert_eq!(result.document.source_language, "japanese");
    assert!(result.document.images[0].markers[1].style.overlay_text);
    assert!(result.document.images[0].markers[1].style.horizontal);
    let bytes = export_project(&result.document, Format::Labelplus).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(text.contains("\r\n"));
    assert!(!text.replace("\r\n", "").contains('\n'));
    assert!(text.ends_with(">>>>>>>>[空页.webp]<<<<<<<<\r\n"));
    assert_eq!(
        result.document,
        import_project(&bytes, Format::Labelplus, "test".into())
            .unwrap()
            .document
    );
}

#[test]
fn labelplus_rectangle_is_reduced_to_upper_edge_midpoint() {
    let document = import_project(&fixture(), Format::Bf, "test".into())
        .unwrap()
        .document;
    let imported = import_project(
        &export_project(&document, Format::Labelplus).unwrap(),
        Format::Labelplus,
        "test".into(),
    )
    .unwrap();
    assert_eq!(
        imported.document.images[0].markers[1].geometry,
        Geometry::Point { x: 0.5, y: 0.25 }
    );
}

#[test]
fn multiline_translation_preserves_blank_lines_and_empty_text() {
    let mut document = import_project(
        include_bytes!("fixtures/legacy.lp"),
        Format::Labelplus,
        "test".into(),
    )
    .unwrap()
    .document;
    for source in ["", "\n", "a\n\n", "\n前\n\n后\n", "emoji 👩‍💻 é"] {
        document.images[0].markers[0].translation = parse_legacy_text(source);
        let bytes = export_project(&document, Format::Labelplus).unwrap();
        let imported = import_project(&bytes, Format::Labelplus, "test".into()).unwrap();
        assert_eq!(
            imported.document.images[0].markers[0].translation,
            document.images[0].markers[0].translation
        );
    }
}

#[test]
fn labelplus_rejects_invalid_headers_coordinates_and_separator_collisions() {
    for source in [
        "",
        "1,1\n-\na\n-\n",
        "1,0\n-\n-\n",
        "1,0\n-\na\n-\n>>>>>>>>[x]<<<<<<<<\n----------------[1]----------------[NaN,0,1]\ntext",
        "1,0\n-\na\n-\n----------------[1]----------------[0,0,1]\ntext",
    ] {
        assert!(import_project(source.as_bytes(), Format::Labelplus, "test".into()).is_err());
    }
    let mut document = import_project(
        include_bytes!("fixtures/legacy.lp"),
        Format::Labelplus,
        "test".into(),
    )
    .unwrap()
    .document;
    for source in [
        "----------------[1]----------------[0,0,1]",
        ">>>>>>>>[other]<<<<<<<<",
        "text\n>>>>>>>>tricky",
        "text\rbreak",
    ] {
        document.images[0].markers[0].translation = RichText {
            runs: vec![TextRun {
                text: source.into(),
                marks: vec![],
            }],
            raw: None,
        };
        assert!(export_project(&document, Format::Labelplus).is_err());
    }
}

#[test]
fn rich_text_roundtrips_four_marks_and_unicode() {
    let source = "前[多行\n😀](\\重点\\加粗\\斜体\\划掉)后";
    let parsed = parse_legacy_text(source);
    assert!(parsed.raw.is_none());
    assert_eq!(
        parsed.runs[1].marks,
        vec![
            TextMark::Bold,
            TextMark::Italic,
            TextMark::Strike,
            TextMark::Emphasis
        ]
    );
    assert_eq!(
        parse_legacy_text(&export_legacy_text(&parsed).unwrap()),
        parsed
    );
}

#[test]
fn ambiguous_rich_text_is_preserved_exactly_until_edited() {
    for source in [
        "[unknown](\\future)",
        "[mixed](\\加粗\\future)",
        "[bad](\\加粗",
        "[](\\加粗)",
    ] {
        let mut parsed = parse_legacy_text(source);
        assert_eq!(parsed.raw.as_deref(), Some(source));
        assert_eq!(export_legacy_text(&parsed).unwrap(), source);
        parsed.runs[0].text = "edited".into();
        assert_eq!(export_legacy_text(&parsed).unwrap(), "edited");
    }
}

#[test]
fn unsafe_rich_text_reports_loss_instead_of_silently_changing_meaning() {
    for text in [
        RichText {
            runs: vec![TextRun {
                text: "a]b".into(),
                marks: vec![TextMark::Bold],
            }],
            raw: None,
        },
        RichText {
            runs: vec![TextRun {
                text: "[literal](\\加粗)".into(),
                marks: vec![],
            }],
            raw: None,
        },
        RichText {
            runs: vec![
                TextRun {
                    text: "[literal]".into(),
                    marks: vec![],
                },
                TextRun {
                    text: "(\\future)".into(),
                    marks: vec![],
                },
            ],
            raw: None,
        },
    ] {
        assert!(export_legacy_text(&text).is_err());
    }
}

#[test]
fn bracketed_image_names_are_compatible_with_labelplus() {
    let mut document = import_project(
        include_bytes!("fixtures/legacy.lp"),
        Format::Labelplus,
        "test".into(),
    )
    .unwrap()
    .document;
    document.images[0].filename = "[作品][第01話] 001.png".into();
    let imported = import_project(
        &export_project(&document, Format::Labelplus).unwrap(),
        Format::Labelplus,
        "test".into(),
    )
    .unwrap();
    assert_eq!(
        imported.document.images[0].filename,
        document.images[0].filename
    );
}

#[test]
fn unsafe_tar_paths_and_nonregular_entries_are_rejected_without_extraction() {
    for (path, kind) in [
        ("../escape.json", tar::EntryType::Regular),
        ("/absolute.json", tar::EntryType::Regular),
        ("C:/drive.json", tar::EntryType::Regular),
        ("link.json", tar::EntryType::Symlink),
    ] {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(0);
        header.set_mode(0o644);
        let bytes = header.as_mut_bytes();
        bytes[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        builder.append(&header, &[][..]).unwrap();
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        let error = import_project(&bytes, Format::Bf, "test".into()).unwrap_err();
        assert!(
            error.message.contains("Unsafe") || error.message.contains("regular"),
            "{path}: {}",
            error.message
        );
    }
}

#[test]
fn large_project_roundtrips_fifteen_thousand_markers() {
    let mut document = import_project(&fixture(), Format::Bf, "scale".into())
        .unwrap()
        .document;
    let template = document.images[0].clone();
    document.images = (0..300)
        .map(|page| {
            let mut image = template.clone();
            image.id = format!("scale:image:{page}");
            image.asset_id = image.id.clone();
            image.filename = format!("{page:03}.png");
            image.markers = (0..50)
                .map(|marker| {
                    let mut item = template.markers[marker % 2].clone();
                    item.id = format!("scale:image:{page}:marker:{marker}");
                    item.bunny_cache = None;
                    item
                })
                .collect();
            image
        })
        .collect();
    let bytes = export_project(&document, Format::Bf).unwrap();
    let imported = import_project(&bytes, Format::Bf, "scale".into()).unwrap();
    assert_eq!(imported.document, document);
    assert!(imported.warnings.is_empty());
    let lp = export_project(&document, Format::Labelplus).unwrap();
    let imported = import_project(&lp, Format::Labelplus, "scale".into()).unwrap();
    assert_eq!(imported.document.images.len(), 300);
    assert_eq!(
        imported
            .document
            .images
            .iter()
            .map(|image| image.markers.len())
            .sum::<usize>(),
        15_000
    );
    assert!(imported.warnings.is_empty());
}

#[test]
fn lossy_export_errors_identify_the_affected_translation() {
    let mut document = import_project(&fixture(), Format::Bf, "test".into())
        .unwrap()
        .document;
    document.images[0].markers[1].translation = RichText {
        runs: vec![TextRun {
            text: "bad]".into(),
            marks: vec![TextMark::Bold],
        }],
        raw: None,
    };
    for format in [Format::Bf, Format::Labelplus] {
        let error = export_project(&document, format).unwrap_err();
        assert_eq!(error.code, "unrepresentableText");
        assert_eq!(
            error.path.as_deref(),
            Some("images[0].markers[1].translation")
        );
    }
}

#[test]
fn extension_reports_cover_metadata_marker_fields_and_binary_archive_entries() {
    for bytes in [
        mutate("metadata.json", |value| {
            value["pluginState"] = json!({ "future": true })
        }),
        mutate("markers.json", |value| {
            value[0][1]["pluginValue"] = json!([1, 2])
        }),
        {
            let mut entries = fixture_entries();
            entries.push(("extension.bin", vec![0xff, 0xfe]));
            archive(entries)
        },
    ] {
        let result = import_project(&bytes, Format::Bf, "test".into()).unwrap();
        assert!(result.force_save_as);
        assert!(!result.warnings.is_empty());
        assert_eq!(result.document.images[0].markers.len(), 2);
    }
    let invalid = mutate("bunny_cache.json", |value| {
        value[0]["originalText"] = json!({ "wrong": "shape" })
    });
    assert!(import_project(&invalid, Format::Bf, "test".into()).is_err());
}
