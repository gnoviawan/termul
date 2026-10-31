use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;

use super::engine::HttpConfig;
use super::model::{AutomationChanged, IssueCode, Op, RunStatus, Schedule};
use super::service::{AutomationService, ServiceError};
use super::test_support::{test_engine, MemoryVault};
use crate::acp::config::AgentConfig;

fn service() -> AutomationService {
    let te = test_engine(
        std::env::temp_dir(),
        Arc::new(MemoryVault::default()),
        HttpConfig::default(),
    );
    AutomationService::new(te.engine)
}

fn ops(value: serde_json::Value) -> Vec<Op> {
    serde_json::from_value(value).unwrap()
}

fn agent_graph() -> Vec<Op> {
    ops(json!([
        { "op": "add_node", "node": { "id": "ask", "label": "Ask", "spec": {
            "kind": "agent", "agent_id": "claude", "prompt": "hi",
            "output_schema": { "type": "string" }, "timeout_ms": 60_000, "max_attempts": 1 } } },
        { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "ask" } }
    ]))
}

#[test]
fn approval_is_refused_until_the_agent_is_known_on_this_host() {
    let service = service();
    let created = service.create("p1", "Digest").unwrap();
    let applied = service.apply_ops(&created.id, 1, &agent_graph()).unwrap();
    assert_eq!(
        applied.issues.iter().map(|i| i.code).collect::<Vec<_>>(),
        vec![IssueCode::UnknownAgent]
    );

    let refused = service.approve(&created.id, 2).unwrap_err();
    assert_eq!(refused.code(), "has_issues");

    service.engine().agents().record(&AgentConfig {
        config_id: Some("claude".to_string()),
        name: "Claude".to_string(),
        command: "claude".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    });
    let approved = service.approve(&created.id, 2).unwrap();
    assert_eq!(approved.approved_revision, Some(2));
    assert!(service.get(&created.id).unwrap().issues.is_empty());
}

#[tokio::test]
async fn only_the_approved_revision_runs_and_a_rename_keeps_the_approval() {
    let service = service();
    let created = service.create("p1", "Digest").unwrap();
    service
        .apply_ops(
            &created.id,
            1,
            &ops(json!([
                { "op": "add_node", "node": { "id": "shape", "label": "Shape",
                  "spec": { "kind": "transform", "fields": [] } } },
                { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "shape" } }
            ])),
        )
        .unwrap();
    assert_eq!(
        service.run_now(&created.id).unwrap_err(),
        ServiceError::NotApproved
    );

    service.approve(&created.id, 2).unwrap();
    let renamed = service.rename(&created.id, "  Morning digest ").unwrap();
    assert_eq!(
        (
            renamed.name.as_str(),
            renamed.revision,
            renamed.approved_revision
        ),
        ("Morning digest", 2, Some(2))
    );
    let run = service.run_now(&created.id).unwrap();
    assert_eq!(run.status, RunStatus::Running);
}

#[test]
fn a_stale_base_revision_is_a_conflict() {
    let service = service();
    let created = service.create("p1", "Digest").unwrap();
    service.apply_ops(&created.id, 1, &agent_graph()).unwrap();
    let stale = service
        .apply_ops(&created.id, 1, &agent_graph())
        .unwrap_err();
    assert_eq!(stale, ServiceError::RevisionConflict { current: 2 });
}

#[test]
fn every_mutation_announces_one_change() {
    let service = service();
    let mut changes = service.subscribe();
    let created = service.create("p1", "Digest").unwrap();
    service.set_enabled(&created.id, false).unwrap();
    service.mark_seen(&created.id).unwrap();
    service.set_secret("p1", "API_KEY", "sk-1").unwrap();
    service.delete(&created.id).unwrap();

    let for_automation = AutomationChanged {
        project_id: "p1".to_string(),
        automation_id: Some(created.id.clone()),
        proposed: false,
        proposed_by: None,
    };
    let for_project = AutomationChanged {
        project_id: "p1".to_string(),
        automation_id: None,
        proposed: false,
        proposed_by: None,
    };
    let seen: Vec<AutomationChanged> = std::iter::from_fn(|| changes.try_recv().ok()).collect();
    assert_eq!(
        seen,
        vec![
            for_automation.clone(),
            for_automation.clone(),
            for_automation.clone(),
            for_project,
            for_automation,
        ]
    );
    assert_eq!(service.list_secret_names("p1").unwrap(), vec!["API_KEY"]);
    assert_eq!(
        service.get(&created.id).unwrap_err(),
        ServiceError::NotFound(created.id.to_string())
    );
}

#[test]
fn preview_lists_the_next_three_slots() {
    let service = service();
    let slots = service
        .preview(&Schedule::Every {
            every_ms: 60_000,
            anchor_ms: 0,
        })
        .unwrap();
    assert_eq!(slots, vec![60_000, 120_000, 180_000]);
}

#[test]
fn propose_announces_one_proposed_change_and_never_approves() {
    let service = service();
    let created = service.create("p1", "Digest").unwrap();
    let mut changes = service.subscribe();

    let refused = service.propose(&created.id, None).unwrap_err();
    assert_eq!(refused.code(), "has_issues");
    assert!(
        changes.try_recv().is_err(),
        "a refused proposal announces nothing"
    );

    service
        .apply_ops(
            &created.id,
            1,
            &ops(json!([
                { "op": "add_node", "node": { "id": "shape", "label": "Shape",
                  "spec": { "kind": "transform", "fields": [] } } },
                { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "shape" } }
            ])),
        )
        .unwrap();
    let _applied = changes.try_recv().unwrap();
    let proposed = service
        .propose(&created.id, Some("Claude".to_string()))
        .unwrap();

    assert_eq!(proposed.approved_revision, None);
    assert_eq!(
        changes.try_recv().unwrap(),
        AutomationChanged {
            project_id: "p1".to_string(),
            automation_id: Some(created.id.clone()),
            proposed: true,
            proposed_by: Some("Claude".to_string()),
        }
    );
    assert!(changes.try_recv().is_err());
    assert_eq!(
        service
            .get(&created.id)
            .unwrap()
            .automation
            .approved_revision,
        None
    );
}

#[test]
fn the_proposed_flag_is_on_the_wire_only_when_set() {
    let change = AutomationChanged {
        project_id: "p1".to_string(),
        automation_id: None,
        proposed: false,
        proposed_by: None,
    };
    assert_eq!(
        serde_json::to_value(&change).unwrap(),
        json!({ "project_id": "p1", "automation_id": null })
    );
    let proposed = AutomationChanged {
        proposed: true,
        proposed_by: Some("Claude".to_string()),
        ..change
    };
    assert_eq!(
        serde_json::to_value(&proposed).unwrap(),
        json!({ "project_id": "p1", "automation_id": null, "proposed": true, "proposed_by": "Claude" })
    );
    let parsed: AutomationChanged =
        serde_json::from_value(json!({ "project_id": "p1", "automation_id": null })).unwrap();
    assert!(!parsed.proposed);
}
