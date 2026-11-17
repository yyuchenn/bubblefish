//! Ephemeral panel presentation shared with the browser host. Installed files stay untouched.

const MARKER: &str = "<!-- bubblefish:panel-theme:v1 -->";
const FOUNDATION: &str = include_str!("../../src/runtime/plugins/panel-theme.css");
const BOOTSTRAP: &str = include_str!("../../src/runtime/plugins/panel-theme-bootstrap.js");
pub const PANEL_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'";

fn tag_end(html: &[u8], from: usize) -> Option<usize> {
    let mut quote = None;
    for (index, byte) in html.iter().copied().enumerate().skip(from) {
        match quote {
            Some(current) if byte == current => quote = None,
            Some(_) => {}
            None if byte == b'\'' || byte == b'"' => quote = Some(byte),
            None if byte == b'>' => return Some(index + 1),
            None => {}
        }
    }
    None
}

fn html_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

fn injection_point(html: &str) -> usize {
    let bytes = html.as_bytes();
    let mut cursor = if html.starts_with('\u{feff}') { 3 } else { 0 };
    let mut fallback = cursor;
    while cursor < bytes.len() {
        while bytes.get(cursor).copied().is_some_and(html_space) {
            cursor += 1;
        }
        if bytes[cursor..].starts_with(b"<!--") {
            let Some(end) = html[cursor + 4..].find("-->") else {
                break;
            };
            cursor += 4 + end + 3;
            continue;
        }
        let rest = &bytes[cursor..];
        let tag = ["head", "html", "!doctype"].into_iter().find(|tag| {
            let prefix = format!("<{tag}");
            rest.get(..prefix.len())
                .is_some_and(|value| value.eq_ignore_ascii_case(prefix.as_bytes()))
                && rest
                    .get(prefix.len())
                    .is_some_and(|byte| html_space(*byte) || matches!(byte, b'/' | b'>'))
        });
        let Some(tag) = tag else { break };
        let Some(end) = tag_end(bytes, cursor) else {
            break;
        };
        if tag == "head" {
            return end;
        }
        if tag == "!doctype" {
            fallback = end;
        }
        cursor = end;
    }
    fallback
}

pub fn decorate_html(body: &[u8]) -> Result<Vec<u8>, String> {
    let html =
        std::str::from_utf8(body).map_err(|_| "Plugin panel HTML must be UTF-8".to_owned())?;
    if html.contains(MARKER) {
        return Ok(body.to_vec());
    }
    let offset = injection_point(html);
    // Both shared assets are fixed host source, never plugin/theme payload interpolation.
    let styles = FOUNDATION.replace("</style", "<\\/style");
    let script = BOOTSTRAP.replace("</script", "<\\/script");
    Ok(format!("{}{MARKER}<style id=\"bf-panel-foundation\">{styles}</style><script id=\"bf-panel-theme-bootstrap\">{script}</script>{}", &html[..offset], &html[offset..]).into_bytes())
}

pub fn panel_response(body: &[u8]) -> tauri::http::Response<Vec<u8>> {
    match decorate_html(body) {
        Ok(body) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", PANEL_CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(body)
            .expect("Static plugin panel response headers"),
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"Plugin panel unavailable".to_vec())
            .expect("Static plugin panel failure headers"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_doctype_and_injects_before_plugin_code_without_rewriting_body() {
        let html = "<!DoCtYpE html><HTML lang='zh-CN'><!-- <head> fake --><HEAD data-note='a > b'><meta charset='utf-8'><script>window.legacy=true</script></HEAD><body style='margin:24px'><p>原文</p></body></HTML>";
        let decorated = String::from_utf8(decorate_html(html.as_bytes()).unwrap()).unwrap();
        assert!(decorated.starts_with(
            "<!DoCtYpE html><HTML lang='zh-CN'><!-- <head> fake --><HEAD data-note='a > b'>"
        ));
        assert!(decorated.find(MARKER).unwrap() < decorated.find("window.legacy=true").unwrap());
        assert!(decorated.contains("<body style='margin:24px'><p>原文</p></body>"));
        assert_eq!(
            decorate_html(decorated.as_bytes()).unwrap(),
            decorated.as_bytes()
        );
    }

    #[test]
    fn supports_fragments_bom_headless_docs_and_head_like_script_strings() {
        for html in [
            "<p>Settings</p>",
            "\u{feff}<!doctype html><body><p>设置</p></body>",
            "<script>const text='<head>';</script><p>状态</p>",
            "<!-- <head> --><p>设置</p>",
        ] {
            let decorated = String::from_utf8(decorate_html(html.as_bytes()).unwrap()).unwrap();
            assert!(decorated.find(MARKER).unwrap() < decorated.find("<p>").unwrap());
            assert_eq!(decorated.matches(MARKER).count(), 1);
            assert_eq!(
                decorate_html(decorated.as_bytes()).unwrap(),
                decorated.as_bytes()
            );
        }
        assert!(decorate_html(&[0xff]).is_err());
    }

    #[test]
    fn desktop_response_keeps_isolation_headers_and_uses_the_shared_assets() {
        let response =
            panel_response(b"<!doctype html><html><head></head><body>Settings</body></html>");
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Security-Policy"], PANEL_CSP);
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        let body = std::str::from_utf8(response.body()).unwrap();
        assert!(body.contains("event.ports[1]"));
        assert!(body.contains("appearance-ready"));
        assert!(body.contains("--bf-panel-background"));
        assert!(!PANEL_CSP.contains("allow-same-origin"));
        assert!(PANEL_CSP.contains("connect-src 'none'"));
        assert_eq!(panel_response(&[0xff]).status(), 404);
    }
}
