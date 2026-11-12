use std::sync::Arc;

use serde_json::json;

use super::engine::HttpConfig;
use super::model::{Automation, AutomationChanged, IssueCode, Layout, NodePosition};
use super::service::{AutomationService, ServiceError};
use super::test_support::{no_history, ops, test_engine, MemoryVault};

fn service() -> AutomationService {
    let te = test_engine(
        std::env::temp_dir(),
        Arc::new(MemoryVault::default()),
        HttpConfig::default(),
    );
    AutomationService::new(te.engine, no_history())
}

fn layout(entries: &[(&str, f64, f64)]) -> Layout {
    Layout(
        entries
            .iter()
            .map(|(key, x, y)| (key.to_string(), NodePosition { x: *x, y: *y }))
            .collect(),
    )
}

fn shape_node() -> serde_json::Value {
    json!({ "op": "add_node", "node": { "id": "shape", "label": "Shape",
        "spec": { "kind": "transform", "fields": [] } } })
}

/// `p1/Digest` with one node `shape` behind the trigger, approved at revision 2.
fn approved(service: &AutomationService) -> Automation {
    let created = service.create("p1", "Digest").unwrap();
    service
        .apply_ops(
            &created.id,
            1,
            &ops(json!([
                shape_node(),
                { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "shape" } }
            ])),
        )
        .unwrap();
    service.approve(&created.id, 2).unwrap()
}

fn drained(changes: &mut tokio::sync::broadcast::Receiver<AutomationChanged>) -> usize {
    std::iter::from_fn(|| changes.try_recv().ok()).count()
}

#[tokio::test]
async fn set_layout_keeps_the_revision_and_the_approval_and_announces_one_change() {
    let service = service();
    let approved = approved(&service);
    let mut changes = service.subscribe();

    let saved = service
        .set_layout(
            &approved.id,
            layout(&[("trigger", 0.0, 0.0), ("shape", 240.0, -12.5)]),
        )
        .unwrap();

    assert_eq!(
        (
            saved.revision,
            saved.approved_revision,
            saved.next_run_at,
            saved.updated_at
        ),
        (2, Some(2), approved.next_run_at, approved.updated_at)
    );
    assert_eq!(
        saved.layout,
        layout(&[("trigger", 0.0, 0.0), ("shape", 240.0, -12.5)])
    );
    assert_eq!(service.get(&approved.id).unwrap().automation, saved);
    assert_eq!(drained(&mut changes), 1);
    assert!(
        service.run_now(&approved.id).is_ok(),
        "the approval still stands"
    );
}

#[test]
fn set_layout_drops_unknown_keys() {
    let service = service();
    let approved = approved(&service);
    let saved = service
        .set_layout(
            &approved.id,
            layout(&[("shape", 1.0, 2.0), ("gone", 3.0, 4.0)]),
        )
        .unwrap();
    assert_eq!(saved.layout, layout(&[("shape", 1.0, 2.0)]));
}

#[test]
fn set_layout_refuses_a_position_that_is_not_finite() {
    let service = service();
    let approved = approved(&service);
    let mut changes = service.subscribe();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let refused = service
            .set_layout(&approved.id, layout(&[("shape", bad, 0.0)]))
            .unwrap_err();
        assert_eq!(
            refused,
            ServiceError::InvalidInput(
                "layout: the position of \"shape\" is not a finite number".to_string()
            )
        );
    }
    assert_eq!(
        service.get(&approved.id).unwrap().automation.layout,
        Layout::default()
    );
    assert_eq!(drained(&mut changes), 0);
}

#[test]
fn set_layout_of_a_missing_automation_is_not_found() {
    let refused = service()
        .set_layout(&"nope".to_string().into(), Layout::default())
        .unwrap_err();
    assert_eq!(refused, ServiceError::NotFound("nope".to_string()));
}

#[test]
fn removing_a_node_drops_its_position_and_keeps_the_others() {
    let service = service();
    let approved = approved(&service);
    service
        .apply_ops(
            &approved.id,
            2,
            &ops(json!([
                { "op": "add_node", "node": { "id": "extra", "label": "Extra",
                    "spec": { "kind": "transform", "fields": [] } } }
            ])),
        )
        .unwrap();
    service
        .set_layout(
            &approved.id,
            layout(&[
                ("trigger", 0.0, 0.0),
                ("shape", 1.0, 1.0),
                ("extra", 2.0, 2.0),
            ]),
        )
        .unwrap();

    let applied = service
        .apply_ops(
            &approved.id,
            3,
            &ops(json!([{ "op": "remove_node", "id": "shape" }])),
        )
        .unwrap();

    let expected = layout(&[("trigger", 0.0, 0.0), ("extra", 2.0, 2.0)]);
    assert_eq!(applied.automation.layout, expected);
    assert_eq!(
        service.get(&approved.id).unwrap().automation.layout,
        expected
    );
}

