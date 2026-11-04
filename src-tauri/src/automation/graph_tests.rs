use serde_json::json;

use super::graph::{apply_ops, topo_order, untrusted_flow, validate, OpError};
use super::model::{Automation, IssueCode};
use super::test_support::{apply, node_id, ops, sample_automation};

fn codes(a: &Automation) -> Vec<(IssueCode, Option<String>)> {
    validate(a)
        .into_iter()
        .map(|i| (i.code, i.node_id.map(|n| n.to_string())))
        .collect()
}

fn at(code: IssueCode, node: &str) -> (IssueCode, Option<String>) {
    (code, Some(node.to_string()))
}

fn set_spec(a: &Automation, id: &str, spec: serde_json::Value) -> Automation {
    apply(a, json!([{ "op": "update_node", "id": id, "spec": spec }]))
}

#[test]
fn the_sample_automation_has_no_issues() {
    assert_eq!(codes(&sample_automation()), vec![]);
}

#[test]
fn rule1_duplicate_node_ids() {
    let mut a = sample_automation();
    let copy = a.graph.nodes[5].clone();
    a.graph.nodes.push(copy);
    assert_eq!(codes(&a), vec![at(IssueCode::DuplicateNodeId, "alert")]);
}

#[test]
fn rule2_edges_need_known_endpoints_and_legal_ports() {
    let a = apply(
        &sample_automation(),
        json!([
            { "op": "connect", "edge": { "from": "post", "port": "out", "to": "ghost" } },
            { "op": "connect", "edge": { "from": "alert", "port": "out", "to": "post" } },
            { "op": "connect", "edge": { "from": "check", "port": "out", "to": "post" } }
        ]),
    );
    assert_eq!(
        codes(&a),
        vec![
            at(IssueCode::UnknownEdgeEndpoint, "ghost"),
            at(IssueCode::IllegalPort, "alert"),
            at(IssueCode::IllegalPort, "check"),
        ]
    );
}

