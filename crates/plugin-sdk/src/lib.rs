//! Async plugin SDK shared by browser WASM modules and native stdio executables.
//! Native stdout is exclusively framed protocol data; use stderr for diagnostics.
pub use bubblefish_plugin_protocol as protocol;
pub use protocol::*;
use serde_json::Value;
use std::{
    future::Future,
    pin::Pin,
    sync::{atomic::AtomicBool, Arc},
};
mod cancellation;
pub use cancellation::RequestCancellation;
mod document;
#[cfg(not(target_arch = "wasm32"))]
mod native_control;
mod resources;
pub use document::ImageBytes;

pub type PluginFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PluginOutput, PluginRpcError>> + 'a>>;
pub type HostFuture<'a> = Pin<Box<dyn Future<Output = Result<Frame, PluginRpcError>> + 'a>>;
pub type PluginEventFuture<'a> = Pin<Box<dyn Future<Output = Result<(), PluginRpcError>> + 'a>>;

#[derive(Clone, Debug)]
pub struct PluginOutput {
    pub result: Value,
    pub binary: Vec<u8>,
    pub mime_type: Option<String>,
}
impl PluginOutput {
    pub fn json(result: Value) -> Self {
        Self {
            result,
            binary: Vec::new(),
            mime_type: None,
        }
    }
}

/// Implement activate/deactivate, provider methods and command methods here.
/// The host owns lifecycle ordering; the SDK validates the initial handshake.
pub trait Plugin {
    fn manifest(&self) -> PluginManifest;
    fn handle<'a>(
        &'a mut self,
        request: PluginRequest,
        binary: Vec<u8>,
        context: &'a mut PluginContext<'_>,
    ) -> PluginFuture<'a>;
    fn on_event(&mut self, _event: PluginEvent, _binary: Vec<u8>) -> Result<(), PluginRpcError> {
        Ok(())
    }
    /// Events can issue asynchronous host calls using the same bound identity as requests.
    /// Existing synchronous event handlers continue to work through the default.
    fn on_event_with_context<'a>(
        &'a mut self,
        event: PluginEvent,
        binary: Vec<u8>,
        _context: &'a mut PluginContext<'_>,
    ) -> PluginEventFuture<'a> {
        Box::pin(async move { self.on_event(event, binary) })
    }
}

pub trait HostTransport {
    fn request<'a>(&'a mut self, frame: Frame) -> HostFuture<'a>;
    fn send(&mut self, frame: Frame) -> Result<(), PluginRpcError>;
}

