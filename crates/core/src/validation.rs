use crate::{CoreError, Geometry, ImageDocument, ProjectDocument};
use std::collections::HashSet;

pub fn validate_document(document: &ProjectDocument) -> Result<(), CoreError> {
    nonempty(&document.id, "id")?;
    validate_parts(
        &document.name,
        &document.source_language,
        &document.target_language,
        document.images.iter(),
    )
}

pub(crate) fn validate_parts<'a>(
    name: &str,
    source: &str,
    target: &str,
    images: impl Iterator<Item = &'a ImageDocument>,
) -> Result<(), CoreError> {
    nonempty(name, "name")?;
    nonempty(source, "sourceLanguage")?;
    nonempty(target, "targetLanguage")?;
    let mut ids = HashSet::new();
    for image in images {
        nonempty(&image.id, "images.id")?;
        nonempty(&image.asset_id, "images.assetId")?;
        nonempty(&image.filename, "images.filename")?;
        if !ids.insert(image.id.as_str()) {
            return Err(CoreError::new(
                "duplicateId",
                "Image and marker IDs must be unique within a project",
            )
            .at(&image.id));
        }
        for marker in &image.markers {
            nonempty(&marker.id, "markers.id")?;
            if !ids.insert(marker.id.as_str()) {
                return Err(CoreError::new(
                    "duplicateId",
                    "Image and marker IDs must be unique within a project",
                )
                .at(&marker.id));
            }
            let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
            let valid = match marker.geometry {
                Geometry::Point { x, y } => unit(x) && unit(y),
                Geometry::Rectangle {
                    x,
                    y,
                    width,
                    height,
                } => {
                    unit(x)
                        && unit(y)
                        && unit(width)
                        && unit(height)
                        && x + width <= 1.0 + 1e-10
                        && y + height <= 1.0 + 1e-10
                }
            };
            if !valid {
                return Err(CoreError::new(
                    "invalidGeometry",
                    "Marker coordinates must be finite and inside the image",
                )
                .at(&marker.id));
            }
            for run in &marker.translation.runs {
                let unique: HashSet<_> = run.marks.iter().collect();
                if unique.len() != run.marks.len() {
                    return Err(
                        CoreError::new("invalidMarks", "Text marks may not repeat").at(&marker.id)
                    );
                }
            }
        }
    }
    Ok(())
}

fn nonempty(value: &str, path: &str) -> Result<(), CoreError> {
    if value.trim().is_empty() {
        Err(CoreError::new("required", "Value must not be empty").at(path))
    } else {
        Ok(())
    }
}