#[test]
fn rule2_exactly_one_trigger_edge() {
    let two = apply(
        &sample_automation(),
        json!([{ "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "alert" } }]),
    );
    assert_eq!(codes(&two), vec![(IssueCode::TriggerEdgeCount, None)]);
    let error_port = apply(
        &sample_automation(),
        json!([
            { "op": "disconnect", "edge": { "from": "trigger", "port": "out", "to": "fetch" } },
            { "op": "connect", "edge": { "from": "trigger", "port": "error", "to": "fetch" } }
        ]),
    );
    assert_eq!(codes(&error_port), vec![(IssueCode::IllegalPort, None)]);
}

#[test]
fn rule3_cycles_and_unreachable_nodes() {
    let cyclic = apply(
        &sample_automation(),
        json!([{ "op": "connect", "edge": { "from": "shape", "port": "out", "to": "extract" } }]),
    );
    assert_eq!(
        codes(&cyclic),
        vec![
            at(IssueCode::Cycle, "extract"),
            at(IssueCode::Cycle, "check"),
            at(IssueCode::Cycle, "shape"),
        ]
    );
    let orphan = apply(
        &sample_automation(),
        json!([{ "op": "add_node", "node": { "id": "orphan", "label": "", "spec": { "kind": "transform", "fields": [] } } }]),
    );
    assert_eq!(codes(&orphan), vec![at(IssueCode::Unreachable, "orphan")]);
    let unplugged = apply(
        &sample_automation(),
        json!([{ "op": "disconnect", "edge": { "from": "trigger", "port": "out", "to": "fetch" } }]),
    );
    assert_eq!(
        codes(&unplugged),
        vec![
            (IssueCode::TriggerEdgeCount, None),
            at(IssueCode::Unreachable, "fetch"),
            at(IssueCode::Unreachable, "extract"),
            at(IssueCode::Unreachable, "check"),
            at(IssueCode::Unreachable, "shape"),
            at(IssueCode::Unreachable, "post"),
            at(IssueCode::Unreachable, "alert"),
        ]
    );
}

#[test]
fn rule4_node_references_must_be_ancestors() {
    let a = set_spec(
        &sample_automation(),
        "alert",
        json!({ "kind": "fail", "message": "{{nodes.extract.output.summary}} {{nodes.ghost.output}} {{nodes.alert.output}}" }),
    );
    assert_eq!(
        codes(&a),
        vec![
            at(IssueCode::NonAncestorReference, "alert"),
            at(IssueCode::UnknownNodeReference, "alert"),
            at(IssueCode::NonAncestorReference, "alert"),
        ]
    );
}

#[test]
fn rule5_secrets_only_in_http_nodes() {
    let base = sample_automation();
    let prompt = set_spec(
        &base,
        "extract",
        json!({ "kind": "agent", "agent_id": "claude", "prompt": "use {{secrets.API_KEY}}",
                "output_schema": { "type": "string" }, "timeout_ms": 1000, "max_attempts": 1 }),
    );
    let transform = set_spec(
        &base,
        "shape",
        json!({ "kind": "transform", "fields": [{ "name": "k", "value": "{{secrets.API_KEY}}" }] }),
    );
    let condition = set_spec(
        &base,
        "check",
        json!({ "kind": "condition", "left": "{{secrets.API_KEY}}", "op": "exists" }),
    );
    let fail = set_spec(
        &base,
        "alert",
        json!({ "kind": "fail", "message": "{{secrets.API_KEY}}" }),
    );
    assert_eq!(
        codes(&prompt),
        vec![at(IssueCode::SecretNotAllowed, "extract")]
    );
    assert_eq!(
        codes(&transform),
        vec![at(IssueCode::SecretNotAllowed, "shape")]
    );
    assert_eq!(
        codes(&condition),
        vec![at(IssueCode::SecretNotAllowed, "check")]
    );
    assert_eq!(codes(&fail), vec![at(IssueCode::SecretNotAllowed, "alert")]);
}

fn post_with(url: &str, allowed: serde_json::Value) -> Automation {
    set_spec(
        &sample_automation(),
        "post",
        json!({ "kind": "http", "method": "POST", "url": url, "allowed_hosts": allowed }),
    )
}

#[test]
fn rule6_http_hosts() {
    let allow = json!(["hooks.example.com"]);
    assert_eq!(
        codes(&post_with("https://evil.example.net/x", allow.clone())),
        vec![at(IssueCode::HostNotAllowed, "post")]
    );
    assert_eq!(
        codes(&post_with(
            "https://HOOKS.example.com/{{nodes.shape.output.text}}",
            allow.clone()
        )),
        vec![]
    );
    assert_eq!(
        codes(&post_with(
            "https://{{nodes.shape.output.host}}/x",
            json!([])
        )),
        vec![at(IssueCode::TemplatedHostWithoutAllowlist, "post")]
    );
    assert_eq!(
        codes(&post_with("{{nodes.shape.output.url}}", json!([]))),
        vec![at(IssueCode::TemplatedHostWithoutAllowlist, "post")]
    );
    assert_eq!(
        codes(&post_with(
            "https://{{nodes.shape.output.host}}/x",
            allow.clone()
        )),
        vec![]
    );
    assert_eq!(
        codes(&post_with("ftp://hooks.example.com/x", allow.clone())),
        vec![at(IssueCode::InvalidUrl, "post")]
    );
    assert_eq!(
        codes(&post_with("not a url", allow)),
        vec![at(IssueCode::InvalidUrl, "post")]
    );
}

#[test]
fn rule7_agent_schema_and_bounds() {
    let a = set_spec(
        &sample_automation(),
        "extract",
        json!({ "kind": "agent", "agent_id": "claude", "prompt": "{{nodes.fetch.output}}",
                "output_schema": { "type": "object", "format": "x" }, "timeout_ms": 900001, "max_attempts": 4 }),
    );
    assert_eq!(
        codes(&a),
        vec![
            at(IssueCode::InvalidOutputSchema, "extract"),
            at(IssueCode::AgentTimeoutOutOfRange, "extract"),
            at(IssueCode::AgentMaxAttemptsOutOfRange, "extract"),
        ]
    );
}

#[test]
fn rule8_untrusted_flow_needs_get_data_reaching_an_agent_with_http_downstream() {
    let base = sample_automation();
    assert!(untrusted_flow(&base.graph));
    let post_fetch = set_spec(
        &base,
        "fetch",
        json!({ "kind": "http", "method": "POST", "url": "https://api.example.com/items",
                "allowed_hosts": ["api.example.com"] }),
    );
    assert!(!untrusted_flow(&post_fetch.graph));
    let no_http_after = apply(&base, json!([{ "op": "remove_node", "id": "post" }]));
    assert!(!untrusted_flow(&no_http_after.graph));
}

#[test]
fn other_issues_templates_conditions_and_schedules() {
    let bad_template = set_spec(
        &sample_automation(),
        "alert",
        json!({ "kind": "fail", "message": "{{ nope" }),
    );
    assert_eq!(
        codes(&bad_template),
        vec![at(IssueCode::InvalidTemplate, "alert")]
    );
    let no_right = set_spec(
        &sample_automation(),
        "check",
        json!({ "kind": "condition", "left": "{{nodes.extract.output.urgent}}", "op": "gt" }),
    );
    assert_eq!(
        codes(&no_right),
        vec![at(IssueCode::MissingConditionOperand, "check")]
    );
    let bad_schedule = apply(
        &sample_automation(),
        json!([{ "op": "set_trigger", "trigger": { "kind": "schedule",
            "schedule": { "kind": "cron", "expr": "61 * * * *", "timezone": "UTC" } } }]),
    );
    assert_eq!(
        codes(&bad_schedule),
        vec![(IssueCode::InvalidSchedule, None)]
    );
}

#[test]
fn apply_ops_is_atomic_and_bumps_revision_once() {
    let base = sample_automation();
    let next = apply_ops(
        &base,
        &ops(json!([
            { "op": "rename", "name": "Evening digest" },
            { "op": "set_isolation", "isolation": "worktree_per_run" },
            { "op": "update_node", "id": "alert", "label": "Alert" }
        ])),
    )
    .unwrap();
    assert_eq!((next.revision, next.name.as_str()), (2, "Evening digest"));
    assert_eq!(next.graph.nodes[5].label, "Alert");
    assert_eq!(
        apply_ops(
            &base,
            &ops(json!([
                { "op": "rename", "name": "Changed" },
                { "op": "add_node", "node": { "id": "fetch", "label": "", "spec": { "kind": "fail", "message": "x" } } }
            ]))
        ),
        Err(OpError::NodeExists {
            index: 1,
            id: node_id("fetch")
        })
    );
    assert_eq!(apply_ops(&base, &[]), Err(OpError::EmptyBatch));
    assert_eq!(
        apply_ops(&base, &ops(json!([{ "op": "remove_node", "id": "ghost" }]))),
        Err(OpError::NodeNotFound {
            index: 0,
            id: node_id("ghost")
        })
    );
    assert_eq!(
        apply_ops(
            &base,
            &ops(
                json!([{ "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "fetch" } }])
            )
        ),
        Err(OpError::EdgeExists { index: 0 })
    );
    assert_eq!(
        apply_ops(
            &base,
            &ops(
                json!([{ "op": "disconnect", "edge": { "from": "post", "port": "out", "to": "fetch" } }])
            )
        ),
        Err(OpError::EdgeNotFound { index: 0 })
    );
    assert_eq!(
        apply_ops(&base, &ops(json!([{ "op": "rename", "name": "  " }]))),
        Err(OpError::EmptyName { index: 0 })
    );
}

#[test]
fn remove_node_drops_its_edges() {
    let a = apply(
        &sample_automation(),
        json!([{ "op": "remove_node", "id": "check" }]),
    );
    let edges: Vec<(String, String)> = a
        .graph
        .edges
        .iter()
        .map(|e| (String::from(e.from.clone()), e.to.to_string()))
        .collect();
    assert_eq!(
        edges,
        vec![
            ("trigger".into(), "fetch".into()),
            ("fetch".into(), "extract".into()),
            ("fetch".into(), "alert".into()),
            ("shape".into(), "post".into()),
        ]
    );
}

#[test]
fn topo_order_follows_edges_then_declaration_order() {
    let order: Vec<String> = topo_order(&sample_automation().graph)
        .unwrap()
        .into_iter()
        .map(|n| n.to_string())
        .collect();
    assert_eq!(
        order,
        vec!["fetch", "extract", "check", "shape", "post", "alert"]
    );
    let cyclic = apply(
        &sample_automation(),
        json!([{ "op": "connect", "edge": { "from": "shape", "port": "out", "to": "extract" } }]),
    );
    assert_eq!(topo_order(&cyclic.graph), None);
}

/// fetch -> each (for_each over the fetched list) -item-> post -> mark;
/// each -out-> done. Passes every rule.
fn loop_automation() -> Automation {
    let mut a = Automation::new("p".into(), "loop".into(), 0);
    a.graph = serde_json::from_value(json!({
        "nodes": [
            { "id": "fetch", "label": "", "spec": { "kind": "http", "method": "GET",
                "url": "https://api.example.com/items", "allowed_hosts": ["api.example.com"] } },
            { "id": "each", "label": "", "spec": { "kind": "for_each",
                "items": "{{nodes.fetch.output.body.items}}", "max_iterations": 10 } },
            { "id": "post", "label": "", "spec": { "kind": "http", "method": "POST",
                "url": "https://api.example.com/items/{{nodes.each.index}}",
                "body": "{{nodes.each.item}}", "allowed_hosts": ["api.example.com"] } },
            { "id": "mark", "label": "", "spec": { "kind": "transform",
                "fields": [{ "name": "status", "value": "{{nodes.post.output.status}}" },
                           { "name": "name", "value": "{{nodes.each.item.name}}" },
                           { "name": "before", "value": "{{nodes.fetch.output.status}}" }] } },
            { "id": "done", "label": "", "spec": { "kind": "transform",
                "fields": [{ "name": "all", "value": "{{nodes.each.output}}" }] } }
        ],
        "edges": [
            { "from": "trigger", "port": "out", "to": "fetch" },
            { "from": "fetch", "port": "out", "to": "each" },
            { "from": "each", "port": "item", "to": "post" },
            { "from": "post", "port": "out", "to": "mark" },
            { "from": "each", "port": "out", "to": "done" }
        ]
    }))
    .unwrap();
    a
}

fn add_transform(a: &Automation, id: &str, value: &str, from: &str, port: &str) -> Automation {
    apply(
        a,
        json!([
            { "op": "add_node", "node": { "id": id, "label": "", "spec": { "kind": "transform",
                "fields": [{ "name": "v", "value": value }] } } },
            { "op": "connect", "edge": { "from": from, "port": port, "to": id } }
        ]),
    )
}

#[test]
fn a_closed_loop_body_with_item_and_index_references_has_no_issues() {
    assert_eq!(codes(&loop_automation()), vec![]);
}

#[test]
fn new_kinds_have_their_own_ports() {
    let a = apply(
        &loop_automation(),
        json!([
            { "op": "add_node", "node": { "id": "pause", "label": "", "spec": { "kind": "wait", "duration_ms": 1000 } } },
            { "op": "connect", "edge": { "from": "done", "port": "out", "to": "pause" } },
            { "op": "add_node", "node": { "id": "after", "label": "", "spec": { "kind": "transform", "fields": [] } } },
            { "op": "connect", "edge": { "from": "pause", "port": "out", "to": "after" } },
            { "op": "connect", "edge": { "from": "each", "port": "error", "to": "after" } }
        ]),
    );
    assert_eq!(codes(&a), vec![]);
    let bad = apply(
        &a,
        json!([
            { "op": "connect", "edge": { "from": "pause", "port": "error", "to": "after" } },
            { "op": "connect", "edge": { "from": "fetch", "port": "item", "to": "after" } },
            { "op": "connect", "edge": { "from": "each", "port": "true", "to": "after" } }
        ]),
    );
    assert_eq!(
        codes(&bad),
        vec![
            at(IssueCode::IllegalPort, "pause"),
            at(IssueCode::IllegalPort, "fetch"),
            at(IssueCode::IllegalPort, "each"),
        ]
    );
}

#[test]
fn for_each_and_wait_bounds() {
    let base = loop_automation();
    let zero = set_spec(
        &base,
        "each",
        json!({ "kind": "for_each", "items": "{{nodes.fetch.output.body.items}}", "max_iterations": 0 }),
    );
    let over = set_spec(
        &base,
        "each",
        json!({ "kind": "for_each", "items": "{{nodes.fetch.output.body.items}}", "max_iterations": 101 }),
    );
    let max = set_spec(
        &base,
        "each",
        json!({ "kind": "for_each", "items": "{{nodes.fetch.output.body.items}}", "max_iterations": 100 }),
    );
    assert_eq!(
        codes(&zero),
        vec![at(IssueCode::ForEachMaxIterationsOutOfRange, "each")]
    );
    assert_eq!(
        codes(&over),
        vec![at(IssueCode::ForEachMaxIterationsOutOfRange, "each")]
    );
    assert_eq!(codes(&max), vec![]);
    let waits = |ms: u64| {
        codes(&set_spec(
            &base,
            "done",
            json!({ "kind": "wait", "duration_ms": ms }),
        ))
    };
    assert_eq!(waits(0), vec![at(IssueCode::WaitDurationOutOfRange, "done")]);
    assert_eq!(waits(604_800_000), vec![]);
    assert_eq!(
        waits(604_800_001),
        vec![at(IssueCode::WaitDurationOutOfRange, "done")]
    );
}

#[test]
fn a_body_node_with_an_edge_from_outside_the_body_is_not_closed() {
    let from_before = apply(
        &loop_automation(),
        json!([{ "op": "connect", "edge": { "from": "fetch", "port": "error", "to": "mark" } }]),
    );
    assert_eq!(
        codes(&from_before),
        vec![at(IssueCode::LoopBodyNotClosed, "mark")]
    );
    let from_loop_out = apply(
        &loop_automation(),
        json!([{ "op": "connect", "edge": { "from": "each", "port": "out", "to": "post" } }]),
    );
    assert_eq!(
        codes(&from_loop_out),
        vec![at(IssueCode::LoopBodyNotClosed, "post")]
    );
}

#[test]
fn a_for_each_inside_a_body_is_nested() {
    let a = apply(
        &loop_automation(),
        json!([
            { "op": "add_node", "node": { "id": "inner", "label": "", "spec": { "kind": "for_each",
                "items": "{{nodes.each.item.children}}", "max_iterations": 5 } } },
            { "op": "connect", "edge": { "from": "mark", "port": "out", "to": "inner" } }
        ]),
    );
    assert_eq!(codes(&a), vec![at(IssueCode::NestedForEach, "inner")]);
}

#[test]
fn loop_item_and_index_only_inside_that_loops_body() {
    let base = loop_automation();
    let after = add_transform(&base, "late", "{{nodes.each.item}}", "done", "out");
    assert_eq!(
        codes(&after),
        vec![at(IssueCode::LoopItemOutsideBody, "late")]
    );
    let not_a_loop = add_transform(&base, "odd", "{{nodes.post.index}}", "mark", "out");
    assert_eq!(
        codes(&not_a_loop),
        vec![at(IssueCode::LoopItemOutsideBody, "odd")]
    );
    let unknown = add_transform(&base, "ghosted", "{{nodes.ghost.item}}", "mark", "out");
    assert_eq!(
        codes(&unknown),
        vec![at(IssueCode::UnknownNodeReference, "ghosted")]
    );
}

#[test]
fn a_loops_output_inside_its_body_points_at_item() {
    let a = add_transform(&loop_automation(), "peek", "{{nodes.each.output}}", "mark", "out");
    let issues = validate(&a);
    assert_eq!(
        issues
            .iter()
            .map(|i| (i.code, i.message.as_str()))
            .collect::<Vec<_>>(),
        vec![(
            IssueCode::NonAncestorReference,
            "fields.v references nodes.each.output, which exists only after the loop; inside each's body use nodes.each.item"
        )]
    );
    let outside = add_transform(&loop_automation(), "leak", "{{nodes.mark.output}}", "done", "out");
    assert_eq!(
        codes(&outside),
        vec![at(IssueCode::NonAncestorReference, "leak")]
    );
}

#[test]
fn a_merge_needs_two_incoming_edges() {
    let one = apply(
        &loop_automation(),
        json!([
            { "op": "add_node", "node": { "id": "join", "label": "", "spec": { "kind": "merge", "mode": "any" } } },
            { "op": "connect", "edge": { "from": "done", "port": "out", "to": "join" } }
        ]),
    );
    assert_eq!(
        codes(&one),
        vec![at(IssueCode::MergeNeedsTwoInputs, "join")]
    );
    let two = apply(
        &one,
        json!([{ "op": "connect", "edge": { "from": "each", "port": "error", "to": "join" } }]),
    );
    assert_eq!(codes(&two), vec![]);
}

#[test]
fn untrusted_flow_passes_through_merge_and_for_each() {
    let agent = |prompt: &str| {
        json!({ "kind": "agent", "agent_id": "claude", "prompt": prompt,
                "output_schema": { "type": "string" }, "timeout_ms": 1000, "max_attempts": 1 })
    };
    let with_agent = |prompt: &str| {
        apply(
            &loop_automation(),
            json!([
                { "op": "add_node", "node": { "id": "join", "label": "", "spec": { "kind": "merge", "mode": "any" } } },
                { "op": "connect", "edge": { "from": "done", "port": "out", "to": "join" } },
                { "op": "connect", "edge": { "from": "each", "port": "error", "to": "join" } },
                { "op": "add_node", "node": { "id": "think", "label": "", "spec": agent(prompt) } },
                { "op": "connect", "edge": { "from": "join", "port": "out", "to": "think" } },
                { "op": "add_node", "node": { "id": "send", "label": "", "spec": { "kind": "http",
                    "method": "POST", "url": "https://hooks.example.com/x", "allowed_hosts": ["hooks.example.com"] } } },
                { "op": "connect", "edge": { "from": "think", "port": "out", "to": "send" } }
            ]),
        )
    };
    assert!(untrusted_flow(&with_agent("{{nodes.join.output.value}}").graph));
    assert!(untrusted_flow(&with_agent("{{nodes.done.output}}").graph));
    assert!(!untrusted_flow(&with_agent("{{trigger.kind}}").graph));

    let trusted_items = set_spec(
        &set_spec(
            &loop_automation(),
            "fetch",
            json!({ "kind": "transform", "fields": [{ "name": "body", "value": "x" }] }),
        ),
        "post",
        json!({ "kind": "transform", "fields": [] }),
    );
    let in_body = apply(
        &trusted_items,
        json!([
            { "op": "update_node", "id": "mark", "spec": agent("{{nodes.each.item}}") },
            { "op": "add_node", "node": { "id": "send", "label": "", "spec": { "kind": "http",
                "method": "POST", "url": "https://hooks.example.com/x", "allowed_hosts": ["hooks.example.com"] } } },
            { "op": "connect", "edge": { "from": "done", "port": "out", "to": "send" } }
        ]),
    );
    assert!(!untrusted_flow(&in_body.graph));
    let fetched_items = set_spec(
        &in_body,
        "fetch",
        json!({ "kind": "http", "method": "GET", "url": "https://api.example.com/items",
                "allowed_hosts": ["api.example.com"] }),
    );
    assert!(untrusted_flow(&fetched_items.graph));
}
