//! Native next-plugin adapter. Model bytes arrive through the same scoped resource
//! API as the browser, and stdout contains SDK frames exclusively.
use super::{argmax_first, Processor, EXPECTED_TEXT, MODEL_SET_ID, VOCAB_SIZE};
use bubblefish_plugin_sdk_next::*;
use ort::{session::Session, value::Tensor};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

static RUNTIME_INITIALIZED: AtomicBool = AtomicBool::new(false);

pub const FILES: [(&str, usize, &str); 4] = [
    (
        "encoder.onnx",
        343_483_354,
        "8c2bdeff795d38ccc0b55d4627c75556931709310c32aec57d573c26356dd4dd",
    ),
    (
        "decoder.onnx",
        117_459_510,
        "33e1432b9a26c60071adb63bb32987b0414f6af90579de660a94411b4fe1fc7e",
    ),
    (
        "config.json",
        648,
        "36a390af2be3179685175c6c0151d660260d806e65a1e2269390fead03e30b02",
    ),
    (
        "vocab.txt",
        24_072,
        "344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d",
    ),
];
fn failure(code: &str, error: impl std::fmt::Display) -> PluginRpcError {
    PluginRpcError::new(code, error.to_string())
}
fn model_error(error: impl std::fmt::Display) -> PluginRpcError {
    failure("modelError", error)
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

trait VerifiedDescriptor {
    fn verified_descriptor(&self) -> bool;
}
impl VerifiedDescriptor for PluginLocalResourceSet {
    fn verified_descriptor(&self) -> bool {
        self.id == MODEL_SET_ID
            && self.files.len() == FILES.len()
            && FILES.iter().all(|(path, size, digest)| {
                self.files
                    .iter()
                    .filter(|file| {
                        file.path == *path
                            && file.byte_length == *size as u64
                            && file.sha256 == *digest
                    })
                    .count()
                    == 1
            })
    }
}

/// Resolve relative to a genuinely installed executable first. Cargo executables
/// and standalone protocol tests can instead set their cwd to an extracted package.
pub fn runtime_path() -> Result<PathBuf, PluginRpcError> {
    let target = env!("BF_KHA_NATIVE_TARGET");
    let name = if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.1.22.0.dylib"
    } else {
        "libonnxruntime.so.1.22.0"
    };
    let relative = PathBuf::from("vendor")
        .join("native")
        .join(target)
        .join(name);
    let mut roots = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(root) = executable
            .parent()
            .and_then(|directory| directory.parent())
            .and_then(|directory| directory.parent())
        {
            roots.push(root.to_owned());
        }
    }
    if let Ok(root) = std::env::current_dir() {
        roots.push(root);
    }
    for root in roots {
        let path = root.join(&relative);
        if path.is_file() {
            return path.canonicalize().map_err(model_error);
        }
    }
    Err(failure(
        "runtimeMissing",
        format!(
            "插件运行库缺失：{}；请重新安装当前平台的完整插件包",
            relative.display()
        ),
    ))
}
fn initialize_runtime() -> Result<(), PluginRpcError> {
    let path = runtime_path()?;
    initialize_runtime_at(&path)
}
/// Also used by the numerical probe, which receives an explicit test runtime.
pub fn initialize_runtime_at(path: &Path) -> Result<(), PluginRpcError> {
    #[cfg(windows)]
    {
        use libloading::os::windows::{
            Library, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        };
        // Keep the explicitly loaded runtime resident so ORT's second load uses
        // the same module and resolves dependency DLLs beside the packaged DLL.
        // Do not depend on cwd, PATH, or a developer-installed runtime directory.
        static LIBRARY: std::sync::OnceLock<Library> = std::sync::OnceLock::new();
        if LIBRARY.get().is_none() {
            let library = unsafe {
                Library::load_with_flags(
                    path,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
            }
            .map_err(|error| {
                failure(
                    "runtimeInvalid",
                    format!("无法装载插件内 ONNX Runtime DLL 及其依赖：{error}"),
                )
            })?;
            let _ = LIBRARY.set(library);
        }
    }
    // ort's global API loader may panic for an invalid dynamic library. Convert
    // that boundary into an actionable plugin error rather than a silent exit.
    std::panic::catch_unwind(|| {
        ort::init_from(path.to_string_lossy())
            .with_name("bubblefish-kha-white-ocr")
            .commit()
    })
    .map_err(|_| {
        failure(
            "runtimeInvalid",
            "无法装载插件内 ONNX Runtime 1.22.0 运行库",
        )
    })?
    .map_err(model_error)?;
    RUNTIME_INITIALIZED.store(true, Ordering::Release);
    Ok(())
}
/// Release the process-global ORT environment before the dynamic library's C++
/// static destructors run. ort rc10 stores it in a Rust static (never dropped).
///
/// # Safety
/// All plugin/model sessions and output tensors must already be dropped, and no
/// ORT API may be called after this final process shutdown operation.
pub unsafe fn shutdown_runtime_after_sessions_drop() {
    use ort::AsPointer;
    if RUNTIME_INITIALIZED.swap(false, Ordering::AcqRel) {
        if let Ok(environment) = ort::environment::get_environment() {
            unsafe {
                (ort::api().ReleaseEnv)(environment.ptr().cast_mut());
            }
        }
    }
}
fn session(
    bytes: &[u8],
    expected_inputs: &[&str],
    expected_outputs: &[&str],
) -> Result<Session, PluginRpcError> {
    let session = Session::builder()
        .map_err(model_error)?
        .with_intra_threads(2)
        .map_err(model_error)?
        .with_inter_threads(1)
        .map_err(model_error)?
        .commit_from_memory(bytes)
        .map_err(model_error)?;
    if session
        .inputs
        .iter()
        .map(|input| input.name.as_str())
        .collect::<Vec<_>>()
        != expected_inputs
        || session
            .outputs
            .iter()
            .map(|output| output.name.as_str())
            .collect::<Vec<_>>()
            != expected_outputs
    {
        return Err(model_error("模型输入／输出名称与已验证版本不匹配"));
    }
    Ok(session)
}

struct Engine {
    processor: Processor,
    encoder: Session,
    decoder: Session,
    created_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recognition {
    pub text: String,
    pub backend: &'static str,
    pub token_ids: Vec<i64>,
    pub timings: Value,
}
impl Engine {
    fn recognize(
        &mut self,
        bytes: &[u8],
        context: &mut PluginContext<'_>,
        task_id: &str,
    ) -> Result<Recognition, PluginRpcError> {
        context.check_cancelled()?;
        let total = Instant::now();
        context.progress(
            task_id,
            json!({"phase":"preprocessing","message":"准备图片"}),
        )?;
        let pixels = self.processor.preprocess(bytes).map_err(model_error)?;
        let preprocess_ms = elapsed(total);
        let tensor = Tensor::from_array((vec![1, 3, 224, 224], pixels)).map_err(model_error)?;
        context.progress(task_id, json!({"phase":"encoding","message":"编码图片"}))?;
        let encoding = Instant::now();
        let encoded = self
            .encoder
            .run(ort::inputs![tensor])
            .map_err(model_error)?;
        context.check_cancelled()?;
        let encoder_ms = elapsed(encoding);
        let (shape, hidden) = encoded[0]
            .try_extract_tensor::<f32>()
            .map_err(model_error)?;
        if shape.as_ref() != [1, 197, 768] || hidden.iter().any(|value| !value.is_finite()) {
            return Err(model_error("Encoder 返回无效形状或非有限数据"));
        }
        let decoding = Instant::now();
        let mut generated = vec![self.processor.config.model.decoder_start_token_id];
        for step in 0..self.processor.config.model.max_length {
            context.check_cancelled()?;
            context.progress(task_id, json!({"phase":"decoding","message":format!("生成文字（已生成 {step} 个 token）"),"completed":step}))?;
            let length = generated.len();
            let input_ids =
                Tensor::from_array((vec![1, length], generated.clone())).map_err(model_error)?;
            let mask =
                Tensor::from_array((vec![1, length], vec![1i64; length])).map_err(model_error)?;
            let result = self
                .decoder
                .run(ort::inputs![input_ids, &encoded[0], mask])
                .map_err(model_error)?;
            context.check_cancelled()?;
            let (shape, logits) = result[0].try_extract_tensor::<f32>().map_err(model_error)?;
            if shape.as_ref() != [1, length as i64, VOCAB_SIZE as i64]
                || logits.len() != length * VOCAB_SIZE
            {
                return Err(model_error("Decoder 返回无效 logits 形状"));
            }
            let token =
                argmax_first(&logits[(length - 1) * VOCAB_SIZE..]).map_err(model_error)? as i64;
            generated.push(token);
            if token == self.processor.config.model.eos_token_id {
                break;
            }
        }
        let decode_ms = elapsed(decoding);
        context.check_cancelled()?;
        let text = self.processor.decode(&generated[1..]);
        context.progress(
            task_id,
            json!({"phase":"completed","message":"识别完成","completed":1,"total":1}),
        )?;
        Ok(Recognition {
            text,
            backend: "native",
            token_ids: generated,
            timings: json!({"preprocessMs":preprocess_ms,"encoderMs":encoder_ms,"decodeMs":decode_ms,"totalMs":elapsed(total)}),
        })
    }
}

#[derive(Default)]
pub struct KhaPlugin {
    engine: Option<Engine>,
}
impl KhaPlugin {
    async fn model(
        &mut self,
        context: &mut PluginContext<'_>,
    ) -> Result<Option<PluginLocalResourceSet>, PluginRpcError> {
        let model = context
            .resources_local_list()
            .await?
            .into_iter()
            .find(PluginLocalResourceSet::verified_descriptor);
        if model.as_ref().map(|model| model.created_at)
            != self.engine.as_ref().map(|engine| engine.created_at)
        {
            self.engine = None;
        }
        Ok(model)
    }
    async fn bytes(context: &mut PluginContext<'_>, path: &str) -> Result<Vec<u8>, PluginRpcError> {
        let bytes = context.resources_local_read(MODEL_SET_ID, path).await?;
        let Some((_, expected_length, expected_sha)) = FILES.iter().find(|file| file.0 == path)
        else {
            return Err(model_error("未知模型文件"));
        };
        if bytes.len() != *expected_length
            || format!("{:x}", Sha256::digest(&bytes)) != *expected_sha
        {
            return Err(model_error(format!(
                "模型文件校验失败：{path}；请重新导入已验证的模型包"
            )));
        }
        Ok(bytes)
    }
    async fn ensure(
        &mut self,
        context: &mut PluginContext<'_>,
        task_id: &str,
    ) -> Result<(), PluginRpcError> {
        context.check_cancelled()?;
        let Some(model) = self.model(context).await? else {
            return Err(failure(
                "modelMissing",
                "请先打开 Kha White OCR 模型面板，导入离线模型包",
            ));
        };
        if self.engine.is_some() {
            return Ok(());
        }
        context.progress(task_id, json!({"phase":"loading","message":"加载模型配置"}))?;
        let config =
            String::from_utf8(Self::bytes(context, "config.json").await?).map_err(model_error)?;
        let vocabulary =
            String::from_utf8(Self::bytes(context, "vocab.txt").await?).map_err(model_error)?;
        let processor = Processor::new(&config, &vocabulary).map_err(model_error)?;
        initialize_runtime()?;
        context.progress(
            task_id,
            json!({"phase":"loading","message":"加载 Encoder 模型"}),
        )?;
        let encoder = {
            let bytes = Self::bytes(context, "encoder.onnx").await?;
            session(&bytes, &["pixel_values"], &["encoder_hidden_states"])?
        };
        context.progress(
            task_id,
            json!({"phase":"loading","message":"加载 Decoder 模型"}),
        )?;
        let decoder = {
            let bytes = Self::bytes(context, "decoder.onnx").await?;
            session(
                &bytes,
                &["input_ids", "encoder_hidden_states", "attention_mask"],
                &["logits"],
            )?
        };
        context.check_cancelled()?;
        self.engine = Some(Engine {
            processor,
            encoder,
            decoder,
            created_at: model.created_at,
        });
        Ok(())
    }
}
impl Plugin for KhaPlugin {
    fn manifest(&self) -> PluginManifest {
        serde_json::from_value(json!({
            "id":"kha-white-ocr-plugin","name":"Kha White OCR","version":"0.1.0","apiVersion":1,
            "entrypoints":{"web":"web.js"},"permissions":["resources.local.read","resources.local.write"],
            "contributes":{
                "ocr":[{"id":"kha-white-ocr","name":"Kha White OCR（日文）","languages":["ja"]}],
                "commands":[
                    {"id":"model-status","title":"Kha White OCR 模型状态"},
                    {"id":"self-test","title":"Kha White OCR 样例自检"},
                    {"id":"reset-model","title":"释放 Kha White OCR 模型"}
                ],
                "panels":[{"id":"models","title":"Kha White OCR 模型管理","entry":"panel.html"}]
            }
        })).expect("Static Kha manifest")
    }
    fn handle<'a>(
        &'a mut self,
        request: PluginRequest,
        binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginFuture<'a> {
        Box::pin(async move {
            match request.method.as_str() {
                "activate" => {
                    if context.runtime_role != PluginRuntimeRole::Main {
                        return Err(failure("role", "Kha White OCR 只注册主实例"));
                    }
                    let contributions = self.manifest().contributes;
                    for provider in contributions.ocr.into_iter().flatten() {
                        context.register_ocr(provider).await?;
                    }
                    for command in contributions.commands.into_iter().flatten() {
                        context.register_command(command).await?;
                    }
                    Ok(PluginOutput::json(Value::Null))
                }
                "deactivate" => {
                    self.engine = None;
                    Ok(PluginOutput::json(Value::Null))
                }
                "ocr.recognize" => {
                    let started = Instant::now();
                    let task_id = request
                        .params
                        .get("taskId")
                        .and_then(Value::as_str)
                        .unwrap_or("kha-white");
                    if binary.is_empty() {
                        return Err(failure("invalidImage", "OCR 请求缺少图片二进制附件"));
                    }
                    self.ensure(context, task_id).await?;
                    let mut result = self
                        .engine
                        .as_mut()
                        .unwrap()
                        .recognize(&binary, context, task_id)?;
                    result.timings["requestMs"] = json!(elapsed(started));
                    Ok(PluginOutput::json(
                        serde_json::to_value(result).map_err(model_error)?,
                    ))
                }
                "commands.execute" => match request.params.get("commandId").and_then(Value::as_str)
                {
                    Some("model-status") => {
                        context.check_cancelled()?;
                        context.report_progress(
                            json!({"phase":"querying","message":"正在查询模型与推理会话状态"}),
                        )?;
                        let model = self.model(context).await?;
                        context.check_cancelled()?;
                        context.summary(&format!(
                            "{} · 原生 CPU 后端 · {}",
                            if model.is_some() {
                                "模型已导入"
                            } else {
                                "尚未导入模型"
                            },
                            if self.engine.is_some() {
                                "推理会话已就绪"
                            } else {
                                "推理会话未加载"
                            },
                        ))?;
                        Ok(PluginOutput::json(
                            json!({"backend":"native","ready":self.engine.is_some(),"modelInstalled":model.is_some(),"modelId":MODEL_SET_ID,"busy":false,"runtimeVersion":"1.22.0"}),
                        ))
                    }
                    Some("reset-model") => {
                        context.check_cancelled()?;
                        context.report_progress(
                            json!({"phase":"resetting","message":"正在释放推理会话"}),
                        )?;
                        self.engine = None;
                        context.check_cancelled()?;
                        context.summary("推理会话已释放，下次识别时重新加载")?;
                        Ok(PluginOutput::json(
                            json!({"backend":"native","ready":false}),
                        ))
                    }
                    Some("self-test") => {
                        context.check_cancelled()?;
                        let task_id = context.task_id().unwrap_or("self-test").to_owned();
                        context.report_progress(
                            json!({"phase":"preparing","message":"正在读取内置日文样例"}),
                        )?;
                        let started = Instant::now();
                        let image = context
                            .call_host(
                                "resources.read",
                                json!({"path":"japanese-smoke.png"}),
                                vec![],
                                None,
                            )
                            .await?
                            .binary;
                        context.check_cancelled()?;
                        self.ensure(context, &task_id).await?;
                        let result = self
                            .engine
                            .as_mut()
                            .unwrap()
                            .recognize(&image, context, &task_id)?;
                        context.check_cancelled()?;
                        if result.text != EXPECTED_TEXT {
                            return Err(failure(
                                "selfTestFailed",
                                "OCR 自检失败：识别文字与内置样例不符",
                            ));
                        }
                        context.summary(&format!("OCR 自检通过：{}", result.text))?;
                        Ok(PluginOutput::json(
                            json!({"text":result.text,"expected":EXPECTED_TEXT,"passed":true,"backend":result.backend,"timings":result.timings,"requestMs":elapsed(started),"tokenIds":result.token_ids}),
                        ))
                    }
                    _ => Err(failure("unknownCommand", "未知 Kha White OCR 命令")),
                },
                _ => Err(failure("methodNotFound", "Kha White OCR 不支持此方法")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_manifest_matches_packaged_commands_and_panels() {
        let manifest = KhaPlugin::default().manifest();
        let packaged: PluginManifest =
            serde_json::from_str(include_str!("../../plugin.json")).unwrap();
        assert_eq!(manifest.version, "0.1.0");
        assert_eq!(manifest.version, packaged.version);
        let command_ids = |manifest: &PluginManifest| {
            manifest
                .contributes
                .commands
                .iter()
                .flatten()
                .map(|command| command.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            command_ids(&manifest),
            ["model-status", "self-test", "reset-model"]
        );
        assert_eq!(command_ids(&manifest), command_ids(&packaged));
        assert_eq!(manifest.contributes.panels, packaged.contributes.panels);
    }

    #[test]
    fn rejects_mismatched_model_descriptor() {
        let mut set = PluginLocalResourceSet {
            id: MODEL_SET_ID.into(),
            created_at: 1,
            files: FILES
                .iter()
                .map(|(path, size, sha)| PluginLocalResourceFile {
                    path: (*path).into(),
                    byte_length: *size as u64,
                    sha256: (*sha).into(),
                })
                .collect(),
        };
        assert!(set.verified_descriptor());
        set.files[0].sha256 = "wrong".into();
        assert!(!set.verified_descriptor());
        set.files[0] = set.files[1].clone();
        assert!(!set.verified_descriptor());
    }
}
