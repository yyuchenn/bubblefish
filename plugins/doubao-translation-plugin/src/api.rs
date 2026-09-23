use serde::Serialize;
use serde_json::Value;

pub const API_ENDPOINT: &str = "https://ark.cn-beijing.volces.com/api/v3/responses";

#[derive(Debug, Serialize)]
pub struct ResponseRequest<'a> {
    model: &'a str,
    input: [InputMessage<'a>; 2],
    thinking: ThinkingConfig,
    stream: bool,
    store: bool,
}

#[derive(Debug, Serialize)]
struct InputMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct ThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: &'static str,
}

pub fn build_request<'a>(
    model: &'a str,
    system_prompt: &'a str,
    text: &'a str,
) -> ResponseRequest<'a> {
    ResponseRequest {
        model,
        input: [
            InputMessage {
                role: "system",
                content: system_prompt,
            },
            InputMessage {
                role: "user",
                content: text,
            },
        ],
        thinking: ThinkingConfig {
            thinking_type: "disabled",
        },
        stream: false,
        store: false,
    }
}

fn body_summary(body: &str) -> String {
    let mut chars = body.trim().chars();
    let summary: String = chars.by_ref().take(300).collect();
    if chars.next().is_some() {
        format!("{summary}…")
    } else {
        summary
    }
}

fn error_message(error: &Value) -> Option<String> {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str));
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str());
    match (code, message) {
        (Some(code), Some(message)) => Some(format!("{code}: {message}")),
        (Some(code), None) => Some(code.into()),
        (None, Some(message)) => Some(message.into()),
        _ => None,
    }
}

