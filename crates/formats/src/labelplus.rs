use std::collections::HashSet;

use bubblefish_core::{CoreError, Geometry, ImageDocument, Marker, MarkerStyle, ProjectDocument};

use crate::{invalid, marker_id, page_id, richtext, ImportResult};

const IMAGE_START: &str = ">>>>>>>>[";
const IMAGE_END: &str = "]<<<<<<<<";
const MARKER_START: &str = "----------------[";
const MARKER_MIDDLE: &str = "]----------------[";
const STYLE_NAMES: [&str; 4] = [
    "inside+vertical",
    "overlay+vertical",
    "inside+horizontal",
    "overlay+horizontal",
];

fn style(name: &str) -> Option<MarkerStyle> {
    match name {
        "inside+vertical" | "框内" | "fallback" => Some(MarkerStyle {
            overlay_text: false,
            horizontal: false,
        }),
        "overlay+vertical" | "框外" => Some(MarkerStyle {
            overlay_text: true,
            horizontal: false,
        }),
        "inside+horizontal" => Some(MarkerStyle {
            overlay_text: false,
            horizontal: true,
        }),
        "overlay+horizontal" => Some(MarkerStyle {
            overlay_text: true,
            horizontal: true,
        }),
        _ => None,
    }
}

fn language(source: &str) -> String {
    match source.trim() {
        "Japanese" => "japanese",
        "English" => "english",
        "SimplifiedChinese" => "simplifiedChinese",
        "TraditionalChinese" => "traditionalChinese",
        other => other,
    }
    .into()
}

fn marker_header(line: &str) -> Result<(u64, f64, f64, usize), CoreError> {
    let body = line
        .strip_prefix(MARKER_START)
        .and_then(|line| line.strip_suffix(']'))
        .ok_or_else(|| invalid("Malformed LabelPlus marker header"))?;
    let (index, coordinates) = body
        .split_once(MARKER_MIDDLE)
        .ok_or_else(|| invalid("Malformed LabelPlus marker separator"))?;
    let index = index
        .parse::<u64>()
        .ok()
        .filter(|index| *index > 0)
        .ok_or_else(|| invalid("LabelPlus marker index must be a positive integer"))?;
    let coordinates: Vec<&str> = coordinates.split(',').map(str::trim).collect();
    if coordinates.len() != 3 {
        return Err(invalid("LabelPlus coordinates must contain x,y,type"));
    }
    let x = coordinates[0]
        .parse::<f64>()
        .map_err(|_| invalid("Invalid LabelPlus x coordinate"))?;
    let y = coordinates[1]
        .parse::<f64>()
        .map_err(|_| invalid("Invalid LabelPlus y coordinate"))?;
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err(invalid(
            "LabelPlus coordinates must be finite and between 0 and 1",
        ));
    }
    let kind = coordinates[2]
        .parse::<usize>()
        .map_err(|_| invalid("Invalid LabelPlus type ID"))?;
    Ok((index, x, y, kind))
}

