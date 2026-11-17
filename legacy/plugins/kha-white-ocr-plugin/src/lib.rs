use bubblefish_plugin_sdk::{
    Plugin, PluginContext, ServiceProxyManager, CoreEvent, PluginMetadata,
    plugin_metadata, export_plugin
};
use serde_json::Value;
use image::DynamicImage;
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ENCODER_MODEL: &[u8] = include_bytes!("../onnx_model/encoder.onnx");
const DECODER_MODEL: &[u8] = include_bytes!("../onnx_model/decoder.onnx");
const CONFIG_JSON: &str = include_str!("../onnx_model/config.json");
const VOCAB_TXT: &str = include_str!("../onnx_model/vocab.txt");

#[derive(Debug, Deserialize, Serialize, Clone)]
struct PreprocessorConfig {
    image_size: [u32; 2],
    rescale_factor: f32,
    image_mean: [f32; 3],
    image_std: [f32; 3],
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ModelConfig {
    decoder_start_token_id: i64,
    eos_token_id: i64,
    max_length: usize,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SpecialToken {
    id: usize,
    token: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SpecialTokens {
    pad: SpecialToken,
    unk: SpecialToken,
    cls: SpecialToken,
    sep: SpecialToken,
    mask: SpecialToken,
}

#[derive(Debug, Deserialize, Serialize)]
struct Config {
    preprocessor: PreprocessorConfig,
    model: ModelConfig,
    special_tokens: SpecialTokens,
}

struct ImageProcessor {
    config: PreprocessorConfig,
}

impl ImageProcessor {
    fn new(config: PreprocessorConfig) -> Self {
        Self { config }
    }

    fn process(&self, image: &DynamicImage) -> Result<Array4<f32>, String> {
        let rgb_image = image.to_rgb8();

        let resized = image::imageops::resize(
            &rgb_image,
            self.config.image_size[0],
            self.config.image_size[1],
            image::imageops::FilterType::Triangle,
        );

        let mut pixel_array = Array4::<f32>::zeros((1, 3, self.config.image_size[1] as usize, self.config.image_size[0] as usize));

        for (x, y, pixel) in resized.enumerate_pixels() {
            for c in 0..3 {
                let value = pixel[c] as f32 * self.config.rescale_factor;
                let normalized = (value - self.config.image_mean[c]) / self.config.image_std[c];
                pixel_array[[0, c, y as usize, x as usize]] = normalized;
            }
        }

        Ok(pixel_array)
    }
}

struct Tokenizer {
    id_to_token: HashMap<usize, String>,
    special_token_set: Vec<String>,
}

impl Tokenizer {
    fn new(vocab_content: &str, special_tokens: SpecialTokens) -> Result<Self, String> {
        let mut id_to_token = HashMap::new();

        for (idx, line) in vocab_content.lines().enumerate() {
            let token = line.trim().to_string();
            id_to_token.insert(idx, token);
        }

        let special_token_set = vec![
            special_tokens.pad.token.clone(),
            special_tokens.unk.token.clone(),
            special_tokens.cls.token.clone(),
            special_tokens.sep.token.clone(),
            special_tokens.mask.token.clone(),
        ];

        Ok(Self {
            id_to_token,
            special_token_set,
        })
    }

    fn decode(&self, token_ids: &[i64], skip_special_tokens: bool) -> String {
        let mut tokens = Vec::new();

        for &token_id in token_ids {
            if let Some(token) = self.id_to_token.get(&(token_id as usize)) {
                if skip_special_tokens && self.special_token_set.contains(token) {
                    continue;
                }
                tokens.push(token.clone());
            }
        }

        let mut text = tokens.join("");
        text = text.replace("##", "");

        text
    }
}

struct MangaOCR {
    processor: ImageProcessor,
    tokenizer: Tokenizer,
    encoder_session: Session,
    decoder_session: Session,
    config: Config,
}

impl MangaOCR {
    fn new() -> Result<Self, String> {
        let config: Config = serde_json::from_str(CONFIG_JSON)
            .map_err(|e| format!("Failed to parse config.json: {}", e))?;

        let processor = ImageProcessor::new(config.preprocessor.clone());

        let tokenizer = Tokenizer::new(VOCAB_TXT, config.special_tokens.clone())
            .map_err(|e| format!("Failed to create tokenizer: {}", e))?;

        let encoder_session = Session::builder()
            .map_err(|e| format!("Failed to create encoder session builder: {}", e))?
            .commit_from_memory(ENCODER_MODEL)
            .map_err(|e| format!("Failed to load encoder model: {}", e))?;

        let decoder_session = Session::builder()
            .map_err(|e| format!("Failed to create decoder session builder: {}", e))?
            .commit_from_memory(DECODER_MODEL)
            .map_err(|e| format!("Failed to load decoder model: {}", e))?;

        Ok(Self {
            processor,
            tokenizer,
            encoder_session,
            decoder_session,
            config,
        })
    }

    fn run_ocr(&mut self, image_data: &[u8]) -> Result<String, String> {
        let image = image::load_from_memory(image_data)
            .map_err(|e| format!("Failed to load image from memory: {}", e))?;

        let grayscale = image.to_luma8();
        let rgb_image = DynamicImage::ImageLuma8(grayscale).to_rgb8();
        let converted_image = DynamicImage::ImageRgb8(rgb_image);

        let pixel_values = self.processor.process(&converted_image)
            .map_err(|e| format!("Failed to process image: {}", e))?;

        let (vec, _offset) = pixel_values.into_raw_vec_and_offset();
        let pixel_tensor = Tensor::from_array((vec![1, 3, self.config.preprocessor.image_size[1] as usize, self.config.preprocessor.image_size[0] as usize], vec))
            .map_err(|e| format!("Failed to create pixel tensor: {}", e))?;
        let encoder_outputs = self.encoder_session.run(ort::inputs![pixel_tensor])
            .map_err(|e| format!("Failed to run encoder: {}", e))?;

        let mut generated_ids = vec![self.config.model.decoder_start_token_id];

        let encoder_output_ref = &encoder_outputs[0];

        for _step in 0..self.config.model.max_length {
            let input_ids_shape = vec![1, generated_ids.len()];
            let input_ids_data = generated_ids.clone();
            let attention_mask_data = vec![1i64; generated_ids.len()];
            let attention_mask_shape = vec![1, generated_ids.len()];

            let input_ids_tensor = Tensor::from_array((input_ids_shape, input_ids_data))
                .map_err(|e| format!("Failed to create input_ids tensor: {}", e))?;
            let attention_mask_tensor = Tensor::from_array((attention_mask_shape, attention_mask_data))
                .map_err(|e| format!("Failed to create attention mask tensor: {}", e))?;

            let decoder_outputs = self.decoder_session.run(ort::inputs![
                input_ids_tensor,
                encoder_output_ref,
                attention_mask_tensor
            ]).map_err(|e| format!("Failed to run decoder: {}", e))?;

            let (_logits_shape, logits_data) = decoder_outputs[0].try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract logits: {}", e))?;

            let vocab_size = logits_data.len() / generated_ids.len();
            let last_token_start = (generated_ids.len() - 1) * vocab_size;
            let last_token_logits = &logits_data[last_token_start..last_token_start + vocab_size];

            let mut max_idx = 0;
            let mut max_val = f32::NEG_INFINITY;
            for (idx, &val) in last_token_logits.iter().enumerate() {
                if val > max_val {
                    max_val = val;
                    max_idx = idx;
                }
            }

            let next_token_id = max_idx as i64;
            generated_ids.push(next_token_id);

            if next_token_id == self.config.model.eos_token_id {
                break;
            }
        }

        drop(encoder_outputs);

        let text = self.tokenizer.decode(&generated_ids[1..], true);
        let processed_text = self.post_process(&text);

        Ok(processed_text)
    }

    fn post_process(&self, text: &str) -> String {
        let mut result = text.chars().filter(|c| !c.is_whitespace()).collect::<String>();

        result = result.replace("…", "...");

        let re = Regex::new(r"[・.]{2,}").unwrap();
        result = re.replace_all(&result, |caps: &regex::Captures| {
            ".".repeat(caps[0].len())
        }).to_string();

        result
    }
}

static OCR_ENGINE: once_cell::sync::Lazy<std::sync::Mutex<Option<MangaOCR>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

fn init_ocr_engine() -> Result<(), String> {
    let mut engine = OCR_ENGINE.lock().unwrap();
    if engine.is_none() {
        #[cfg(not(target_arch = "wasm32"))]
        {
            ort::init()
                .with_name("kha_white_ocr")
                .commit()
                .map_err(|e| format!("Failed to initialize ONNX Runtime: {}", e))?;
        }

        *engine = Some(MangaOCR::new()?);
    }
    Ok(())
}

pub struct KhaWhiteOCRPlugin {
    context: Option<PluginContext>,
    services: Option<ServiceProxyManager>,
}

impl KhaWhiteOCRPlugin {
    pub fn new() -> Self {
        Self {
            context: None,
            services: None,
        }
    }

    fn log(&self, message: &str) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("[KhaWhiteOCR] {}", message).into());

        #[cfg(not(target_arch = "wasm32"))]
        println!("[KhaWhiteOCR] {}", message);
    }
}

impl Plugin for KhaWhiteOCRPlugin {
    fn init(&mut self, context: PluginContext, services: ServiceProxyManager) -> Result<(), String> {
        self.context = Some(context.clone());
        self.services = Some(services);

        self.log("Kha White OCR plugin initialized");

        if let Err(e) = init_ocr_engine() {
            let error_msg = format!("Failed to initialize OCR engine: {}", e);
            self.log(&error_msg);
            return Err(error_msg);
        }

        self.log("OCR engine loaded successfully");

        if let Some(ctx) = &self.context {
            let service_info = serde_json::json!({
                "id": "kha-white-ocr",
                "name": "Kha White OCR Service",
                "version": "0.1.0",
                "supported_languages": ["ja", "zh", "en"],
                "supported_image_formats": ["png", "jpg", "jpeg"],
                "max_image_size": null
            });

            match ctx.call_service("bunny", "register_ocr_service", serde_json::json!({
                "plugin_id": ctx.plugin_id.clone(),
                "service_info": service_info
            })) {
                Ok(_) => self.log("OCR service registered successfully"),
                Err(e) => self.log(&format!("Failed to register OCR service: {}", e)),
            }
        }

        Ok(())
    }