pub struct PluginContext<'a> {
    pub plugin_id: &'a str,
    pub runtime_role: PluginRuntimeRole,
    transport: &'a mut dyn HostTransport,
    next_call: &'a mut u64,
    request_id: Option<String>,
    task_id: Option<String>,
    cancelled: Arc<AtomicBool>,
}
impl<'a> PluginContext<'a> {
    pub fn new(
        plugin_id: &'a str,
        transport: &'a mut dyn HostTransport,
        next_call: &'a mut u64,
    ) -> Self {
        Self::with_role(plugin_id, PluginRuntimeRole::Main, transport, next_call)
    }
    pub fn with_role(
        plugin_id: &'a str,
        runtime_role: PluginRuntimeRole,
        transport: &'a mut dyn HostTransport,
        next_call: &'a mut u64,
    ) -> Self {
        Self {
            plugin_id,
            runtime_role,
            transport,
            next_call,
            request_id: None,
            task_id: None,
            cancelled: Arc::default(),
        }
    }
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }
    pub fn task_id(&self) -> Option<&str> {
        self.task_id.as_deref()
    }
    pub fn check_cancelled(&self) -> Result<(), PluginRpcError> {
        cancellation::check(&self.cancelled)
    }
    /// A legacy request without a task ID has no progress destination.
    pub fn report_progress(&mut self, value: Value) -> Result<(), PluginRpcError> {
        self.check_cancelled()?;
        if let Some(task_id) = self.task_id.clone() {
            self.progress(&task_id, value)?;
        }
        Ok(())
    }
    /// Success presentation metadata; the host only displays it after a successful response.
    pub fn summary(&mut self, message: &str) -> Result<(), PluginRpcError> {
        self.check_cancelled()?;
        if let Some(task_id) = self.task_id.clone() {
            self.emit(
                "task.summary",
                serde_json::to_value(PluginTaskSummary {
                    task_id,
                    message: message.into(),
                })
                .unwrap(),
            )?;
        }
        Ok(())
    }
    pub async fn call_host(
        &mut self,
        method: &str,
        params: Value,
        binary: Vec<u8>,
        mime_type: Option<String>,
    ) -> Result<PluginOutput, PluginRpcError> {
        // Do not start new host work after cancellation. An already-issued call must
        // still consume its ACK below, particularly for committed document mutations.
        self.check_cancelled()?;
        *self.next_call += 1;
        let id = format!("{}:{}", self.plugin_id, self.next_call);
        let attachment = attachment(&binary, mime_type)?;
        let response = self
            .transport
            .request(Frame {
                message: PluginMessage::Request(PluginRequest {
                    api_version: PLUGIN_API_VERSION,
                    id: id.clone(),
                    method: method.into(),
                    params,
                    binary: attachment,
                }),
                binary,
            })
            .await?;
        response.validate().map_err(transport_error)?;
        match response.message {
            PluginMessage::Response(response_message) if response_message.id == id => {
                if let Some(error) = response_message.error {
                    return Err(error);
                }
                Ok(PluginOutput {
                    result: response_message.result.unwrap_or(Value::Null),
                    binary: response.binary,
                    mime_type: response_message.binary.and_then(|binary| binary.mime_type),
                })
            }
            _ => Err(PluginRpcError::new(
                "protocolError",
                "Host returned an unrelated response",
            )),
        }
    }
    pub fn emit(&mut self, event: &str, data: Value) -> Result<(), PluginRpcError> {
        self.transport.send(Frame {
            message: PluginMessage::Event(PluginEvent {
                api_version: PLUGIN_API_VERSION,
                event: event.into(),
                data,
                binary: None,
            }),
            binary: Vec::new(),
        })
    }
    pub fn progress(&mut self, task_id: &str, progress: Value) -> Result<(), PluginRpcError> {
        self.check_cancelled()?;
        self.emit(
            "task.progress",
            serde_json::json!({"taskId": task_id, "progress": progress}),
        )
    }
    pub async fn register_ocr(&mut self, info: ProviderInfo) -> Result<(), PluginRpcError> {
        self.register_provider("ocr", info).await
    }
    pub async fn register_translation(&mut self, info: ProviderInfo) -> Result<(), PluginRpcError> {
        self.register_provider("translation", info).await
    }
    async fn register_provider(
        &mut self,
        kind: &str,
        info: ProviderInfo,
    ) -> Result<(), PluginRpcError> {
        self.call_host(
            "providers.register",
            serde_json::json!({"kind":kind,"info":info}),
            Vec::new(),
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn register_command(&mut self, info: CommandInfo) -> Result<(), PluginRpcError> {
        self.call_host(
            "commands.register",
            serde_json::json!({"info":info}),
            Vec::new(),
            None,
        )
        .await?;
        Ok(())
    }
}

fn attachment(
    binary: &[u8],
    mime_type: Option<String>,
) -> Result<Option<BinaryAttachment>, PluginRpcError> {
    if binary.len() > MAX_BINARY_BYTES {
        return Err(PluginRpcError::new(
            "payloadTooLarge",
            "Binary payload is too large",
        ));
    }
    Ok((!binary.is_empty()).then_some(BinaryAttachment {
        byte_length: binary.len() as u32,
        mime_type,
    }))
}
fn transport_error(error: impl std::fmt::Display) -> PluginRpcError {
    PluginRpcError::new("transportError", error.to_string())
}

pub struct PluginSession<P: Plugin> {
    plugin: P,
    handshake_complete: bool,
    next_call: u64,
    runtime_role: PluginRuntimeRole,
    cancellation: RequestCancellation,
}
impl<P: Plugin> PluginSession<P> {
    pub fn new(plugin: P) -> Self {
        Self {
            plugin,
            handshake_complete: false,
            next_call: 0,
            runtime_role: PluginRuntimeRole::Main,
            cancellation: RequestCancellation::default(),
        }
    }
    pub fn cancellation_handle(&self) -> RequestCancellation {
        self.cancellation.clone()
    }
    pub async fn dispatch(
        &mut self,
        frame: Frame,
        transport: &mut dyn HostTransport,
    ) -> Result<Option<Frame>, PluginRpcError> {
        frame.validate().map_err(transport_error)?;
        match frame.message {
            PluginMessage::Event(event) => {
                if event.event == "$cancel" {
                    if let Some(id) = event.data.get("requestId").and_then(Value::as_str) {
                        self.cancellation.cancel(id);
                    }
                    return Ok(None);
                }
                if self.handshake_complete {
                    let plugin_id = self.plugin.manifest().id;
                    let mut context = PluginContext::with_role(
                        &plugin_id,
                        self.runtime_role,
                        transport,
                        &mut self.next_call,
                    );
                    self.plugin
                        .on_event_with_context(event, frame.binary, &mut context)
                        .await?;
                }
                Ok(None)
            }
            PluginMessage::Response(_) => Err(PluginRpcError::new(
                "protocolError",
                "Unsolicited host response",
            )),
            PluginMessage::Request(request) => {
                let id = request.id.clone();
                let cancelled = self.cancellation.token(&id);
                let result = if request.method == "handshake" {
                    self.handshake(&request.params)
                } else if !self.handshake_complete {
                    Err(PluginRpcError::new(
                        "handshakeRequired",
                        "Handshake must complete before plugin calls",
                    ))
                } else {
                    let plugin_id = self.plugin.manifest().id;
                    let mut context = PluginContext::with_role(
                        &plugin_id,
                        self.runtime_role,
                        transport,
                        &mut self.next_call,
                    );
                    context.request_id = Some(id.clone());
                    context.task_id = request
                        .params
                        .get("taskId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    context.cancelled = cancelled.clone();
                    match context.check_cancelled() {
                        Err(error) => Err(error),
                        Ok(()) => {
                            let output = self
                                .plugin
                                .handle(request, frame.binary, &mut context)
                                .await;
                            cancellation::check(&cancelled).and(output)
                        }
                    }
                };
                self.cancellation.release(&id);
                let response = match result {
                    Ok(output) => {
                        let binary = attachment(&output.binary, output.mime_type)?;
                        Frame {
                            message: PluginMessage::Response(PluginResponse {
                                api_version: PLUGIN_API_VERSION,
                                id,
                                result: Some(output.result),
                                error: None,
                                binary,
                            }),
                            binary: output.binary,
                        }
                    }
                    Err(error) => Frame {
                        message: PluginMessage::Response(PluginResponse {
                            api_version: PLUGIN_API_VERSION,
                            id,
                            result: None,
                            error: Some(error),
                            binary: None,
                        }),
                        binary: Vec::new(),
                    },
                };
                Ok(Some(response))
            }
        }
    }
    fn handshake(&mut self, params: &Value) -> Result<PluginOutput, PluginRpcError> {
        if self.handshake_complete {
            return Err(PluginRpcError::new(
                "alreadyInitialized",
                "Handshake has already completed",
            ));
        }
        let request: PluginHandshakeRequest = serde_json::from_value(params.clone())
            .map_err(|error| PluginRpcError::new("invalidHandshake", error.to_string()))?;
        let manifest = self.plugin.manifest();
        validate_manifest(&manifest)?;
        if request.api_version != PLUGIN_API_VERSION || request.plugin_id != manifest.id {
            return Err(PluginRpcError::new(
                "incompatibleApi",
                "Handshake plugin identity or API version does not match",
            ));
        }
        self.handshake_complete = true;
        self.runtime_role = request.runtime_role.unwrap_or_default();
        let response = PluginHandshakeResponse {
            api_version: PLUGIN_API_VERSION,
            plugin_id: manifest.id,
            features: [
                "binary",
                "hostCalls",
                "document.transactions",
                "history",
                "hooks",
                "runtime.roles",
                "resources.local",
                "commands.tasks",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        };
        Ok(PluginOutput::json(serde_json::to_value(response).unwrap()))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub mod native {
    use super::*;
    pub use crate::native_control::serve_with_control;
    use std::{
        collections::VecDeque,
        io::{self, Read, Write},
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };

    pub struct StdioTransport<R, W> {
        reader: R,
        writer: W,
        pending: VecDeque<Frame>,
    }
    impl<R: Read, W: Write> StdioTransport<R, W> {
        pub fn new(reader: R, writer: W) -> Self {
            Self {
                reader,
                writer,
                pending: VecDeque::new(),
            }
        }
        pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
            if let Some(frame) = self.pending.pop_front() {
                return Ok(Some(frame));
            }
            read_frame(&mut self.reader)
        }
    }
    impl<R: Read, W: Write> HostTransport for StdioTransport<R, W> {
        fn request<'a>(&'a mut self, frame: Frame) -> HostFuture<'a> {
            Box::pin(async move {
                let id = match &frame.message {
                    PluginMessage::Request(request) => request.id.clone(),
                    _ => {
                        return Err(PluginRpcError::new(
                            "protocolError",
                            "Host call must be a request",
                        ));
                    }
                };
                write_frame(&mut self.writer, &frame).map_err(transport_error)?;
                loop {
                    let response = read_frame(&mut self.reader)
                        .map_err(transport_error)?
                        .ok_or_else(|| {
                            PluginRpcError::new(
                                "hostDisconnected",
                                "Host closed the plugin connection",
                            )
                        })?;
                    if matches!(&response.message, PluginMessage::Response(message) if message.id == id)
                    {
                        return Ok(response);
                    }
                    self.pending.push_back(response);
                }
            })
        }
        fn send(&mut self, frame: Frame) -> Result<(), PluginRpcError> {
            write_frame(&mut self.writer, &frame).map_err(transport_error)
        }
    }

    struct ThreadWake(std::thread::Thread);
    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    pub(super) fn block_on<F: Future>(future: F) -> F::Output {
        let waker: Waker = Arc::new(ThreadWake(std::thread::current())).into();
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => std::thread::park(),
            }
        }
    }

    pub fn serve<P: Plugin, R: Read, W: Write>(
        plugin: P,
        reader: R,
        writer: W,
    ) -> Result<(), PluginRpcError> {
        let mut transport = StdioTransport::new(reader, writer);
        let mut session = PluginSession::new(plugin);
        while let Some(frame) = transport.next_frame().map_err(transport_error)? {
            if let Some(response) = block_on(session.dispatch(frame, &mut transport))? {
                transport.send(response)?;
            }
        }
        Ok(())
    }
    pub fn serve_stdio<P: Plugin>(plugin: P) -> Result<(), PluginRpcError> {
        let stdout = io::stdout();
        serve_with_control(plugin, io::stdin(), stdout.lock())
    }
}

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod wasm {
    use super::*;
    use serde::Serialize;
    use wasm_bindgen::{JsCast, JsValue};
    pub use {js_sys, serde_wasm_bindgen, wasm_bindgen, wasm_bindgen_futures};

    pub fn frame_to_js(frame: Frame) -> Result<JsValue, JsValue> {
        let object = js_sys::Object::new();
        js_sys::Reflect::set(
            &object,
            &"message".into(),
            &frame
                .message
                .serialize(&serde_wasm_bindgen::Serializer::json_compatible())?,
        )?;
        js_sys::Reflect::set(
            &object,
            &"binary".into(),
            &js_sys::Uint8Array::from(frame.binary.as_slice()),
        )?;
        Ok(object.into())
    }
    pub fn frame_from_js(value: JsValue) -> Result<Frame, JsValue> {
        let message =
            serde_wasm_bindgen::from_value(js_sys::Reflect::get(&value, &"message".into())?)?;
        let bytes = js_sys::Reflect::get(&value, &"binary".into())?;
        let binary = if bytes.is_null() || bytes.is_undefined() {
            Vec::new()
        } else {
            bytes
                .dyn_ref::<js_sys::Uint8Array>()
                .cloned()
                .unwrap_or_else(|| js_sys::Uint8Array::new(&bytes))
                .to_vec()
        };
        let frame = Frame { message, binary };
        frame
            .validate()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(frame)
    }
    pub struct WasmHost {
        pub callback: js_sys::Function,
    }
    impl HostTransport for WasmHost {
        fn request<'a>(&'a mut self, frame: Frame) -> HostFuture<'a> {
            Box::pin(async move {
                let value =
                    frame_to_js(frame).map_err(|error| transport_error(format!("{error:?}")))?;
                let pending = self
                    .callback
                    .call1(&JsValue::NULL, &value)
                    .map_err(|error| transport_error(format!("{error:?}")))?;
                let promise = js_sys::Promise::resolve(&pending);
                let response = wasm_bindgen_futures::JsFuture::from(promise)
                    .await
                    .map_err(|error| transport_error(format!("{error:?}")))?;
                frame_from_js(response).map_err(|error| transport_error(format!("{error:?}")))
            })
        }
        fn send(&mut self, frame: Frame) -> Result<(), PluginRpcError> {
            let value =
                frame_to_js(frame).map_err(|error| transport_error(format!("{error:?}")))?;
            self.callback
                .call1(&JsValue::NULL, &value)
                .map_err(|error| transport_error(format!("{error:?}")))?;
            Ok(())
        }
    }
    pub fn callback(value: JsValue) -> Result<js_sys::Function, JsValue> {
        value.dyn_into()
    }
}

