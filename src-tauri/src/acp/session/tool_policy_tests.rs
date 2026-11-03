use agent_client_protocol::schema::v1::{
    PermissionOption, RequestPermissionOutcome, ToolCallUpdate, ToolKind,
};
use serde_json::json;

use super::{ToolAllowlist, ToolPolicies};

fn tool_call(id: &str, kind: Option<&str>) -> ToolCallUpdate {
    let mut value = json!({ "toolCallId": id });
    if let Some(kind) = kind {
        value["kind"] = json!(kind);
    }
    serde_json::from_value(value).unwrap()
}

fn options(kinds: &[(&str, &str)]) -> Vec<PermissionOption> {
    kinds
        .iter()
        .map(|(id, kind)| {
            serde_json::from_value(json!({ "optionId": id, "name": id, "kind": kind })).unwrap()
        })
        .collect()
}

fn all_options() -> Vec<PermissionOption> {
    options(&[
        ("always", "allow_always"),
        ("once", "allow_once"),
        ("never", "reject_always"),
        ("no", "reject_once"),
    ])
}

fn policies(kinds: &[ToolKind]) -> ToolPolicies {
    let mut policies = ToolPolicies::default();
    policies.set("s1".into(), ToolAllowlist::new(kinds.iter().copied()));
    policies
}

/// `(kind, allowed, chosen option id or "cancelled")`
fn answer(
    policies: &ToolPolicies,
    call: &ToolCallUpdate,
    opts: &[PermissionOption],
) -> Option<(ToolKind, bool, String)> {
    policies.answer("s1", call, opts).map(|d| {
        let chosen = match d.outcome {
            RequestPermissionOutcome::Selected(selected) => selected.option_id.0.to_string(),
            _ => "cancelled".to_string(),
        };
        (d.kind, d.allowed, chosen)
    })
}

#[test]
fn a_listed_kind_gets_the_allow_once_option_and_anything_else_reject_once() {
    let p = policies(&[ToolKind::Read, ToolKind::Fetch]);
    assert_eq!(
        answer(&p, &tool_call("t1", Some("read")), &all_options()),
        Some((ToolKind::Read, true, "once".into()))
    );
    assert_eq!(
        answer(&p, &tool_call("t2", Some("execute")), &all_options()),
        Some((ToolKind::Execute, false, "no".into()))
    );
}

#[test]
fn a_request_without_a_kind_uses_the_kind_of_its_earlier_tool_call() {
    let mut p = policies(&[ToolKind::Edit]);
    p.note_kind("s1", "t1", ToolKind::Edit);
    assert_eq!(
        answer(&p, &tool_call("t1", None), &all_options()),
        Some((ToolKind::Edit, true, "once".into()))
    );
    assert_eq!(
        answer(&p, &tool_call("t9", None), &all_options()),
        Some((ToolKind::Other, false, "no".into()))
    );
}

#[test]
fn a_mode_switch_is_never_allowed() {
    let p = policies(&[ToolKind::SwitchMode, ToolKind::Other]);
    assert_eq!(
        answer(&p, &tool_call("t1", Some("switch_mode")), &all_options()),
        Some((ToolKind::SwitchMode, false, "no".into()))
    );
}

#[test]
fn missing_options_fall_back_to_a_refusal_or_a_cancel() {
    let p = policies(&[ToolKind::Read]);
    assert_eq!(
        answer(
            &p,
            &tool_call("t1", Some("read")),
            &options(&[("always", "allow_always"), ("no", "reject_once")])
        ),
        Some((ToolKind::Read, false, "no".into()))
    );
    assert_eq!(
        answer(
            &p,
            &tool_call("t2", Some("edit")),
            &options(&[("once", "allow_once"), ("never", "reject_always")])
        ),
        Some((ToolKind::Edit, false, "cancelled".into()))
    );
}

#[test]
fn a_session_without_an_allowlist_gets_no_answer() {
    let mut p = policies(&[ToolKind::Read]);
    p.forget("s1");
    p.note_kind("s1", "t1", ToolKind::Read);
    assert_eq!(
        answer(&p, &tool_call("t1", Some("read")), &all_options()),
        None
    );
}
