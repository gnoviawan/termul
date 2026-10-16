//! Usage windows of a Claude Account (5-hour session, weekly, per model) and
//! the parser for the Claude Agent SDK `/usage` data. The SDK call is
//! experimental, so every field is optional and an unknown shape yields no
//! windows instead of an error.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One usage window of an Account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageWindow {
    /// SDK kind, e.g. `session`, `weekly_all`, `weekly_scoped`.
    pub kind: String,
    /// `session` or `weekly` when the SDK groups the kind.
    pub group: Option<String>,
    /// Model or feature name of a scoped window.
    pub scope: Option<String>,
    /// Percent used, 0–100.
    pub percent: f64,
    /// ISO-8601 reset time; `None` while the window has not started.
    pub resets_at: Option<String>,
    /// SDK severity, e.g. `normal`, `warning`, `critical`.
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeUsageStatus {
    /// Windows were read.
    Ok,
    /// The login has no plan limits (API key, Bedrock, Vertex).
    Unavailable,
    /// The Account has no Claude login.
    SignedOut,
    /// The usage could not be read; see `message`.
    Error,
}

/// The usage of one Account at `checked_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountUsage {
    pub account_id: String,
    pub status: ClaudeUsageStatus,
    /// `pro`, `max`, `team`, `enterprise` when known.
    pub subscription_type: Option<String>,
    pub windows: Vec<ClaudeUsageWindow>,
    /// Unix epoch milliseconds of the read.
    pub checked_at: i64,
    /// Human-readable reason for `error`; never holds login details.
    pub message: Option<String>,
}

impl ClaudeAccountUsage {
    #[must_use]
    pub fn error(account_id: &str, message: impl Into<String>, checked_at: i64) -> Self {
        Self {
            account_id: account_id.to_string(),
            status: ClaudeUsageStatus::Error,
            subscription_type: None,
            windows: Vec::new(),
            checked_at,
            message: Some(message.into()),
        }
    }
}

/// Parse the probe output: the SDK usage response, or `{ "error": "..." }`.
#[must_use]
pub fn parse_probe_output(account_id: &str, output: &str, checked_at: i64) -> ClaudeAccountUsage {
    let Some(value) = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    else {
        return ClaudeAccountUsage::error(account_id, "Claude usage could not be read", checked_at);
    };
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return ClaudeAccountUsage::error(account_id, sanitize_message(error), checked_at);
    }
    let subscription_type = value
        .get("subscription_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    if value.get("rate_limits_available").and_then(Value::as_bool) == Some(false) {
        // No plan type at all means no login: the SDK answers that way for
        // a config dir that was never signed in.
        let status = if subscription_type.is_none() {
            ClaudeUsageStatus::SignedOut
        } else {
            ClaudeUsageStatus::Unavailable
        };
        return ClaudeAccountUsage {
            account_id: account_id.to_string(),
            status,
            subscription_type,
            windows: Vec::new(),
            checked_at,
            message: None,
        };
    }
    let rate_limits = value.get("rate_limits").unwrap_or(&Value::Null);
    let mut windows = limits_array(rate_limits);
    if windows.is_empty() {
        windows = legacy_windows(rate_limits);
    }
    ClaudeAccountUsage {
        account_id: account_id.to_string(),
        status: ClaudeUsageStatus::Ok,
        subscription_type,
        windows,
        checked_at,
        message: None,
    }
}

/// The SDK's normalized `limits` list.
fn limits_array(rate_limits: &Value) -> Vec<ClaudeUsageWindow> {
    let Some(items) = rate_limits.get("limits").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            Some(ClaudeUsageWindow {
                kind: item.get("kind")?.as_str()?.to_string(),
                group: string_at(item, "group"),
                scope: scope_name(item.get("scope")),
                percent: item.get("percent")?.as_f64()?.clamp(0.0, 100.0),
                resets_at: string_at(item, "resets_at"),
                severity: string_at(item, "severity"),
            })
        })
        .collect()
}