pub(crate) fn import(bytes: &[u8], project_id: String) -> Result<ImportResult, CoreError> {
    let content = std::str::from_utf8(bytes)
        .map_err(|_| invalid("LabelPlus must be UTF-8"))?
        .trim_start_matches('\u{feff}');
    let content = content.replace("\r\n", "\n");
    if content.contains('\r') {
        return Err(invalid(
            "LabelPlus contains an unsupported standalone carriage return",
        ));
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.first().map(|line| line.trim()) != Some("1,0") {
        return Err(invalid("LabelPlus magic header must be 1,0"));
    }
    if lines.get(1).map(|line| line.trim()) != Some("-") {
        return Err(invalid("Missing LabelPlus type separator"));
    }
    let type_end = (2..lines.len())
        .find(|index| lines[*index].trim() == "-")
        .ok_or_else(|| invalid("Missing LabelPlus closing type separator"))?;
    let names = &lines[2..type_end];
    if names.is_empty() || names.len() > 9 || names.iter().any(|name| name.trim().is_empty()) {
        return Err(invalid(
            "LabelPlus must declare between 1 and 9 nonempty types",
        ));
    }
    let mut warnings = Vec::new();
    let styles: Vec<MarkerStyle> = names
        .iter()
        .map(|name| {
            style(name).unwrap_or_else(|| {
                warnings.push(format!(
                    "Unknown LabelPlus type '{name}' uses the default inside/vertical style."
                ));
                MarkerStyle::default()
            })
        })
        .collect();
    let force_save_as = !warnings.is_empty();
    let mut document = ProjectDocument {
        id: project_id.clone(),
        name: "Imported LabelPlus".into(),
        source_language: "japanese".into(),
        target_language: "simplifiedChinese".into(),
        images: Vec::new(),
    };
    let mut index = type_end + 1;
    let mut filenames = HashSet::new();
    let mut marker_indices = HashSet::new();
    while index < lines.len() {
        let line = lines[index];
        if line.starts_with(">>>>>>>>") {
            let filename = line
                .strip_prefix(IMAGE_START)
                .and_then(|line| line.strip_suffix(IMAGE_END))
                .ok_or_else(|| {
                    invalid("Malformed LabelPlus image separator").at(format!("line {}", index + 1))
                })?;
            if filename.is_empty() {
                return Err(
                    invalid("Invalid LabelPlus image filename").at(format!("line {}", index + 1))
                );
            }
            if !filenames.insert(filename.to_owned()) {
                return Err(invalid(format!(
                    "Duplicate LabelPlus image filename '{filename}'"
                )));
            }
            let id = page_id(&project_id, document.images.len());
            document.images.push(ImageDocument {
                id: id.clone(),
                asset_id: id,
                filename: filename.into(),
                width: 0,
                height: 0,
                checksum: None,
                markers: Vec::new(),
            });
            marker_indices.clear();
            index += 1;
        } else if line.starts_with(MARKER_START) {
            let (number, x, y, kind) =
                marker_header(line).map_err(|error| error.at(format!("line {}", index + 1)))?;
            if !marker_indices.insert(number) {
                return Err(invalid(format!(
                    "Duplicate LabelPlus marker number {number}"
                )));
            }
            if kind == 0 || kind > styles.len() {
                return Err(invalid(format!("Undefined LabelPlus type ID {kind}")));
            }
            let page = document
                .images
                .len()
                .checked_sub(1)
                .ok_or_else(|| invalid("LabelPlus marker appears before its image"))?;
            let image = document.images.last_mut().unwrap();
            let next = index + 1;
            index = next;
            while index < lines.len()
                && !lines[index].starts_with(MARKER_START)
                && !lines[index].starts_with(">>>>>>>>")
            {
                index += 1;
            }
            let translation = richtext::parse_legacy_text(&lines[next..index].join("\n"));
            if translation.raw.is_some() {
                warnings.push(format!("Page {}, marker {} contains ambiguous rich text; original text is preserved until edited.", page + 1, image.markers.len() + 1));
            }
            if number != image.markers.len() as u64 + 1 {
                warnings.push(format!(
                    "Page {} marker numbers were normalized to their file order.",
                    page + 1
                ));
            }
            image.markers.push(Marker {
                id: marker_id(&project_id, page, image.markers.len()),
                geometry: Geometry::Point { x, y },
                translation,
                style: styles[kind - 1].clone(),
                bunny_cache: None,
            });
        } else {
            // The header comment is optional. Only read language metadata before page data.
            if document.images.is_empty() {
                if let Some((_, languages)) = line.split_once(" | Source: ") {
                    if let Some((source, target)) = languages.split_once(" | Target: ") {
                        document.source_language = language(source);
                        document.target_language = language(target);
                    }
                }
            } else if !line.is_empty() {
                return Err(invalid("Unexpected text outside a LabelPlus marker")
                    .at(format!("line {}", index + 1)));
            }
            index += 1;
        }
    }
    Ok(ImportResult {
        document,
        warnings,
        force_save_as,
    })
}

pub(crate) fn export(document: &ProjectDocument) -> Result<Vec<u8>, CoreError> {
    if document.source_language.contains(['\r', '\n', '|'])
        || document.target_language.contains(['\r', '\n', '|'])
    {
        return Err(crate::cannot_export(
            "LabelPlus language metadata contains a comment separator or newline",
        ));
    }
    let mut result = format!(
        "1,0\r\n-\r\n{}\r\n-\r\nExported from Bubblefish | Source: {} | Target: {}\r\n",
        STYLE_NAMES.join("\r\n"),
        document.source_language,
        document.target_language
    );
    let mut filenames = HashSet::new();
    for (page, image) in document.images.iter().enumerate() {
        if image.filename.contains(['\r', '\n']) {
            return Err(crate::cannot_export(
                "LabelPlus filename contains an image separator or newline",
            )
            .at(format!("images[{page}].filename")));
        }
        if !filenames.insert(&image.filename) {
            return Err(crate::cannot_export(
                "LabelPlus cannot safely represent duplicate image filenames",
            )
            .at(format!("images[{page}].filename")));
        }
        result.push_str(&format!("{IMAGE_START}{}{IMAGE_END}\r\n", image.filename));
        for (index, marker) in image.markers.iter().enumerate() {
            let path = format!("images[{page}].markers[{index}].translation");
            let text = richtext::export_legacy_text(&marker.translation)
                .map_err(|error| error.at(&path))?;
            if text.contains('\r')
                || text
                    .split('\n')
                    .any(|line| line.starts_with(MARKER_START) || line.starts_with(">>>>>>>>"))
            {
                return Err(crate::cannot_export(
                    "Translation contains a reserved LabelPlus separator or carriage return",
                )
                .at(path));
            }
            let (x, y) = match marker.geometry {
                Geometry::Point { x, y } => (x, y),
                Geometry::Rectangle { x, y, width, .. } => (x + width / 2.0, y),
            };
            let kind = 1
                + usize::from(marker.style.overlay_text)
                + 2 * usize::from(marker.style.horizontal);
            result.push_str(&format!(
                "{MARKER_START}{}{}{:},{:},{}]\r\n",
                index + 1,
                MARKER_MIDDLE,
                x,
                y,
                kind
            ));
            result.push_str(&text.replace('\n', "\r\n"));
            result.push_str("\r\n");
        }
    }
    Ok(result.into_bytes())
}
