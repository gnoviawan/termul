//! `graph::apply_ops` against `src/shared/types/__fixtures__/automation-ops.json`.
//! The canvas's TypeScript mirror (`canvas/draft/apply-op.ts`) runs the same
//! file, so the two cannot drift.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use super::graph::{apply_ops, validate, OpError};
use super::model::{Automation, Edge, EdgeSource, Graph, Isolation, IssueCode, Op, Trigger};

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct Doc {
    name: String,
    trigger: Trigger,
    isolation: Isolation,
    graph: Graph,
}

#[derive(Debug, Deserialize)]
struct Rejection {
    code: String,
    index: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ApplyCase {
    name: String,
    ops: Value,
    expect: Option<Doc>,
    reject: Option<Rejection>,
}

#[derive(Debug, Deserialize)]
struct ConnectCase {
    name: String,
    #[serde(default)]
    ops: Vec<Op>,
    edge: Edge,
    refuse: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    start: Doc,
    apply: Vec<ApplyCase>,
    connect: Vec<ConnectCase>,
}

fn fixture() -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/shared/types/__fixtures__/automation-ops.json");
    let text = std::fs::read_to_string(&path).expect("read automation-ops.json");
    serde_json::from_str(&text).expect("parse automation-ops.json")
}

fn automation(doc: &Doc) -> Automation {
    let mut a = Automation::new("project-1".into(), doc.name.clone(), 1_000);
    a.trigger = doc.trigger.clone();
    a.isolation = doc.isolation;
    a.graph = doc.graph.clone();
    a
}

fn doc_of(a: &Automation) -> Doc {
    Doc {
        name: a.name.clone(),
        trigger: a.trigger.clone(),
        isolation: a.isolation,
        graph: a.graph.clone(),
    }
}

/// The fixture's name for an `OpError`, and the op index it carries.
fn code(error: &OpError) -> (&'static str, Option<usize>) {
    match error {
        OpError::EmptyBatch => ("empty_batch", None),
        OpError::NodeExists { index, .. } => ("node_exists", Some(*index)),
        OpError::NodeNotFound { index, .. } => ("node_not_found", Some(*index)),
        OpError::EdgeExists { index } => ("edge_exists", Some(*index)),
        OpError::EdgeNotFound { index } => ("edge_not_found", Some(*index)),
        OpError::EmptyName { index } => ("empty_name", Some(*index)),
    }
}

#[test]
fn apply_ops_matches_every_fixture_case() {
    let fixture = fixture();
    let start = automation(&fixture.start);
    assert!(fixture.apply.len() >= 20, "the fixture lost its cases");
    for case in &fixture.apply {
        let parsed = serde_json::from_value::<Vec<Op>>(case.ops.clone());
        match (&case.expect, &case.reject) {
            (Some(expected), None) => {
                let ops = parsed.unwrap_or_else(|e| panic!("{}: ops do not parse: {e}", case.name));
                let next = apply_ops(&start, &ops)
                    .unwrap_or_else(|e| panic!("{}: refused with {e}", case.name));
                assert_eq!(&doc_of(&next), expected, "{}", case.name);
                assert_eq!(next.revision, start.revision + 1, "{}", case.name);
            }
            (None, Some(reject)) if reject.code == "invalid_node_id" => {
                assert!(
                    parsed.is_err(),
                    "{}: the host must refuse the node id while parsing",
                    case.name
                );
            }
            (None, Some(reject)) => {
                let ops = parsed.unwrap_or_else(|e| panic!("{}: ops do not parse: {e}", case.name));
                let error = apply_ops(&start, &ops)
                    .expect_err(&format!("{}: expected a refusal", case.name));
                assert_eq!(
                    code(&error),
                    (reject.code.as_str(), reject.index),
                    "{}",
                    case.name
                );
            }
            _ => panic!(
                "{}: a case needs exactly one of expect and reject",
                case.name
            ),
        }
    }
}

#[test]
fn connect_refusals_match_what_the_host_flags() {
    let fixture = fixture();
    let start = automation(&fixture.start);
    for case in &fixture.connect {
        let mut ops = case.ops.clone();
        ops.push(Op::Connect {
            edge: case.edge.clone(),
        });
        let refuse = case.refuse.as_deref();
        if refuse == Some("duplicate_edge") {
            let error =
                apply_ops(&start, &ops).expect_err(&format!("{}: expected edge_exists", case.name));
            assert!(
                matches!(error, OpError::EdgeExists { .. }),
                "{}: {error}",
                case.name
            );
            continue;
        }
        let next =
            apply_ops(&start, &ops).unwrap_or_else(|e| panic!("{}: refused with {e}", case.name));
        let source = match &case.edge.from {
            EdgeSource::Trigger => None,
            EdgeSource::Node(id) => Some(id.clone()),
        };
        let flagged = |code: IssueCode| {
            validate(&next).into_iter().any(|issue| {
                issue.code == code
                    && match code {
                        IssueCode::IllegalPort => issue.node_id == source,
                        IssueCode::UnknownEdgeEndpoint => {
                            issue.node_id.as_ref() == Some(&case.edge.to)
                        }
                        _ => true,
                    }
            })
        };
        let illegal = flagged(IssueCode::IllegalPort);
        let cycle = flagged(IssueCode::Cycle);
        let unknown = flagged(IssueCode::UnknownEdgeEndpoint);
        let expected = match refuse {
            None => (false, false, false),
            Some("illegal_port") => (true, false, false),
            Some("cycle") => (false, true, false),
            Some("unknown_node") => (false, false, true),
            Some(other) => panic!("{}: unknown refusal {other}", case.name),
        };
        assert_eq!(
            (illegal, cycle, unknown),
            expected,
            "{}: (illegal_port, cycle, unknown_edge_endpoint)",
            case.name
        );
    }
}
