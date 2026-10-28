//! Explicit golden-fixture authoring tool. Normal tests only read the fixture.
use bubblefish_core::*;
use serde_json::{json, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let document = json!({"id":"project-a","name":"试验😀","sourceLanguage":"japanese","targetLanguage":"simplifiedChinese","images":[
        {"id":"page-a","assetId":"asset-a","filename":"001.png","width":1200,"height":1800,"markers":[]},
        {"id":"page-b","assetId":"asset-b","filename":"002.png","width":1200,"height":1800,"markers":[]}
    ]});
    let marker = json!({"id":"marker-a","geometry":{"type":"point","x":0.25,"y":0.5},"translation":{"runs":[]},"style":{"overlayText":false,"horizontal":false},"bunnyCache":{"text":"原文"}});
    let history = |anchor, head| json!({"groupId":"ime-a","label":"输入译文","before":{"imageId":"page-a","markerId":"marker-a","anchor":anchor,"head":anchor,"storedMarks":[]},"after":{"imageId":"page-a","markerId":"marker-a","anchor":head,"head":1,"storedMarks":["bold"]}});
    let canvas_context = json!({"imageId":"page-a","markerId":"marker-a","anchor":1,"head":1,"storedMarks":[],"focusEditor":false});
    let commands: Vec<(Value, Option<Value>)> = vec![
        (
            json!({"type":"createProject","document":document,"saved":true}),
            None,
        ),
        (
            json!({"type":"addMarker","imageId":"page-a","marker":marker}),
            None,
        ),
        (
            json!({"type":"updateMarker","imageId":"page-a","markerId":"marker-a","translation":{"runs":[{"text":"中","marks":["bold"]}]}}),
            Some(history(1, 2)),
        ),
        (
            json!({"type":"updateMarker","imageId":"page-a","markerId":"marker-a","translation":{"runs":[{"text":"中文😀\nnext","marks":["bold","emphasis"]}]}}),
            Some(history(2, 10)),
        ),
        (json!({"type":"endGroup"}), None),
        (
            json!({"type":"reorderImages","imageIds":["page-b","page-a"]}),
            None,
        ),
        (
            json!({"type":"updateMarker","imageId":"page-a","markerId":"marker-a","geometry":{"type":"rectangle","x":0.2,"y":0.3,"width":0.25,"height":0.4},"style":{"overlayText":true,"horizontal":true}}),
            Some(json!({"label":"调整标记","before":canvas_context,"after":canvas_context})),
        ),
        (json!({"type":"markSaved","stateId":"project-a:4"}), None),
        (
            json!({"type":"removeImage","imageId":"page-a"}),
            Some(
                json!({"label":"删除图片","before":canvas_context,"after":{"imageId":"page-b","markerId":"","anchor":1,"head":1,"storedMarks":[],"focusEditor":false}}),
            ),
        ),
        (json!({"type":"undo"}), None),
        (json!({"type":"undo"}), None),
        (json!({"type":"redo"}), None),
        (
            json!({"type":"reorderImages","imageIds":["page-a","page-a"]}),
            None,
        ),
        (json!({"type":"updateProject","name":"分支"}), None),
        (json!({"type":"redo"}), None),
    ];
    let mut engine = Engine::new();
    let mut envelopes = Vec::new();
    let mut replies = Vec::new();
    for (index, (command, history)) in commands.into_iter().enumerate() {
        let mut value = json!({"commandId":format!("cmd-{index}"),"sessionId":"fixture-session","projectId":"project-a","command":command});
        if let Some(history) = history {
            value["history"] = history;
        }
        let envelope: Envelope = serde_json::from_value(value)?;
        replies.push(engine.dispatch(envelope.clone()));
        envelopes.push(envelope);
    }
    // The same command ID must return its original acknowledgement, even after
    // later history operations. This catches host-level retry discrepancies.
    envelopes.push(envelopes[3].clone());
    replies.push(engine.dispatch(envelopes.last().unwrap().clone()));
    let fixture = json!({
        "description":"Identical native and WASM command trajectory; fixture updates are explicit.",
        "envelopes":envelopes,"replies":replies,"documents":[engine.document("project-a")?]
    });
    let output = format!("{}\n", serde_json::to_string_pretty(&fixture)?);
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, output)?;
    } else {
        print!("{output}");
    }
    Ok(())
}
