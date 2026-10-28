//! Platform-neutral image inspection and a thin, single-threaded WASM host.
use bubblefish_core::protocol::CoreError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProbe {
    pub width: u32,
    pub height: u32,
    pub checksum: String,
    pub format: String,
}

pub fn probe_image(bytes: &[u8]) -> Result<ImageProbe, CoreError> {
    if bytes.len() > 128 * 1024 * 1024 {
        return Err(CoreError::new("image_too_large", "Image exceeds 128 MiB"));
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| CoreError::new("invalid_image", e.to_string()))?;
    let format = reader
        .format()
        .ok_or_else(|| CoreError::new("invalid_image", "Unknown image format"))?;
    let name = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpeg",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Bmp => "bmp",
        _ => {
            return Err(CoreError::new(
                "unsupported_image",
                "Supported formats: PNG, JPEG, GIF, WebP, BMP",
            ))
        }
    };
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| CoreError::new("invalid_image", e.to_string()))?;
    if width == 0 || height == 0 || width > 100_000 || height > 100_000 {
        return Err(CoreError::new(
            "invalid_image",
            "Image dimensions are out of range",
        ));
    }
    Ok(ImageProbe {
        width,
        height,
        checksum: format!("{:x}", md5::compute(bytes)),
        format: name.into(),
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use bubblefish_core::{protocol::Envelope, Engine};
    use bubblefish_formats::{export_project, import_project, Format};
    use wasm_bindgen::prelude::*;

    fn js_error(error: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&error.to_string())
    }
    fn core_error(error: CoreError) -> JsValue {
        let location = error
            .path
            .as_deref()
            .map(|path| format!(" ({path})"))
            .unwrap_or_default();
        JsValue::from_str(&format!("{error}{location}"))
    }
    fn value<T: Serialize>(input: &T) -> Result<JsValue, JsValue> {
        input
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(js_error)
    }
    fn format(name: &str) -> Result<Format, JsValue> {
        match name {
            "bf" => Ok(Format::Bf),
            "labelplus" => Ok(Format::Labelplus),
            _ => Err(js_error("Unknown project format")),
        }
    }

    #[wasm_bindgen]
    pub struct CoreHost {
        engine: Engine,
    }

    #[wasm_bindgen]
    impl CoreHost {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                engine: Engine::default(),
            }
        }

        pub fn dispatch(&mut self, envelope: JsValue) -> Result<JsValue, JsValue> {
            let envelope: Envelope = serde_wasm_bindgen::from_value(envelope).map_err(js_error)?;
            value(&self.engine.dispatch(envelope))
        }

        pub fn document(&self, project_id: &str) -> Result<JsValue, JsValue> {
            value(&self.engine.document(project_id).map_err(core_error)?)
        }

        #[wasm_bindgen(js_name = importProject)]
        pub fn import_project(
            &self,
            bytes: &[u8],
            kind: &str,
            project_id: String,
        ) -> Result<JsValue, JsValue> {
            value(&import_project(bytes, format(kind)?, project_id).map_err(core_error)?)
        }

        #[wasm_bindgen(js_name = exportProject)]
        pub fn export_project(&self, project_id: &str, kind: &str) -> Result<Vec<u8>, JsValue> {
            let document = self.engine.document(project_id).map_err(core_error)?;
            export_project(&document, format(kind)?).map_err(core_error)
        }

        #[wasm_bindgen(js_name = probeImage)]
        pub fn probe_image(&self, bytes: &[u8]) -> Result<JsValue, JsValue> {
            value(&super::probe_image(bytes).map_err(core_error)?)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn probe_rejects_non_image() {
        assert!(super::probe_image(b"not an image").is_err());
    }
    #[test]
    fn probe_headers_and_checksum() {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[0, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let probe = super::probe_image(&bytes).unwrap();
        assert_eq!(
            (probe.width, probe.height, probe.format.as_str()),
            (1, 1, "png")
        );
        assert_eq!(probe.checksum, format!("{:x}", md5::compute(bytes)));
    }
}
