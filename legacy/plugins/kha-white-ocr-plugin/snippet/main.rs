use anyhow::{Context, Result};
use clap::Parser;
use image::DynamicImage;
use ndarray::{Array2, Array4};
use ort::session::Session;
use ort::value::Tensor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const ENCODER_MODEL: &[u8] = include_bytes!("encoder.onnx");
const DECODER_MODEL: &[u8] = include_bytes!("decoder.onnx");
const CONFIG_JSON: &str = include_str!("config.json");
const VOCAB_TXT: &str = include_str!("vocab.txt");

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

    fn process(&self, image: &DynamicImage) -> Result<Array4<f32>> {
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
    fn new(vocab_content: &str, special_tokens: SpecialTokens) -> Result<Self> {
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
    fn new() -> Result<Self> {
        let config: Config = serde_json::from_str(CONFIG_JSON)
            .context("Failed to parse config.json")?;

        let processor = ImageProcessor::new(config.preprocessor.clone());

        let tokenizer = Tokenizer::new(VOCAB_TXT, config.special_tokens.clone())?;

        println!("Loading embedded models...");

        let encoder_session = Session::builder()?
            .commit_from_memory(ENCODER_MODEL)?;

        let decoder_session = Session::builder()?
            .commit_from_memory(DECODER_MODEL)?;

        println!("✓ Models loaded successfully");

        Ok(Self {
            processor,
            tokenizer,
            encoder_session,
            decoder_session,
            config,
        })
    }

    fn run_ocr(&mut self, image_path: &Path, verbose: bool) -> Result<String> {
        let image = image::open(image_path)
            .context("Failed to open image")?;

        let grayscale = image.to_luma8();
        let rgb_image = DynamicImage::ImageLuma8(grayscale).to_rgb8();
        let converted_image = DynamicImage::ImageRgb8(rgb_image);

        let pixel_values = self.processor.process(&converted_image)?;

        let pixel_tensor = Tensor::from_array(pixel_values)?;
        let encoder_outputs = self.encoder_session.run(ort::inputs![pixel_tensor])?;

        if verbose {
            let (encoder_shape, _encoder_data) = encoder_outputs[0].try_extract_tensor::<f32>()?;
            println!("Encoder output shape: {:?}", encoder_shape);
        }

        let mut generated_ids = vec![self.config.model.decoder_start_token_id];

        // Store encoder output for reuse
        let encoder_output_ref = &encoder_outputs[0];
        
        for _step in 0..self.config.model.max_length {
            let input_ids_array = Array2::from_shape_vec(
                (1, generated_ids.len()),
                generated_ids.clone()
            )?;
            let attention_mask = Array2::<i64>::ones(input_ids_array.raw_dim());

            let input_ids_tensor = Tensor::from_array(input_ids_array)?;
            let attention_mask_tensor = Tensor::from_array(attention_mask)?;

            let decoder_outputs = self.decoder_session.run(ort::inputs![
                input_ids_tensor,
                encoder_output_ref,
                attention_mask_tensor
            ])?;

            let (_logits_shape, logits_data) = decoder_outputs[0].try_extract_tensor::<f32>()?;
            
            // Get vocab size from last dimension
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
                if verbose {
                    println!("Generated {} tokens", generated_ids.len() - 1);
                }
                break;
            }
        }

        // Drop encoder_outputs before borrowing self immutably
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

#[derive(Parser, Debug)]
#[command(author, version, about = "Run manga OCR using ONNX models", long_about = None)]
struct Args {
    #[arg(long, help = "Path to input image")]
    image: PathBuf,

    #[arg(long, help = "Enable verbose output")]
    verbose: bool,
}

fn main() {
    // Install a custom signal handler to suppress abort on cleanup
    unsafe {
        libc::signal(libc::SIGABRT, libc::SIG_IGN);
    }

    // Initialize ONNX Runtime
    if let Err(e) = ort::init()
        .with_name("manga_ocr")
        .commit() {
        eprintln!("Failed to initialize ONNX Runtime: {}", e);
        std::process::exit(1);
    }
    
    let args = Args::parse();

    if !args.image.exists() {
        eprintln!("Error: Image file '{:?}' not found", args.image);
        std::process::exit(1);
    }

    // Store result before cleanup
    let result = match (|| -> Result<String> {
        let mut ocr = MangaOCR::new()?;
        println!("\nProcessing: {:?}", args.image);
        ocr.run_ocr(&args.image, args.verbose)
    })() {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };
    
    // Print result
    println!("\nResult: {}", result);
    
    // Force clean exit
    unsafe {
        libc::_exit(0);
    }
}