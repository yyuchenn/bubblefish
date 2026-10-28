use bubblefish_core::{Engine, Envelope, ProjectDocument, Reply};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    envelopes: Vec<Envelope>,
    replies: Vec<Reply>,
    documents: Vec<ProjectDocument>,
}

#[test]
fn native_runtime_matches_shared_golden_trajectory() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/runtime-trace.json")).unwrap();
    assert_eq!(fixture.envelopes.len(), fixture.replies.len());
    let mut engine = Engine::new();
    for (index, (envelope, expected)) in fixture
        .envelopes
        .into_iter()
        .zip(fixture.replies)
        .enumerate()
    {
        assert_eq!(
            engine.dispatch(envelope),
            expected,
            "trajectory step {index}"
        );
    }
    for expected in fixture.documents {
        assert_eq!(engine.document(&expected.id).unwrap(), expected);
    }
}
