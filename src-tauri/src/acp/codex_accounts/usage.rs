//! Usage windows of a Codex Account (about 5 hours, and weekly) read from
//! `codex app-server` `account/rateLimits/read`. The probe is best-effort:
//! a missing CLI, a failed handshake, or a response this host does not
//! understand is `unavailable`, not an error.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A window shorter than this is the 5-hour window. A longer window is weekly.
const SHORT_WINDOW_MAX_MINS: i64 = 12 * 60;

/// One usage window of an Account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindow {
    /// `session` (about 5 hours) or `weekly`.
    pub kind: String,
    /// Percent used, 0–100.
    pub percent: f64,
    /// ISO-8601 reset time; `None` when Codex did not send one.
    pub resets_at: Option<String>,
    /// Window length in minutes, when Codex sent it.
    pub window_duration_mins: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexUsageStatus {
    /// Windows were read.
    Ok,
    /// The CLI is missing, the handshake failed, or this Codex version has
    /// no usable rate-limit read.
    Unavailable,
    /// The Account has no ChatGPT login.
    SignedOut,
    /// The usage could not be read; see `message`.
    Error,
}

/// The usage of one Account at `checked_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountUsage {
    pub account_id: String,
    pub status: CodexUsageStatus,
    /// Plan name when Codex sent one (`plus`, `pro`, …). Never an email.
    pub plan_type: Option<String>,
    pub windows: Vec<CodexUsageWindow>,
    /// Unix epoch milliseconds of the read.
    pub checked_at: i64,
    /// Human-readable reason for `error` or `unavailable`. No login details.
    pub message: Option<String>,
}

impl CodexAccountUsage {
    #[must_use]
    pub fn status_only(
        account_id: &str,
        status: CodexUsageStatus,
        message: impl Into<String>,
        checked_at: i64,
    ) -> Self {
        Self {
            account_id: account_id.to_string(),
            status,
            plan_type: None,
            windows: Vec::new(),
            checked_at,
            message: Some(message.into()),
        }
    }
}

/// What one app-server probe concluded, before it is stored.
#[derive(Debug)]
pub(crate) enum ProbeVerdict {
    /// The `account/rateLimits/read` result object.
    Limits(Value),
    SignedOut,
    Unavailable,
    Failed(&'static str),
}

/// Map a probe verdict to the usage record of one Account.
#[must_use]
pub(crate) fn usage_from_verdict(
    account_id: &str,
    verdict: ProbeVerdict,
    checked_at: i64,
) -> CodexAccountUsage {
    match verdict {
        ProbeVerdict::Limits(result) => usage_from_rate_limits(account_id, &result, checked_at),
        ProbeVerdict::SignedOut => CodexAccountUsage {
            account_id: account_id.to_string(),
            status: CodexUsageStatus::SignedOut,
            plan_type: None,
            windows: Vec::new(),
            checked_at,
            message: None,
        },
        ProbeVerdict::Unavailable => CodexAccountUsage::status_only(
            account_id,
            CodexUsageStatus::Unavailable,
            "Codex usage is not available",
            checked_at,
        ),
        ProbeVerdict::Failed(message) => {
            CodexAccountUsage::status_only(account_id, CodexUsageStatus::Error, message, checked_at)
        }
    }
}

/// Map an `account/rateLimits/read` result to windows.
///
/// A result this host does not understand is `unavailable`. A signed-in read
/// with no windows is `unavailable` too: there is nothing to show.
#[must_use]
pub fn usage_from_rate_limits(
    account_id: &str,
    result: &Value,
    checked_at: i64,
) -> CodexAccountUsage {
    let Some(snapshot) = rate_limit_snapshot(result) else {
        return CodexAccountUsage::status_only(
            account_id,
            CodexUsageStatus::Unavailable,
            "Codex did not report plan limits",
            checked_at,
        );
    };
    let plan_type = plan_name(snapshot).or_else(|| result.get("rateLimits").and_then(plan_name));
    let mut windows = Vec::new();
    if let Some(window) = window_from(snapshot.get("primary"), "session") {
        windows.push(window);
    }
    if let Some(window) = window_from(snapshot.get("secondary"), "weekly") {
        windows.push(window);
    }
    if windows.is_empty() {
        return CodexAccountUsage::status_only(
            account_id,
            CodexUsageStatus::Unavailable,
            "Codex did not report plan limits",
            checked_at,
        );
    }
    CodexAccountUsage {
        account_id: account_id.to_string(),
        status: CodexUsageStatus::Ok,
        plan_type,
        windows,
        checked_at,
        message: None,
    }
}

/// The historical single-bucket snapshot, else the `codex` bucket, else the
/// first bucket that has a window.
fn rate_limit_snapshot(result: &Value) -> Option<&Value> {
    let direct = result.get("rateLimits").filter(|value| !value.is_null());
    if direct.is_some_and(has_window) {
        return direct;
    }
    let buckets = result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)?;
    buckets
        .get("codex")
        .filter(|value| has_window(value))
        .or_else(|| buckets.values().find(|value| has_window(value)))
        .or(direct)
}