/// Older SDKs: `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`
/// objects with `utilization` (0–100) and `resets_at`.
fn legacy_windows(rate_limits: &Value) -> Vec<ClaudeUsageWindow> {
    [
        ("five_hour", "session", "session", None),
        ("seven_day", "weekly_all", "weekly", None),
        ("seven_day_opus", "weekly_scoped", "weekly", Some("Opus")),
        (
            "seven_day_sonnet",
            "weekly_scoped",
            "weekly",
            Some("Sonnet"),
        ),
    ]
    .into_iter()
    .filter_map(|(key, kind, group, scope)| {
        let window = rate_limits.get(key)?;
        Some(ClaudeUsageWindow {
            kind: kind.to_string(),
            group: Some(group.to_string()),
            scope: scope.map(str::to_string),
            percent: window.get("utilization")?.as_f64()?.clamp(0.0, 100.0),
            resets_at: string_at(window, "resets_at"),
            severity: None,
        })
    })
    .collect()
}

/// Live plan rate-limit state that the Claude ACP adapter attaches to a
/// `usage_update` (`_meta["_claude/rateLimit"]`, from the SDK
/// `rate_limit_event`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimit {
    /// `allowed`, `allowed_warning`, or `rejected`.
    pub status: String,
    /// Unix epoch seconds of the window reset.
    pub resets_at: Option<i64>,
    /// SDK window kind, e.g. `five_hour`, `seven_day`, `seven_day_opus`.
    pub kind: Option<String>,
    /// Percent used, 0–100.
    pub percent: Option<f64>,
    /// Paid overage carries the turn, so a `rejected` window does not block.
    pub overage_in_use: bool,
}

/// Read the adapter's rate-limit `_meta`; `None` when absent or malformed.
#[must_use]
pub fn claude_rate_limit(meta: Option<&serde_json::Map<String, Value>>) -> Option<ClaudeRateLimit> {
    let info = meta?.get("_claude/rateLimit")?;
    let status = info.get("status")?.as_str()?.to_string();
    let overage_allowed = matches!(
        info.get("overageStatus").and_then(Value::as_str),
        Some("allowed" | "allowed_warning")
    );
    let flag = |key: &str| info.get(key).and_then(Value::as_bool).unwrap_or(false);
    Some(ClaudeRateLimit {
        status,
        resets_at: info.get("resetsAt").and_then(Value::as_i64),
        kind: string_at(info, "rateLimitType"),
        percent: info
            .get("utilization")
            .and_then(Value::as_f64)
            .map(|u| (u * 100.0).clamp(0.0, 100.0)),
        overage_in_use: overage_allowed || flag("isUsingOverage") || flag("overageInUse"),
    })
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// A scope is a plain name, an object with a display name, or an object whose
/// `model` / `surface` holds one (`{"model":{"display_name":"Fable"}}`).
fn scope_name(scope: Option<&Value>) -> Option<String> {
    let scope = scope?;
    if let Some(name) = scope.as_str() {
        return Some(name.to_string());
    }
    if let Some(name) = ["display_name", "name"]
        .iter()
        .find_map(|key| string_at(scope, key))
    {
        return Some(name);
    }
    ["model", "surface"]
        .iter()
        .find_map(|key| scope.get(key).filter(|v| !v.is_null()))
        .and_then(|inner| {
            inner.as_str().map(str::to_string).or_else(|| {
                ["display_name", "name", "id"]
                    .iter()
                    .find_map(|key| string_at(inner, key))
            })
        })
}

/// Keep probe errors short and free of paths or account details.
fn sanitize_message(message: &str) -> String {
    let first = message.lines().next().unwrap_or_default().trim();
    let short: String = first.chars().take(200).collect();
    if short.contains('@') || short.contains('/') || short.contains('\\') {
        "Claude usage could not be read".to_string()
    } else {
        short
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
