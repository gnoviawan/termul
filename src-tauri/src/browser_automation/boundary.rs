//! Host-boundary failure logging for browser tool calls (CAP-6).
//!
//! The failure log line printed by the parent (`acp::host_mcp::parent`)
//! when a `FrameKind::Browser` call fails: wire error code + action +
//! argument KEY NAMES + agent id + redacted session. Deliberately
//! excludes the error message — messages can embed argument values
//! (invalid urls, refs, typed text; CWE-532). The agent-facing reply
//! keeps the full message (it is the tool result, values allowed there).
//!
//! Pure module: every helper is headless-testable and pinned by unit
//! tests in `super::tests`.

use super::{ERR_CAPABILITY, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_TAB_NOT_FOUND};

/// Prefix shared by every host-boundary browser failure line. Extracted
/// as a const so tests filter captured log lines on the exact production
/// string (never a drifted copy).
pub const BROWSER_CALL_FAILED_PREFIX: &str = "[host-mcp] browser call failed";

/// Typed failure returned to the agent.
#[derive(Debug)]
pub struct BrowserError {
    pub code: &'static str,
    pub message: String,
    /// Argument key names (never values) implicated in the failure.
    /// Carried to the host boundary so failure logs stay diagnosable from
    /// key names alone (CWE-532: messages may embed values, logs must
    /// not). Populated by error sites that know the failing key; the
    /// host boundary's [`boundary_arg_keys`] fallback stamps the
    /// action's documented table onto errors that couldn't.
    pub arg_keys: Vec<&'static str>,
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl BrowserError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            arg_keys: Vec::new(),
        }
    }
    /// Attach the argument key names implicated in this failure (key
    /// names only — never values; CWE-532).
    pub(super) fn with_arg_keys(mut self, keys: &[&'static str]) -> Self {
        self.arg_keys = keys.to_vec();
        self
    }
    pub(super) fn capability(msg: impl Into<String>) -> Self {
        Self::new(ERR_CAPABILITY, msg)
    }
    pub(super) fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ERR_INVALID_PARAMS, msg)
    }
    pub(super) fn tab_not_found(tab_id: &str) -> Self {
        Self::new(ERR_TAB_NOT_FOUND, format!("tab '{tab_id}' not found"))
    }
    pub(super) fn internal(msg: impl Into<String>) -> Self {
        Self::new(ERR_INTERNAL, msg)
    }
}

/// Documented argument key names per action (the child tool's param
/// table; `element` is agent-stated intent, not an action arg). The
/// host-boundary failure log quotes these KEY NAMES — never the values —
/// so a field failure is diagnosable without leaking argument data
/// (CWE-532). Pure: pinned by unit tests.
pub fn action_arg_keys(action: &str) -> &'static [&'static str] {
    match action {
        "navigate" => &["url", "tabId"],
        "new_tab" => &["url"],
        "click" => &["ref", "tabId"],
        "fill" => &["ref", "value", "tabId"],
        "type" => &["text", "ref", "tabId"],
        "press" => &["key", "ref", "tabId"],
        "scroll" => &["dy", "ref", "tabId"],
        "hover" => &["ref", "tabId"],
        "wait" => &["ms", "text", "tabId"],
        "close_tab" | "back" | "forward" | "reload" | "snapshot" | "screenshot" => &["tabId"],
        // `list_tabs` and unknown actions take no documented arguments.
        _ => &[],
    }
}

/// Argument key names the host-boundary failure log prints for `err`
/// (pure): the error's per-site keys when attached, else the action's
/// documented table — every failure logs its argument shape even when
/// the error site couldn't name the specific failing key. This is the
/// SINGLE fallback (error sites and dispatch must not pre-stamp: a
/// pre-stamp erases the site-keys-vs-table distinction and duplicates
/// this line's output by construction).
pub fn boundary_arg_keys(err: &BrowserError, action: &str) -> Vec<&'static str> {
    if err.arg_keys.is_empty() {
        action_arg_keys(action).to_vec()
    } else {
        err.arg_keys.clone()
    }
}

/// Sanitize the agent-supplied action string for interpolation into the
/// boundary line (pure — unit-tested): strip control characters (newline
/// injection would forge extra log lines), then replace the whole string
/// with "unknown" if it still carries a field-forging marker (" session="
/// / " arg_keys=") or is empty.
fn sanitize_action(action: &str) -> String {
    let stripped: String = action.chars().filter(|c| !c.is_control()).collect();
    if stripped.is_empty()
        || stripped.contains(" session=")
        || stripped.contains(" arg_keys=")
        || stripped.contains(" agent=")
    {
        "unknown".to_string()
    } else {
        stripped
    }
}

/// Host-boundary failure log line (pure — pinned by unit tests): wire
/// error code + action + argument key names + agent id + redacted
/// session id. Deliberately excludes the error message — messages can
/// embed argument values (invalid urls, refs, typed text; CWE-532). The
/// agent-facing reply keeps the full message (it is the tool result,
/// values allowed there).
pub fn boundary_failure_line(
    code: &str,
    action: &str,
    arg_keys: &[&'static str],
    agent_id: &str,
    redacted_session: &str,
) -> String {
    let code = if code.is_empty() { "unknown" } else { code };
    let action = sanitize_action(action);
    format!(
        "{BROWSER_CALL_FAILED_PREFIX} [{code}] action={action} arg_keys=[{}] agent={agent_id} session={redacted_session}",
        arg_keys.join(", ")
    )
}
