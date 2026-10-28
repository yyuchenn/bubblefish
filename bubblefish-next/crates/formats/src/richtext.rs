//! BF 1.0 inline notation: `[text](\\加粗\\斜体\\划掉\\重点)`.
//! Unknown or ambiguous markup is retained literally with its original bytes.
use bubblefish_core::{CoreError, RichText, TextMark, TextRun};

fn ordered(marks: &[TextMark]) -> Vec<TextMark> {
    [
        TextMark::Bold,
        TextMark::Italic,
        TextMark::Strike,
        TextMark::Emphasis,
    ]
    .into_iter()
    .filter(|mark| marks.contains(mark))
    .collect()
}

fn normalized(runs: &[TextRun]) -> Vec<TextRun> {
    let mut result: Vec<TextRun> = Vec::new();
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        let marks = ordered(&run.marks);
        if let Some(previous) = result.last_mut().filter(|previous| previous.marks == marks) {
            previous.text.push_str(&run.text);
        } else {
            result.push(TextRun {
                text: run.text.clone(),
                marks,
            });
        }
    }
    result
}

fn literal(source: &str) -> RichText {
    RichText {
        runs: if source.is_empty() {
            Vec::new()
        } else {
            vec![TextRun {
                text: source.to_owned(),
                marks: Vec::new(),
            }]
        },
        raw: Some(source.to_owned()),
    }
}

fn parse_marks(mut source: &str) -> Option<Vec<TextMark>> {
    let mut marks = Vec::new();
    while !source.is_empty() {
        let (token, mark) = [
            ("\\加粗", TextMark::Bold),
            ("\\斜体", TextMark::Italic),
            ("\\划掉", TextMark::Strike),
            ("\\重点", TextMark::Emphasis),
        ]
        .into_iter()
        .find(|(token, _)| source.starts_with(token))?;
        if marks.contains(&mark) {
            return None;
        }
        marks.push(mark);
        source = &source[token.len()..];
    }
    if marks.is_empty() {
        None
    } else {
        Some(ordered(&marks))
    }
}

pub fn parse_legacy_text(source: &str) -> RichText {
    let mut runs = Vec::new();
    let mut start = 0;
    let mut scan = 0;
    while let Some(relative) = source[scan..].find('[') {
        let open = scan + relative;
        let Some(close_relative) = source[open + 1..].find(']') else {
            break;
        };
        let close = open + 1 + close_relative;
        if !source[close + 1..].starts_with('(') {
            scan = open + 1;
            continue;
        }
        let Some(end_relative) = source[close + 2..].find(')') else {
            return literal(source);
        };
        let end = close + 2 + end_relative;
        let Some(marks) = parse_marks(&source[close + 2..end]) else {
            return literal(source);
        };
        if close == open + 1 {
            return literal(source);
        }
        if open > start {
            runs.push(TextRun {
                text: source[start..open].to_owned(),
                marks: Vec::new(),
            });
        }
        runs.push(TextRun {
            text: source[open + 1..close].to_owned(),
            marks,
        });
        start = end + 1;
        scan = start;
    }
    if start < source.len() {
        runs.push(TextRun {
            text: source[start..].to_owned(),
            marks: Vec::new(),
        });
    }
    RichText {
        runs: normalized(&runs),
        raw: None,
    }
}

pub fn export_legacy_text(text: &RichText) -> Result<String, CoreError> {
    let runs = normalized(&text.runs);
    if let Some(raw) = &text.raw {
        if normalized(&parse_legacy_text(raw).runs) == runs {
            return Ok(raw.clone());
        }
    }
    let mut result = String::new();
    for run in &runs {
        if run.marks.is_empty() {
            result.push_str(&run.text);
        } else {
            if run.text.contains(']') {
                return Err(crate::cannot_export("BF 1.0 cannot represent a formatted ']' character; remove formatting from that character"));
            }
            result.push('[');
            result.push_str(&run.text);
            result.push_str("](");
            for mark in &run.marks {
                result.push_str(match mark {
                    TextMark::Bold => "\\加粗",
                    TextMark::Italic => "\\斜体",
                    TextMark::Strike => "\\划掉",
                    TextMark::Emphasis => "\\重点",
                });
            }
            result.push(')');
        }
    }
    // Compare semantic runs to catch plain text accidentally becoming legacy markup,
    // including delimiters assembled across two adjacent runs.
    let decoded = parse_legacy_text(&result);
    if normalized(&decoded.runs) != runs || decoded.raw.is_some() {
        return Err(crate::cannot_export("Text contains a legacy formatting delimiter that cannot be exported without changing its meaning"));
    }
    Ok(result)
}
