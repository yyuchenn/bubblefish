use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};

use bubblefish_core::{CoreError, Geometry, ImageDocument, Marker, MarkerStyle, ProjectDocument};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{invalid, marker_id, page_id, richtext, ImportResult, MAX_IMPORT_BYTES};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    format_version: String,
    project_name: String,
    #[serde(default)]
    source_language: Option<String>,
    #[serde(default)]
    target_language: Option<String>,
    #[serde(default)]
    export_date: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Style {
    id: String,
    overlay_text: bool,
    horizontal: bool,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Deserialize)]
struct Image {
    filename: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WireMarker {
    Point {
        position: [f64; 2],
        style: String,
        text: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Rectangle {
        position: [f64; 2],
        size: [f64; 2],
        style: String,
        text: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

fn json_file<T: serde::de::DeserializeOwned>(
    files: &BTreeMap<String, Vec<u8>>,
    filename: &str,
) -> Result<T, CoreError> {
    let bytes = files
        .get(filename)
        .ok_or_else(|| invalid(format!("Missing {filename}")).at(filename))?;
    serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("Invalid JSON: {error}")).at(filename))
}

fn record_extra(extra: &Map<String, Value>, path: &str, warnings: &mut Vec<String>) {
    if !extra.is_empty() {
        warnings.push(format!(
            "Unknown extension fields in {path}: {}. Save as a new file to preserve the source.",
            extra.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
}

pub(crate) fn import(bytes: &[u8], project_id: String) -> Result<ImportResult, CoreError> {
    let mut expanded = Vec::new();
    GzDecoder::new(bytes)
        .take(MAX_IMPORT_BYTES as u64 + 1)
        .read_to_end(&mut expanded)
        .map_err(|error| invalid(format!("Cannot decompress BF archive: {error}")))?;
    if expanded.len() > MAX_IMPORT_BYTES {
        return Err(invalid("BF archive expands beyond 64 MiB"));
    }
    let mut files = BTreeMap::new();
    let mut archive = tar::Archive::new(expanded.as_slice());
    for entry in archive
        .entries()
        .map_err(|error| invalid(format!("Invalid tar archive: {error}")))?
    {
        let mut entry = entry.map_err(|error| invalid(format!("Invalid tar entry: {error}")))?;
        if !entry.header().entry_type().is_file() {
            return Err(invalid("BF archive must contain regular JSON files only"));
        }
        let path = entry
            .path()
            .map_err(|error| invalid(format!("Invalid tar path: {error}")))?;
        let name = path
            .to_str()
            .ok_or_else(|| invalid("BF entry path is not UTF-8"))?
            .to_owned();
        if name.is_empty()
            || name.contains(['\\', ':'])
            || name.starts_with('/')
            || name
                .split('/')
                .any(|part| part == ".." || part == "." || part.is_empty())
        {
            return Err(invalid("Unsafe archive entry path").at(name));
        }
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|error| invalid(format!("Unreadable archive entry: {error}")))?;
        if files.insert(name.clone(), content).is_some() {
            return Err(invalid("Duplicate archive entry").at(name));
        }
    }

    let metadata: Metadata = json_file(&files, "metadata.json")?;
    if metadata.format_version != "1.0" {
        return Err(invalid(format!(
            "Unsupported BF version {}",
            metadata.format_version
        ))
        .at("metadata.json"));
    }
    let styles: Vec<Style> = json_file(&files, "styles.json")?;
    let images: Vec<Image> = json_file(&files, "images.json")?;
    let markers: Vec<Vec<WireMarker>> = json_file(&files, "markers.json")?;
    if images.len() != markers.len() {
        return Err(invalid(
            "images.json and markers.json have different page counts",
        ));
    }
    let mut warnings = Vec::new();
    let known = [
        "metadata.json",
        "styles.json",
        "images.json",
        "markers.json",
        "bunny_cache.json",
    ];
    for name in files.keys().filter(|name| !known.contains(&name.as_str())) {
        warnings.push(format!("Unknown BF extension {name}; it will be omitted from a new export. Keep the source file."));
    }
    record_extra(&metadata.extra, "metadata.json", &mut warnings);
    // Reading this field validates its type; the timestamp is deliberately not document state.
    let _ = metadata.export_date;
    let mut style_map = BTreeMap::new();
    for style in styles {
        record_extra(&style.extra, "styles.json", &mut warnings);
        if style_map
            .insert(
                style.id.clone(),
                MarkerStyle {
                    overlay_text: style.overlay_text,
                    horizontal: style.horizontal,
                },
            )
            .is_some()
        {
            return Err(invalid(format!("Duplicate style ID {}", style.id)).at("styles.json"));
        }
    }
    let force_save_as = !warnings.is_empty();
    let mut document = ProjectDocument {
        id: project_id.clone(),
        name: metadata.project_name,
        source_language: metadata
            .source_language
            .unwrap_or_else(|| "japanese".into()),
        target_language: metadata
            .target_language
            .unwrap_or_else(|| "simplifiedChinese".into()),
        images: Vec::new(),
    };
    let mut extra_marker_or_image = false;
    for (page, (image, page_markers)) in images.into_iter().zip(markers).enumerate() {
        extra_marker_or_image |= !image.extra.is_empty();
        record_extra(&image.extra, &format!("images.json[{page}]"), &mut warnings);
        let id = page_id(&project_id, page);
        let mut result = ImageDocument {
            id: id.clone(),
            asset_id: id,
            filename: image.filename,
            width: 0,
            height: 0,
            checksum: image.checksum,
            markers: Vec::new(),
        };
        for (index, marker) in page_markers.into_iter().enumerate() {
            let (geometry, style, text, extra) = match marker {
                WireMarker::Point {
                    position,
                    style,
                    text,
                    extra,
                } => (
                    Geometry::Point {
                        x: position[0] / 100.0,
                        y: position[1] / 100.0,
                    },
                    style,
                    text,
                    extra,
                ),
                WireMarker::Rectangle {
                    position,
                    size,
                    style,
                    text,
                    extra,
                } => (
                    Geometry::Rectangle {
                        x: position[0] / 100.0,
                        y: position[1] / 100.0,
                        width: size[0] / 100.0,
                        height: size[1] / 100.0,
                    },
                    style,
                    text,
                    extra,
                ),
            };
            extra_marker_or_image |= !extra.is_empty();
            record_extra(
                &extra,
                &format!("markers.json[{page}][{index}]"),
                &mut warnings,
            );
            let translation = richtext::parse_legacy_text(&text);
            if translation.raw.is_some() {
                warnings.push(format!("Page {}, marker {} contains ambiguous rich text; original text is preserved until edited.", page + 1, index + 1));
            }
            result.markers.push(Marker {
                id: marker_id(&project_id, page, index),
                geometry,
                translation,
                style: style_map.get(&style).cloned().ok_or_else(|| {
                    invalid(format!("Undefined style ID {style}"))
                        .at(format!("markers.json[{page}][{index}]"))
                })?,
                bunny_cache: None,
            });
        }
        document.images.push(result);
    }
    if files.contains_key("bunny_cache.json") {
        let cache: Vec<Value> = json_file(&files, "bunny_cache.json")?;
        let mut seen = HashSet::new();
        for (index, value) in cache.into_iter().enumerate() {
            let path = format!("bunny_cache.json[{index}]");
            let mut payload = value
                .as_object()
                .cloned()
                .ok_or_else(|| invalid("Bunny cache entry must be an object").at(&path))?;
            for field in [
                "originalText",
                "machineTranslation",
                "lastOcrModel",
                "lastTranslationService",
            ] {
                if let Some(value) = payload.get(field) {
                    if !value.is_string() && !value.is_null() {
                        return Err(invalid(format!(
                            "Bunny cache {field} must be a string or null"
                        ))
                        .at(&path));
                    }
                }
            }
            let page = payload
                .remove("pageIndex")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| invalid("Invalid bunny cache pageIndex").at(&path))?;
            let marker = payload
                .remove("markerIndex")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| invalid("Invalid bunny cache markerIndex").at(&path))?;
            if !seen.insert((page, marker)) {
                return Err(invalid("Duplicate bunny cache reference").at(path));
            }
            let target = document
                .images
                .get_mut(page)
                .and_then(|image| image.markers.get_mut(marker))
                .ok_or_else(|| invalid("Bunny cache refers to a missing marker").at(path))?;
            target.bunny_cache = Some(Value::Object(payload));
        }
    }
    Ok(ImportResult {
        document,
        warnings,
        force_save_as: force_save_as || extra_marker_or_image,
    })
}

fn append_file<W: Write>(
    archive: &mut tar::Builder<W>,
    name: &str,
    content: &Value,
) -> Result<(), CoreError> {
    let content = serde_json::to_vec_pretty(content).map_err(|error| invalid(error.to_string()))?;
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    archive
        .append_data(&mut header, name, content.as_slice())
        .map_err(|error| invalid(format!("Cannot build BF archive: {error}")))
}

pub(crate) fn export(document: &ProjectDocument) -> Result<Vec<u8>, CoreError> {
    let mut styles: Vec<Value> = Vec::new();
    let mut style_ids = BTreeMap::new();
    let mut images = Vec::new();
    let mut pages = Vec::new();
    let mut cache = Vec::new();
    for (page, image) in document.images.iter().enumerate() {
        let mut wire_image = json!({ "filename": image.filename });
        if let Some(checksum) = &image.checksum {
            wire_image["checksum"] = json!(checksum);
        }
        images.push(wire_image);
        let mut markers = Vec::new();
        for (index, marker) in image.markers.iter().enumerate() {
            let key = (marker.style.overlay_text, marker.style.horizontal);
            let id = style_ids.entry(key).or_insert_with(|| {
                let id = styles.len().to_string();
                styles.push(json!({ "id": id, "overlayText": key.0, "horizontal": key.1 }));
                id
            });
            let text = richtext::export_legacy_text(&marker.translation).map_err(|error| {
                error.at(format!("images[{page}].markers[{index}].translation"))
            })?;
            let wire = match marker.geometry {
                Geometry::Point { x, y } => {
                    json!({ "type": "point", "position": [x * 100.0, y * 100.0], "style": id, "text": text })
                }
                Geometry::Rectangle {
                    x,
                    y,
                    width,
                    height,
                } => {
                    json!({ "type": "rectangle", "position": [x * 100.0, y * 100.0], "size": [width * 100.0, height * 100.0], "style": id, "text": text })
                }
            };
            markers.push(wire);
            if let Some(payload) = &marker.bunny_cache {
                let mut payload = payload.as_object().cloned().ok_or_else(|| {
                    invalid("Bunny cache must be an object")
                        .at(format!("images[{page}].markers[{index}].bunnyCache"))
                })?;
                payload.insert("pageIndex".into(), json!(page));
                payload.insert("markerIndex".into(), json!(index));
                cache.push(Value::Object(payload));
            }
        }
        pages.push(markers);
    }
    if styles.is_empty() {
        styles.push(json!({ "id": "0", "overlayText": false, "horizontal": false }));
    }
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut archive = tar::Builder::new(encoder);
    // A deterministic timestamp keeps exports reproducible on native and WASM.
    append_file(
        &mut archive,
        "metadata.json",
        &json!({ "formatVersion": "1.0", "exportDate": "1970-01-01T00:00:00Z", "projectName": document.name, "sourceLanguage": document.source_language, "targetLanguage": document.target_language }),
    )?;
    append_file(&mut archive, "styles.json", &json!(styles))?;
    append_file(&mut archive, "images.json", &json!(images))?;
    append_file(&mut archive, "markers.json", &json!(pages))?;
    append_file(&mut archive, "bunny_cache.json", &json!(cache))?;
    archive
        .into_inner()
        .and_then(GzEncoder::finish)
        .map_err(|error| invalid(format!("Cannot finish BF archive: {error}")))
}
