use super::{
    codex_plan_limit_kind, usage_from_rate_limits, usage_from_verdict, verdict_from_rpc_error,
    CodexUsageStatus,
};
use serde_json::json;

fn limits(
    primary_mins: i64,
    primary_pct: i32,
    secondary_mins: i64,
    secondary_pct: i32,
) -> serde_json::Value {
    json!({
        "rateLimits": {
            "planType": "plus",
            "primary": {
                "usedPercent": primary_pct,
                "windowDurationMins": primary_mins,
                "resetsAt": 1_700_000_000
            },
            "secondary": {
                "usedPercent": secondary_pct,
                "windowDurationMins": secondary_mins,
                "resetsAt": 1_700_086_400
            }
        }
    })
}

#[test]
fn primary_and_secondary_windows_are_classified_by_duration() {
    let usage = usage_from_rate_limits("default", &limits(300, 42, 10_080, 11), 5);
    assert_eq!(usage.status, CodexUsageStatus::Ok);
    assert_eq!(usage.plan_type.as_deref(), Some("plus"));
    assert_eq!(usage.windows.len(), 2);
    assert_eq!(usage.windows[0].kind, "session");
    assert!((usage.windows[0].percent - 42.0).abs() < f64::EPSILON);
    assert_eq!(
        usage.windows[0].resets_at.as_deref(),
        Some("2023-11-14T22:13:20+00:00")
    );
    assert_eq!(usage.windows[1].kind, "weekly");
    assert!((usage.windows[1].percent - 11.0).abs() < f64::EPSILON);
}

#[test]
fn a_long_primary_window_is_weekly_and_a_short_secondary_is_five_hour() {
    let usage = usage_from_rate_limits("default", &limits(10_080, 90, 300, 10), 5);
    assert_eq!(usage.windows[0].kind, "weekly");
    assert_eq!(usage.windows[1].kind, "session");
}

#[test]
fn a_missing_duration_keeps_the_historical_slot() {
    let usage = usage_from_rate_limits(
        "default",
        &json!({
            "rateLimits": {
                "primary": { "usedPercent": 80 },
                "secondary": { "usedPercent": 20 }
            }
        }),
        5,
    );
    assert_eq!(usage.status, CodexUsageStatus::Ok);
    assert_eq!(usage.windows[0].kind, "session");
    assert_eq!(usage.windows[1].kind, "weekly");
    assert!(usage.windows[0].resets_at.is_none());
}

#[test]
fn the_codex_bucket_is_used_when_the_top_level_snapshot_has_no_windows() {
    let usage = usage_from_rate_limits(
        "default",
        &json!({
            "rateLimits": { "planType": "pro" },
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": { "usedPercent": 15, "windowDurationMins": 300, "resetsAt": 10 }
                }
            }
        }),
        5,
    );
    assert_eq!(usage.status, CodexUsageStatus::Ok);
    assert_eq!(usage.plan_type.as_deref(), Some("pro"));
    assert_eq!(usage.windows[0].kind, "session");
}

#[test]
fn an_unknown_result_shape_is_unavailable() {
    let usage = usage_from_rate_limits("default", &json!({ "nope": true }), 5);
    assert_eq!(usage.status, CodexUsageStatus::Unavailable);
    assert!(usage.windows.is_empty());
    assert!(usage.plan_type.is_none());
}

#[test]
fn an_unknown_plan_name_is_dropped() {
    let usage = usage_from_rate_limits(
        "default",
        &json!({
            "rateLimits": {
                "planType": "unknown",
                "primary": { "usedPercent": 1, "windowDurationMins": 300 }
            }
        }),
        5,
    );
    assert!(usage.plan_type.is_none());
}

#[test]
fn the_unsigned_app_server_auth_error_is_signed_out() {
    // `codex app-server` 0.169, empty CODEX_HOME, no login:
    // code -32600, message "codex account authentication required to read rate limits".
    let verdict = verdict_from_rpc_error(&json!({
        "code": -32600,
        "message": "codex account authentication required to read rate limits"
    }));
    let usage = usage_from_verdict("default", verdict, 1);
    assert_eq!(usage.status, CodexUsageStatus::SignedOut);
    assert!(usage.message.is_none());
}

#[test]
fn plan_limit_kinds_are_read_from_adapter_errors_and_not_from_other_limits() {
    assert_eq!(
        codex_plan_limit_kind(&json!({ "errorKind": "rate_limited" })),
        Some("rate_limited")
    );
    assert_eq!(
        codex_plan_limit_kind(&json!({ "codexErrorInfo": "usageLimitExceeded" })),
        Some("quota_exhausted")
    );
    assert_eq!(
        codex_plan_limit_kind(&json!({
            "jetbrains": { "air": { "sessionFailure": {
                "category": "limit",
                "title": "You've hit your usage limit"
            }}}
        })),
        Some("quota_exhausted")
    );
    assert_eq!(
        codex_plan_limit_kind(&json!({
            "category": "limit",
            "title": "Rate limit reached"
        })),
        Some("rate_limited")
    );
    assert_eq!(
        codex_plan_limit_kind(&json!({
            "category": "limit",
            "title": "Context window exceeded"
        })),
        None
    );
    assert_eq!(
        codex_plan_limit_kind(&json!({ "errorKind": "overloaded" })),
        None
    );
}