/// Export a default-constructible Rust plugin through an async wasm-bindgen wrapper.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
#[macro_export]
macro_rules! export_wasm_plugin {
    ($plugin:ty) => {
        use $crate::wasm::wasm_bindgen::prelude::*;
        #[wasm_bindgen]
        pub struct PluginWrapper {
            session: $crate::PluginSession<$plugin>,
        }
        /// A separate object deliberately avoids borrowing an active async wrapper.
        #[wasm_bindgen]
        pub struct PluginCancellationHandle {
            cancellation: $crate::RequestCancellation,
        }
        #[wasm_bindgen]
        impl PluginCancellationHandle {
            pub fn register(&self, request_id: &str) {
                self.cancellation.register(request_id);
            }
            pub fn cancel(&self, request_id: &str) {
                self.cancellation.cancel(request_id);
            }
            pub fn release(&self, request_id: &str) {
                self.cancellation.release(request_id);
            }
        }
        #[wasm_bindgen]
        impl PluginWrapper {
            #[wasm_bindgen(constructor)]
            pub fn new() -> Self {
                Self {
                    session: $crate::PluginSession::new(<$plugin>::default()),
                }
            }
            pub fn cancellation_handle(&self) -> PluginCancellationHandle {
                PluginCancellationHandle {
                    cancellation: self.session.cancellation_handle(),
                }
            }
            pub async fn dispatch(
                &mut self,
                frame: JsValue,
                host: JsValue,
            ) -> Result<JsValue, JsValue> {
                let frame = $crate::wasm::frame_from_js(frame)?;
                let mut host = $crate::wasm::WasmHost {
                    callback: $crate::wasm::callback(host)?,
                };
                let response = self
                    .session
                    .dispatch(frame, &mut host)
                    .await
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                match response {
                    Some(frame) => $crate::wasm::frame_to_js(frame),
                    None => Ok(JsValue::UNDEFINED),
                }
            }
        }
    };
}
