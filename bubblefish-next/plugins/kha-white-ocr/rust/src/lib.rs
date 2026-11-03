//! Exact preprocessing and text decoding shared by native ORT and browser ORT Web.
//! Inference backends own model sessions; this library never downloads a model.
use image::DynamicImage;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub const MODEL_SET_ID: &str = "kha-white-manga-ocr-fp32-v1";
pub const VOCAB_SIZE: usize = 6144;
pub const EXPECTED_TEXT: &str = "今日はいい天気ですね。";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PreprocessorConfig {
    pub image_size: [u32; 2],
    pub rescale_factor: f32,
    pub image_mean: [f32; 3],
    pub image_std: [f32; 3],
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelConfig {
    pub decoder_start_token_id: i64,
    pub eos_token_id: i64,
    pub max_length: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SpecialToken {
    pub id: usize,
    pub token: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SpecialTokens {
    pub pad: SpecialToken,
    pub unk: SpecialToken,
    pub cls: SpecialToken,
    pub sep: SpecialToken,
    pub mask: SpecialToken,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    pub preprocessor: PreprocessorConfig,
    pub model: ModelConfig,
    pub special_tokens: SpecialTokens,
}

pub struct Processor {
    pub config: Config,
    vocabulary: Vec<String>,
    special_tokens: Vec<String>,
}
impl Processor {
    pub fn new(config_json: &str, vocabulary: &str) -> Result<Self, String> {
        let config: Config =
            serde_json::from_str(config_json).map_err(|error| format!("无效模型配置：{error}"))?;
        let vocabulary: Vec<String> = vocabulary
            .lines()
            .map(|line| line.trim().to_owned())
            .collect();
        let p = &config.preprocessor;
        if p.image_size != [224, 224]
            || p.rescale_factor != 1.0f32 / 255.0
            || p.image_mean != [0.5; 3]
            || p.image_std != [0.5; 3]
            || config.model.decoder_start_token_id != 2
            || config.model.eos_token_id != 3
            || config.model.max_length != 300
            || vocabulary.len() != VOCAB_SIZE
        {
            return Err("模型配置或词表与已验证的 Kha White FP32 模型不匹配".into());
        }
        let tokens = &config.special_tokens;
        let special_tokens = [
            &tokens.pad,
            &tokens.unk,
            &tokens.cls,
            &tokens.sep,
            &tokens.mask,
        ]
        .into_iter()
        .enumerate()
        .map(|(expected, token)| {
            if token.id != expected || vocabulary.get(token.id) != Some(&token.token) {
                Err("模型特殊 token 配置与词表不匹配".to_string())
            } else {
                Ok(token.token.clone())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            config,
            vocabulary,
            special_tokens,
        })
    }
    pub fn preprocess(&self, bytes: &[u8]) -> Result<Vec<f32>, String> {
        let image =
            image::load_from_memory(bytes).map_err(|error| format!("图片解码失败：{error}"))?;
        Ok(self.preprocess_image(&image))
    }
    pub fn preprocess_image(&self, image: &DynamicImage) -> Vec<f32> {
        // Preserve the original Rust plugin's luminance and image::Triangle kernel.
        // Pillow and Canvas use different grayscale/resampling rules.
        let grayscale = image.to_luma8();
        let rgb = DynamicImage::ImageLuma8(grayscale).to_rgb8();
        let config = &self.config.preprocessor;
        let [width, height] = config.image_size;
        let resized =
            image::imageops::resize(&rgb, width, height, image::imageops::FilterType::Triangle);
        let plane = (width * height) as usize;
        let mut values = vec![0.0f32; 3 * plane];
        for (x, y, pixel) in resized.enumerate_pixels() {
            for channel in 0..3 {
                let scaled = pixel[channel] as f32 * config.rescale_factor;
                values[channel * plane + (y * width + x) as usize] =
                    (scaled - config.image_mean[channel]) / config.image_std[channel];
            }
        }
        values
    }
    pub fn decode(&self, token_ids: &[i64]) -> String {
        let text: String = token_ids
            .iter()
            .filter_map(|id| {
                usize::try_from(*id)
                    .ok()
                    .and_then(|id| self.vocabulary.get(id))
            })
            .filter(|token| !self.special_tokens.contains(token))
            .map(String::as_str)
            .collect::<String>()
            .replace("##", "");
        post_process(&text)
    }
}

pub fn argmax_first(logits: &[f32]) -> Result<usize, String> {
    if logits.is_empty() || logits.iter().any(|value| !value.is_finite()) {
        return Err("模型返回空或非有限 logits".into());
    }
    let mut index = 0;
    let mut maximum = f32::NEG_INFINITY;
    for (current, &value) in logits.iter().enumerate() {
        if value > maximum {
            maximum = value;
            index = current;
        }
    }
    Ok(index)
}

pub fn post_process(text: &str) -> String {
    static DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[・.]{2,}").unwrap());
    let text = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .replace('…', "...");
    // Intentional compatibility: the original Rust plugin counts UTF-8 bytes,
    // so "・・" becomes six periods, not two as in its Python reference.
    DOTS.replace_all(&text, |capture: &regex::Captures| {
        ".".repeat(capture[0].len())
    })
    .into_owned()
}

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    pub struct KhaProcessor(Processor);
    #[wasm_bindgen]
    impl KhaProcessor {
        #[wasm_bindgen(constructor)]
        pub fn new(config_json: &str, vocabulary: &str) -> Result<KhaProcessor, JsError> {
            Processor::new(config_json, vocabulary)
                .map(Self)
                .map_err(|error| JsError::new(&error))
        }
        pub fn preprocess(&self, bytes: &[u8]) -> Result<Vec<f32>, JsError> {
            self.0
                .preprocess(bytes)
                .map_err(|error| JsError::new(&error))
        }
        pub fn decode(&self, token_ids: &[i32]) -> String {
            self.0.decode(
                &token_ids
                    .iter()
                    .map(|id| i64::from(*id))
                    .collect::<Vec<_>>(),
            )
        }
    }
    #[wasm_bindgen]
    pub fn argmax(logits: &[f32]) -> Result<u32, JsError> {
        argmax_first(logits)
            .map(|index| index as u32)
            .map_err(|error| JsError::new(&error))
    }
}

#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub mod native;

#[cfg(test)]
mod tests {
    use super::*;
    fn processor() -> Processor {
        let mut vocabulary: Vec<String> = (0..VOCAB_SIZE).map(|id| format!("token{id}")).collect();
        for (id, token) in ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
            .into_iter()
            .enumerate()
        {
            vocabulary[id] = token.into();
        }
        vocabulary[5] = "今日".into();
        vocabulary[6] = "##は".into();
        vocabulary[7] = "…".into();
        Processor::new(r#"{"preprocessor":{"image_size":[224,224],"rescale_factor":0.00392156862745098,"image_mean":[0.5,0.5,0.5],"image_std":[0.5,0.5,0.5]},"model":{"decoder_start_token_id":2,"eos_token_id":3,"max_length":300},"special_tokens":{"pad":{"id":0,"token":"[PAD]"},"unk":{"id":1,"token":"[UNK]"},"cls":{"id":2,"token":"[CLS]"},"sep":{"id":3,"token":"[SEP]"},"mask":{"id":4,"token":"[MASK]"}}}"#, &vocabulary.join("\n")).unwrap()
    }
    #[test]
    fn greedy_is_first_index_for_ties_and_rejects_invalid_logits() {
        assert_eq!(argmax_first(&[-2.0, 4.0, 4.0]).unwrap(), 1);
        assert!(argmax_first(&[]).is_err());
        assert!(argmax_first(&[f32::NAN]).is_err());
    }
    #[test]
    fn retains_legacy_unicode_postprocessing_and_token_rules() {
        assert_eq!(
            processor().decode(&[2, 2, 5, 6, 7, 3, 0, -1, 7000]),
            "今日は..."
        );
        assert_eq!(post_process("\u{3000}あ \n・・. …"), "あ..........");
    }
    #[test]
    fn grayscale_normalization_and_nchw_planes_match_original() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            224,
            224,
            image::Rgb([255, 0, 0]),
        ));
        let actual = processor().preprocess_image(&image);
        // image's original luma conversion is floor((2126R+7152G+722B)/10000).
        let expected = (54.0f32 * (1.0f32 / 255.0) - 0.5) / 0.5;
        assert_eq!(actual.len(), 3 * 224 * 224);
        assert!(actual.iter().all(|value| *value == expected));
    }
    #[test]
    fn rejects_empty_or_incompatible_model_inputs() {
        assert!(Processor::new("{}", "").is_err());
        assert!(processor().preprocess(b"not an image").is_err());
    }
}