/// Parse the raw Responses API body, including errors returned with HTTP 200.
pub fn parse_response(status: u16, body: &str) -> Result<String, String> {
    let parsed = serde_json::from_str::<Value>(body);
    if !(200..300).contains(&status) {
        let detail = parsed
            .as_ref()
            .ok()
            .and_then(|value| error_message(value.get("error").unwrap_or(value)))
            .unwrap_or_else(|| body_summary(body));
        return Err(format!("Doubao API HTTP {status}: {detail}"));
    }

    let response =
        parsed.map_err(|error| format!("Invalid Doubao API response (HTTP {status}): {error}"))?;
    if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
        return Err(format!(
            "Doubao API error: {}",
            error_message(error).unwrap_or_else(|| body_summary(&error.to_string()))
        ));
    }
    let response_status = response
        .get("status")
        .and_then(Value::as_str)
        .ok_or("Doubao API response is missing its status")?;
    if response_status != "completed" {
        let reason = response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str);
        return Err(match reason {
            Some(reason) => format!("Doubao response {response_status}: {reason}"),
            None => format!("Doubao response is {response_status}"),
        });
    }

    let output = response
        .get("output")
        .and_then(Value::as_array)
        .ok_or("Doubao API response is missing its output")?;
    let mut text = String::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("message")
            || item.get("role").and_then(Value::as_str) != Some("assistant")
        {
            continue;
        }
        if let Some(status) = item.get("status").and_then(Value::as_str) {
            if status != "completed" {
                return Err(format!("Doubao output message is {status}"));
            }
        }
        if let Some(content) = item.get("content").and_then(Value::as_array) {
            for part in content {
                match part.get("type").and_then(Value::as_str) {
                    Some("output_text") => text.push_str(
                        part.get("text")
                            .and_then(Value::as_str)
                            .ok_or("Doubao output_text is missing its text")?,
                    ),
                    Some("refusal") => return Err("Doubao refused the translation request".into()),
                    _ => {}
                }
            }
        }
    }
    if text.trim().is_empty() {
        return Err("Doubao API returned no translated text".into());
    }
    Ok(text)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn send_request(
    endpoint: &str,
    api_key: &str,
    request: &ResponseRequest<'_>,
) -> Result<String, String> {
    let response = reqwest::blocking::Client::new()
        .post(endpoint)
        .bearer_auth(api_key)
        .json(request)
        .send()
        .map_err(|error| format!("Request failed: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|error| format!("Failed to read response: {error}"))?;
    parse_response(status, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn completed(content: Value) -> Value {
        json!({ "status": "completed", "output": [{
            "type": "message", "role": "assistant", "status": "completed", "content": content
        }] })
    }

    #[test]
    fn request_uses_stateless_responses_protocol() {
        let request =
            serde_json::to_value(build_request("model", "翻译提示", "Hello\n\"world\"!")).unwrap();
        assert_eq!(
            request,
            json!({
                "model": "model", "input": [
                    { "role": "system", "content": "翻译提示" },
                    { "role": "user", "content": "Hello\n\"world\"!" }
                ], "thinking": { "type": "disabled" }, "stream": false, "store": false
            })
        );
    }

    #[test]
    fn extracts_only_assistant_output_text_in_order() {
        let body = json!({ "status": "completed", "output": [
            { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "private" }] },
            { "type": "function_call", "arguments": "{}" },
            { "type": "message", "role": "user", "content": [{ "type": "output_text", "text": "input" }] },
            { "type": "message", "role": "assistant", "content": [
                { "type": "output_text", "text": "你好，" }, { "type": "output_text", "text": "世界！\n" }
            ] },
            { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "下一行" }] }
        ] });
        assert_eq!(
            parse_response(200, &body.to_string()).unwrap(),
            "你好，世界！\n下一行"
        );
    }

    #[test]
    fn rejects_empty_malformed_refused_and_incomplete_results() {
        for response in [
            json!({ "status": "completed", "output": [] }),
            json!({ "status": "completed" }),
            json!({ "output": [] }),
            completed(json!([])),
            completed(json!([{ "type": "output_text", "text": " \n " }])),
            completed(json!([{ "type": "output_text" }])),
            completed(json!([{ "type": "refusal", "refusal": "Cannot translate" }])),
            json!({ "status": "failed", "output": [] }),
            json!({ "status": "in_progress", "output": [] }),
            json!({ "status": "incomplete", "incomplete_details": { "reason": "max_output_tokens" },
                "output": [{ "type": "message", "role": "assistant", "content": [{"type":"output_text","text":"partial"}] }] }),
        ] {
            assert!(
                parse_response(200, &response.to_string()).is_err(),
                "{response}"
            );
        }
        assert!(parse_response(200, "not JSON").is_err());
    }

    #[test]
    fn preserves_api_errors_and_http_status() {
        let body =
            json!({ "error": { "code": "AccessDenied", "message": "Model is not enabled" } })
                .to_string();
        for status in [401, 403, 429, 500, 502, 503] {
            let error = parse_response(status, &body).unwrap_err();
            assert!(error.contains(&status.to_string()));
            assert!(error.contains("AccessDenied: Model is not enabled"));
        }
        assert!(parse_response(200, &body)
            .unwrap_err()
            .contains("AccessDenied: Model is not enabled"));
        assert!(
            parse_response(400, r#"{"code":"BadRequest","message":"Invalid model"}"#)
                .unwrap_err()
                .contains("BadRequest: Invalid model")
        );
    }

    #[test]
    fn non_json_http_error_has_a_bounded_unicode_summary() {
        let error = parse_response(502, &"故障".repeat(500)).unwrap_err();
        assert!(error.starts_with("Doubao API HTTP 502: 故障"));
        assert!(error.ends_with('…'));
        assert!(error.chars().count() < 350);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_transport_sends_authenticated_json_and_handles_errors() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        for status in [200, 401] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/api/v3/responses", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let header_end = loop {
                    let mut byte = [0u8; 1];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break request.len();
                    }
                };
                let headers = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(headers.starts_with("post /api/v3/responses http/1.1"));
                assert!(headers.contains("authorization: bearer test-api-key\r\n"));
                assert!(headers.contains("content-type: application/json\r\n"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!(header_end > 0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["input"][1]["content"], "Hello");
                assert_eq!(body["store"], false);
                let response = if status == 200 {
                    completed(json!([{ "type": "output_text", "text": "你好" }])).to_string()
                } else {
                    json!({ "error": { "code": "Unauthorized", "message": "Invalid key" } })
                        .to_string()
                };
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            });
            let result = send_request(
                &endpoint,
                "test-api-key",
                &build_request("model", "Translate", "Hello"),
            );
            server.join().unwrap();
            if status == 200 {
                assert_eq!(result.unwrap(), "你好");
            } else {
                assert!(result
                    .unwrap_err()
                    .contains("HTTP 401: Unauthorized: Invalid key"));
            }
        }
    }
}