fn plan_name(snapshot: &Value) -> Option<String> {
    snapshot
        .get("planType")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|plan| !plan.is_empty() && !plan.eq_ignore_ascii_case("unknown"))
}

fn has_window(snapshot: &Value) -> bool {
    snapshot
        .get("primary")
        .is_some_and(|value| !value.is_null())
        || snapshot
            .get("secondary")
            .is_some_and(|value| !value.is_null())
}

/// `fallback_kind` is used only when Codex omits the duration.
fn window_from(value: Option<&Value>, fallback_kind: &str) -> Option<CodexUsageWindow> {
    let value = value.filter(|value| !value.is_null())?;
    let percent = value.get("usedPercent")?.as_f64()?.clamp(0.0, 100.0);
    let duration = value.get("windowDurationMins").and_then(Value::as_i64);
    let kind = match duration {
        Some(mins) if mins <= SHORT_WINDOW_MAX_MINS => "session",
        Some(_) => "weekly",
        None => fallback_kind,
    };
    Some(CodexUsageWindow {
        kind: kind.to_string(),
        percent,
        resets_at: resets_at_iso(value.get("resetsAt")),
        window_duration_mins: duration,
    })
}

fn resets_at_iso(value: Option<&Value>) -> Option<String> {
    let value = value.filter(|value| !value.is_null())?;
    if let Some(seconds) = value.as_i64() {
        return chrono::DateTime::from_timestamp(seconds, 0).map(|time| time.to_rfc3339());
    }
    if let Some(seconds) = value.as_f64() {
        return chrono::DateTime::from_timestamp(seconds as i64, 0).map(|time| time.to_rfc3339());
    }
    value.as_str().map(str::to_string)
}

/// A JSON-RPC error from the app-server. Auth failures are signed out.
/// Anything else (unknown method, unexpected shape) is unavailable.
#[must_use]
pub(crate) fn verdict_from_rpc_error(error: &Value) -> ProbeVerdict {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = error
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if is_signed_out(message) || is_signed_out(data) {
        ProbeVerdict::SignedOut
    } else {
        ProbeVerdict::Unavailable
    }
}

fn is_signed_out(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    const NEEDLES: [&str; 8] = [
        "not logged in",
        "not signed in",
        "not authenticated",
        "unauthenticated",
        "unauthorized",
        "login required",
        "authentication required",
        "sign in",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

/// `rate_limited` or `quota_exhausted` when a prompt result says the turn hit
/// a Codex plan limit. Other limit kinds (context, budget) are not a plan limit.
#[must_use]
pub fn codex_plan_limit_kind(meta: &Value) -> Option<&'static str> {
    if let Some(kind) = find_string(meta, "errorKind").as_deref() {
        return plan_kind_name(kind);
    }
    if let Some(info) = find_string(meta, "codexErrorInfo").as_deref() {
        return match info {
            "usageLimitExceeded" => Some("quota_exhausted"),
            "rateLimitExceeded" => Some("rate_limited"),
            _ => None,
        };
    }
    let failure = find_object_with(meta, "category")?;
    if failure.get("category").and_then(Value::as_str) != Some("limit") {
        return None;
    }
    let title = failure
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if title.contains("context") || title.contains("budget") {
        return None;
    }
    if title.contains("usage limit") || title.contains("quota") {
        return Some("quota_exhausted");
    }
    if title.contains("rate limit") || title.contains("rate-limit") {
        return Some("rate_limited");
    }
    None
}

fn plan_kind_name(kind: &str) -> Option<&'static str> {
    match kind {
        "rate_limited" => Some("rate_limited"),
        "quota_exhausted" => Some("quota_exhausted"),
        _ => None,
    }
}

fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(found) = map.get(key).and_then(Value::as_str) {
                return Some(found.to_string());
            }
            map.values().find_map(|child| find_string(child, key))
        }
        Value::Array(items) => items.iter().find_map(|child| find_string(child, key)),
        _ => None,
    }
}

fn find_object_with<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            if map.contains_key(key) {
                return Some(value);
            }
            map.values().find_map(|child| find_object_with(child, key))
        }
        Value::Array(items) => items.iter().find_map(|child| find_object_with(child, key)),
        _ => None,
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
