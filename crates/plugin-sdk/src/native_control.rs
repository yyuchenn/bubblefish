//! A dedicated input/control plane keeps cancellation responsive while the plugin
//! actor is inside synchronous inference. Ordinary dispatch and host calls stay serial.
use crate::*;
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    sync::mpsc::{self, Receiver},
};

struct ControlTransport<W> {
    input: Receiver<io::Result<Option<Frame>>>,
    writer: W,
    pending: VecDeque<Frame>,
}
impl<W: Write> ControlTransport<W> {
    fn receive(&self) -> io::Result<Option<Frame>> {
        self.input.recv().unwrap_or(Ok(None))
    }
    fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(Some(frame));
        }
        self.receive()
    }
}
impl<W: Write> HostTransport for ControlTransport<W> {
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
            self.send(frame)?;
            loop {
                let response = self.receive().map_err(transport_error)?.ok_or_else(|| {
                    PluginRpcError::new("hostDisconnected", "Host closed the plugin connection")
                })?;
                if matches!(&response.message, PluginMessage::Response(message) if message.id == id)
                {
                    // Even cancelled requests must consume outstanding mutation ACKs.
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

/// Run an owned reader on a control thread. The plugin and writer need not be Send;
/// only reading and setting cancellation tokens happens outside the serial actor.
pub fn serve_with_control<P: Plugin, R: Read + Send + 'static, W: Write>(
    plugin: P,
    mut reader: R,
    writer: W,
) -> Result<(), PluginRpcError> {
    let mut session = PluginSession::new(plugin);
    let cancellation = session.cancellation_handle();
    // A bounded producer could block before reading the cancellation immediately
    // behind ordinary requests. The trusted host owns the request queue limits.
    let (send, input) = mpsc::channel();
    std::thread::Builder::new()
        .name("bubblefish-plugin-input".into())
        .spawn(move || loop {
            let result = read_frame(&mut reader);
            if let Ok(Some(frame)) = &result {
                match &frame.message {
                    PluginMessage::Request(request) => cancellation.register(&request.id),
                    PluginMessage::Event(event) if event.event == "$cancel" => {
                        if let Some(id) = event.data.get("requestId").and_then(Value::as_str) {
                            cancellation.cancel(id);
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            let done = !matches!(&result, Ok(Some(_)));
            if send.send(result).is_err() || done {
                break;
            }
        })
        .map_err(transport_error)?;
    let mut transport = ControlTransport {
        input,
        writer,
        pending: VecDeque::new(),
    };
    while let Some(frame) = transport.next_frame().map_err(transport_error)? {
        if let Some(response) = native::block_on(session.dispatch(frame, &mut transport))? {
            transport.send(response)?;
        }
    }
    Ok(())
}
