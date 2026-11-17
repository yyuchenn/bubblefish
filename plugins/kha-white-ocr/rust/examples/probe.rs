//! Numerical validation tool, excluded from plugin packages.
//! probe MODEL_DIRECTORY IMAGE OUTPUT_DIRECTORY ONNXRUNTIME_LIBRARY
use bubblefish_kha_white_ocr::{argmax_first, Processor, EXPECTED_TEXT, VOCAB_SIZE};
use ort::{session::Session, value::Tensor};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::Instant};

fn write_tensor(path: &Path, values: &[f32]) -> Result<String, Box<dyn std::error::Error>> {
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    fs::write(path, bytes)?;
    Ok(digest)
}
fn make_session(path: &Path) -> Result<Session, Box<dyn std::error::Error>> {
    Ok(Session::builder()?
        .with_intra_threads(2)?
        .with_inter_threads(1)?
        .commit_from_file(path)?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "Usage: probe MODEL_DIRECTORY IMAGE OUTPUT_DIRECTORY ONNXRUNTIME_LIBRARY".into(),
        );
    }
    let model = Path::new(&args[0]);
    let output = Path::new(&args[2]);
    fs::create_dir_all(output)?;
    bubblefish_kha_white_ocr::native::initialize_runtime_at(Path::new(&args[3]))?;
    let processor = Processor::new(
        &fs::read_to_string(model.join("config.json"))?,
        &fs::read_to_string(model.join("vocab.txt"))?,
    )?;
    let start = Instant::now();
    let pixels = processor.preprocess(&fs::read(&args[1])?)?;
    let preprocess_sha256 = write_tensor(&output.join("preprocess.f32"), &pixels)?;
    let mut encoder = make_session(&model.join("encoder.onnx"))?;
    let mut decoder = make_session(&model.join("decoder.onnx"))?;
    let encoded = encoder.run(ort::inputs![Tensor::from_array((
        vec![1, 3, 224, 224],
        pixels
    ))?])?;
    let (encoder_shape, hidden) = encoded[0].try_extract_tensor::<f32>()?;
    let encoder_sha256 = write_tensor(&output.join("encoder.f32"), hidden)?;
    let mut decoders = Vec::new();
    for length in [1, 2, 8, 32, 300] {
        let ids = vec![processor.config.model.decoder_start_token_id; length];
        let mask = vec![1i64; length];
        let result = decoder.run(ort::inputs![
            Tensor::from_array((vec![1, length], ids))?,
            &encoded[0],
            Tensor::from_array((vec![1, length], mask))?
        ])?;
        let (shape, logits) = result[0].try_extract_tensor::<f32>()?;
        let sha256 = write_tensor(&output.join(format!("decoder-{length}.f32")), logits)?;
        decoders.push(json!({"sequenceLength":length,"shape":shape.as_ref(),"sha256":sha256}));
    }
    let mut tokens = vec![processor.config.model.decoder_start_token_id];
    for _ in 0..processor.config.model.max_length {
        let length = tokens.len();
        let result = decoder.run(ort::inputs![
            Tensor::from_array((vec![1, length], tokens.clone()))?,
            &encoded[0],
            Tensor::from_array((vec![1, length], vec![1i64; length]))?
        ])?;
        let (_, logits) = result[0].try_extract_tensor::<f32>()?;
        let token = argmax_first(&logits[(length - 1) * VOCAB_SIZE..])? as i64;
        tokens.push(token);
        if token == processor.config.model.eos_token_id {
            break;
        }
    }
    let text = processor.decode(&tokens[1..]);
    let report = json!({"text":text,"expected":EXPECTED_TEXT,"passed":text==EXPECTED_TEXT,"tokenIds":tokens,"preprocessSha256":preprocess_sha256,"encoder":{"shape":encoder_shape.as_ref(),"sha256":encoder_sha256},"decoders":decoders,"totalMs":start.elapsed().as_secs_f64()*1000.0});
    fs::write(
        output.join("report.json"),
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    println!("{}", serde_json::to_string(&report)?);
    drop(encoded);
    drop(decoder);
    drop(encoder);
    unsafe {
        bubblefish_kha_white_ocr::native::shutdown_runtime_after_sessions_drop();
    }
    Ok(())
}
