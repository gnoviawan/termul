use serde_json::{json, Value};

use super::graph::apply_ops;
use super::model::{Automation, AutomationId, Graph, NodeId, Op, Trigger};

pub fn node_id(id: &str) -> NodeId {
    NodeId::parse(id).unwrap()
}

pub fn ops(value: Value) -> Vec<Op> {
    serde_json::from_value(value).unwrap()
}

pub fn apply(a: &Automation, value: Value) -> Automation {
    apply_ops(a, &ops(value)).unwrap()
}

/// A weekday-morning automation that passes every rule: fetch with a key,
/// have an agent extract, branch, shape, and post.
pub fn sample_automation() -> Automation {
    let graph: Graph = serde_json::from_value(json!({
        "nodes": [
            { "id": "fetch", "label": "Fetch items", "spec": {
                "kind": "http", "method": "GET",
                "url": "https://api.example.com/items?since={{trigger.scheduled_for}}",
                "headers": [{ "name": "Authorization", "value": "Bearer {{secrets.API_KEY}}" }],
                "body": null,
                "allowed_hosts": ["api.example.com"] } },
            { "id": "extract", "label": "Extract", "spec": {
                "kind": "agent", "agent_id": "claude", "model": "sonnet",
                "prompt": "Summarize {{nodes.fetch.output.items}}",
                "output_schema": { "type": "object",
                    "properties": { "summary": { "type": "string" }, "urgent": { "type": "boolean" } },
                    "required": ["summary", "urgent"] },
                "timeout_ms": 120000, "max_attempts": 2 } },
            { "id": "check", "label": "Urgent?", "spec": {
                "kind": "condition", "left": "{{nodes.extract.output.urgent}}", "op": "eq", "right": "true" } },
            { "id": "shape", "label": "Shape", "spec": {
                "kind": "transform", "fields": [{ "name": "text", "value": "{{nodes.extract.output.summary}}" }] } },
            { "id": "post", "label": "Notify", "spec": {
                "kind": "http", "method": "POST", "url": "https://hooks.example.com/notify",
                "headers": [{ "name": "X-Key", "value": "{{secrets.HOOK_KEY}}" }],
                "body": "{{nodes.shape.output}}",
                "allowed_hosts": ["hooks.example.com"] } },
            { "id": "alert", "label": "Fetch failed", "spec": { "kind": "fail", "message": "fetch failed" } }
        ],
        "edges": [
            { "from": "trigger", "port": "out", "to": "fetch" },
            { "from": "fetch", "port": "out", "to": "extract" },
            { "from": "fetch", "port": "error", "to": "alert" },
            { "from": "extract", "port": "out", "to": "check" },
            { "from": "check", "port": "true", "to": "shape" },
            { "from": "shape", "port": "out", "to": "post" }
        ]
    }))
    .unwrap();
    let mut a = Automation::new("project-1".into(), "Morning digest".into(), 1_000);
    a.id = AutomationId::from("auto-1".to_string());
    a.graph = graph;
    a.trigger = serde_json::from_value::<Trigger>(json!({
        "kind": "schedule",
        "schedule": { "kind": "cron", "expr": "0 5 * * 1-5", "timezone": "America/New_York" }
    }))
    .unwrap();
    a
}