    fn on_core_event(&mut self, _event: &CoreEvent) -> Result<(), String> {
        Ok(())
    }

    fn on_plugin_message(&mut self, from: &str, message: Value) -> Result<(), String> {
        if let Some(msg_type) = message.get("type").and_then(|v| v.as_str()) {
            if msg_type == "ocr_request" {
                self.log(&format!("Received OCR request from {}", from));

                let task_id = message.get("task_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let image_data = message.get("image_data")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u8))
                            .collect::<Vec<u8>>()
                    })
                    .unwrap_or_else(Vec::new);

                self.log(&format!("Processing OCR for {} bytes", image_data.len()));

                let result = {
                    let mut engine = OCR_ENGINE.lock().unwrap();
                    if let Some(ocr) = engine.as_mut() {
                        match ocr.run_ocr(&image_data) {
                            Ok(text) => text,
                            Err(e) => {
                                let error_msg = format!("OCR failed: {}", e);
                                self.log(&error_msg);

                                if let Some(ctx) = &self.context {
                                    let _ = ctx.call_service("events", "emit_business_event", serde_json::json!({
                                        "event_name": "plugin:ocr_error",
                                        "data": {
                                            "task_id": task_id,
                                            "error": error_msg
                                        }
                                    }));
                                }
                                return Ok(());
                            }
                        }
                    } else {
                        let error_msg = "OCR engine not initialized".to_string();
                        self.log(&error_msg);

                        if let Some(ctx) = &self.context {
                            let _ = ctx.call_service("events", "emit_business_event", serde_json::json!({
                                "event_name": "plugin:ocr_error",
                                "data": {
                                    "task_id": task_id,
                                    "error": error_msg
                                }
                            }));
                        }
                        return Ok(());
                    }
                };

                self.log(&format!("OCR result: {}", result));

                if let Some(ctx) = &self.context {
                    let event = serde_json::json!({
                        "task_id": task_id,
                        "text": result,
                        "model": "kha-white-ocr"
                    });

                    match ctx.call_service("events", "emit_business_event", serde_json::json!({
                        "event_name": "plugin:ocr_result",
                        "data": event
                    })) {
                        Ok(_) => self.log("OCR result event emitted successfully"),
                        Err(e) => self.log(&format!("Failed to emit OCR result event: {}", e)),
                    }
                }
            }
        }
        Ok(())
    }

    fn on_activate(&mut self) -> Result<(), String> {
        self.log("Kha White OCR plugin activated");
        Ok(())
    }

    fn on_deactivate(&mut self) -> Result<(), String> {
        self.log("Kha White OCR plugin deactivated");
        Ok(())
    }

    fn destroy(&mut self) {
        self.log("Kha White OCR plugin destroyed");

        if let Some(ctx) = &self.context {
            let _ = ctx.call_service("bunny", "unregister_service", serde_json::json!({
                "service_id": "kha-white-ocr"
            }));
        }

        self.context = None;
        self.services = None;
    }

    fn get_metadata(&self) -> PluginMetadata {
        plugin_metadata!("*")
    }
}

export_plugin!(KhaWhiteOCRPlugin);