#[test]
fn an_edit_and_a_rename_leave_the_layout_alone() {
    let service = service();
    let approved = approved(&service);
    service
        .set_layout(&approved.id, layout(&[("shape", 9.0, 8.0)]))
        .unwrap();
    service
        .apply_ops(
            &approved.id,
            2,
            &ops(json!([{ "op": "rename", "name": "Renamed" }])),
        )
        .unwrap();
    let renamed = service.rename(&approved.id, "Again").unwrap();
    assert_eq!(renamed.layout, layout(&[("shape", 9.0, 8.0)]));
}

#[test]
fn preview_ops_answers_like_apply_ops_and_leaves_the_store_untouched() {
    let service = service();
    let approved = approved(&service);
    service
        .set_layout(&approved.id, layout(&[("shape", 5.0, 6.0)]))
        .unwrap();
    let stored = service.get(&approved.id).unwrap();
    let mut changes = service.subscribe();
    let edit = ops(json!([
        { "op": "remove_node", "id": "shape" },
        { "op": "add_node", "node": { "id": "stop", "label": "Stop",
            "spec": { "kind": "fail", "message": "no" } } },
        { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "stop" } }
    ]));

    let previewed = service.preview_ops(&approved.id, 2, &edit).unwrap();

    assert_eq!(
        previewed
            .automation
            .graph
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        vec!["stop"]
    );
    assert_eq!(
        (
            previewed.automation.revision,
            previewed.automation.approved_revision
        ),
        (2, Some(2)),
        "the revision stays the one the edit was based on"
    );
    assert!(
        previewed.automation.layout.0.is_empty(),
        "the removed node's position is gone"
    );
    assert_eq!(previewed.issues, Vec::new());
    assert_eq!(
        service.get(&approved.id).unwrap(),
        stored,
        "the store is as it was"
    );
    assert_eq!(drained(&mut changes), 0, "nothing is announced");

    let applied = service.apply_ops(&approved.id, 2, &edit).unwrap();
    assert_eq!(
        (applied.automation.graph, applied.issues),
        (previewed.automation.graph, previewed.issues)
    );
}

#[test]
fn preview_ops_lists_the_issues_a_save_would_leave_and_refuses_what_apply_ops_refuses() {
    let service = service();
    let approved = approved(&service);
    let lonely = ops(json!([
        { "op": "add_node", "node": { "id": "lonely", "label": "Lonely",
            "spec": { "kind": "transform", "fields": [] } } }
    ]));
    let previewed = service.preview_ops(&approved.id, 2, &lonely).unwrap();
    let applied = service.apply_ops(&approved.id, 2, &lonely).unwrap();
    assert_eq!(
        previewed
            .issues
            .iter()
            .map(|i| (i.node_id.as_ref().map(|n| n.as_str()), i.code))
            .collect::<Vec<_>>(),
        vec![(Some("lonely"), IssueCode::Unreachable)]
    );
    assert_eq!(previewed.issues, applied.issues);

    let missing = ops(json!([{ "op": "remove_node", "id": "ghost" }]));
    assert_eq!(
        service.preview_ops(&approved.id, 3, &missing).unwrap_err(),
        service.apply_ops(&approved.id, 3, &missing).unwrap_err()
    );
}

#[test]
fn preview_ops_of_a_stale_revision_is_the_conflict_apply_ops_gives() {
    let service = service();
    let approved = approved(&service);
    let edit = ops(json!([{ "op": "rename", "name": "Other" }]));
    let previewed = service.preview_ops(&approved.id, 1, &edit).unwrap_err();
    let applied = service.apply_ops(&approved.id, 1, &edit).unwrap_err();
    assert_eq!(previewed, ServiceError::RevisionConflict { current: 2 });
    assert_eq!(previewed, applied);
}

#[test]
fn preview_ops_of_a_missing_automation_is_not_found() {
    let refused = service()
        .preview_ops(
            &"nope".to_string().into(),
            1,
            &ops(json!([{ "op": "rename", "name": "x" }])),
        )
        .unwrap_err();
    assert_eq!(refused, ServiceError::NotFound("nope".to_string()));
}
