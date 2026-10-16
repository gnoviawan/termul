use super::{claude_rate_limit, parse_probe_output, ClaudeUsageStatus};

#[test]
fn the_adapter_rate_limit_meta_is_read() {
    let meta: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
        r#"{"_claude/rateLimit":{"status":"allowed_warning","resetsAt":1760360399,"rateLimitType":"five_hour","utilization":0.83}}"#,
    )
    .unwrap();
    let limit = claude_rate_limit(Some(&meta)).unwrap();
    assert_eq!(limit.status, "allowed_warning");
    assert_eq!(limit.resets_at, Some(1_760_360_399));
    assert_eq!(limit.kind.as_deref(), Some("five_hour"));
    assert!((limit.percent.unwrap() - 83.0).abs() < 1e-9);
    assert!(!limit.overage_in_use);
}

#[test]
fn overage_marks_a_rejected_window_as_not_blocking() {
    let meta: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
        r#"{"_claude/rateLimit":{"status":"rejected","overageStatus":"allowed"}}"#,
    )
    .unwrap();
    assert!(claude_rate_limit(Some(&meta)).unwrap().overage_in_use);
    let empty = serde_json::Map::new();
    assert!(claude_rate_limit(Some(&empty)).is_none());
    assert!(claude_rate_limit(None).is_none());
}

const MAX_REPLY: &str = r#"{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":12,"resets_at":"2026-10-13T12:39:59+00:00"},"limits":[{"kind":"session","group":"session","percent":12,"resets_at":"2026-10-13T12:39:59+00:00","severity":"normal","is_active":true,"scope":null},{"kind":"weekly_all","group":"weekly","percent":3,"resets_at":"2026-10-19T19:59:59+00:00","severity":"normal","is_active":false,"scope":null},{"kind":"weekly_scoped","group":"weekly","percent":0,"resets_at":"2026-10-19T20:00:00+00:00","severity":"normal","scope":{"display_name":"Fable"}}]}}"#;

#[test]
fn the_sdk_limits_list_becomes_windows() {
    let usage = parse_probe_output("a1", MAX_REPLY, 7);
    assert_eq!(usage.status, ClaudeUsageStatus::Ok);
    assert_eq!(usage.subscription_type.as_deref(), Some("max"));
    assert_eq!(usage.checked_at, 7);
    let kinds: Vec<(&str, f64)> = usage
        .windows
        .iter()
        .map(|w| (w.kind.as_str(), w.percent))
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("session", 12.0),
            ("weekly_all", 3.0),
            ("weekly_scoped", 0.0)
        ]
    );
    assert_eq!(
        usage.windows[0].resets_at.as_deref(),
        Some("2026-10-13T12:39:59+00:00")
    );
    assert_eq!(usage.windows[2].scope.as_deref(), Some("Fable"));
}

#[test]
fn a_nested_model_scope_names_the_window() {
    let reply = r#"{"rate_limits_available":true,"rate_limits":{"limits":[{"kind":"weekly_scoped","group":"weekly","percent":0,"resets_at":null,"scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}}]}}"#;
    let usage = parse_probe_output("a1", reply, 0);
    assert_eq!(usage.windows[0].scope.as_deref(), Some("Fable"));
}

#[test]
fn a_window_that_has_not_started_has_no_reset_time() {
    let reply = r#"{"subscription_type":"team","rate_limits_available":true,"rate_limits":{"limits":[{"kind":"session","group":"session","percent":0,"resets_at":null,"severity":"normal"}]}}"#;
    let usage = parse_probe_output("a1", reply, 0);
    assert_eq!(usage.windows.len(), 1);
    assert_eq!(usage.windows[0].resets_at, None);
}

#[test]
fn older_sdks_fall_back_to_the_named_windows() {
    let reply = r#"{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":40.5,"resets_at":"x"},"seven_day":{"utilization":120,"resets_at":null},"seven_day_opus":null}}"#;
    let usage = parse_probe_output("a1", reply, 0);
    let kinds: Vec<(&str, f64)> = usage
        .windows
        .iter()
        .map(|w| (w.kind.as_str(), w.percent))
        .collect();
    assert_eq!(kinds, vec![("session", 40.5), ("weekly_all", 100.0)]);
}

#[test]
fn a_login_without_plan_limits_is_unavailable() {
    let usage = parse_probe_output(
        "a1",
        r#"{"subscription_type":"enterprise","rate_limits_available":false,"rate_limits":null}"#,
        0,
    );
    assert_eq!(usage.status, ClaudeUsageStatus::Unavailable);
    assert!(usage.windows.is_empty());
}

#[test]
fn a_config_dir_without_a_login_is_signed_out() {
    let reply = r#"{"subscription_type":null,"rate_limits_available":false,"rate_limits":null}"#;
    assert_eq!(
        parse_probe_output("a1", reply, 0).status,
        ClaudeUsageStatus::SignedOut
    );
}

#[test]
fn probe_errors_are_short_and_never_echo_paths_or_emails() {
    let usage = parse_probe_output("a1", r#"{"error":"Not logged in"}"#, 0);
    assert_eq!(usage.status, ClaudeUsageStatus::Error);
    assert_eq!(usage.message.as_deref(), Some("Not logged in"));
    let usage = parse_probe_output("a1", r#"{"error":"failed for me@example.com"}"#, 0);
    assert_eq!(
        usage.message.as_deref(),
        Some("Claude usage could not be read")
    );
    let usage = parse_probe_output("a1", r#"{"error":"ENOENT /Users/x/sdk.mjs"}"#, 0);
    assert_eq!(
        usage.message.as_deref(),
        Some("Claude usage could not be read")
    );
}

#[test]
fn noise_before_the_json_line_and_garbage_are_tolerated() {
    let usage = parse_probe_output("a1", &format!("warning: something\n{MAX_REPLY}\n"), 0);
    assert_eq!(usage.status, ClaudeUsageStatus::Ok);
    let usage = parse_probe_output("a1", "not json", 0);
    assert_eq!(usage.status, ClaudeUsageStatus::Error);
}
