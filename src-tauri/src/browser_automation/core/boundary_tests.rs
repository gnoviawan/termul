use super::*;
use crate::browser_automation::core::{
    ERR_CAPABILITY, ERR_CONFIRMATION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_STALE_REF,
    ERR_TAB_NOT_FOUND, ERR_TIMEOUT,
};

#[test]
fn action_arg_keys_pin_the_documented_param_table() {
    assert_eq!(action_arg_keys("navigate"), &["url", "tabId"]);
    // `new_tab`'s arm never reads `tabId` — it always mints a tab.
    assert_eq!(action_arg_keys("new_tab"), &["url"]);
    assert_eq!(action_arg_keys("click"), &["ref", "tabId"]);
    assert_eq!(action_arg_keys("fill"), &["ref", "value", "tabId"]);
    // Per-action rows (split from a union): each lists only the keys its
    // arm actually reads.
    assert_eq!(action_arg_keys("type"), &["text", "ref", "tabId"]);
    assert_eq!(action_arg_keys("press"), &["key", "ref", "tabId"]);
    assert_eq!(action_arg_keys("scroll"), &["dy", "ref", "tabId"]);
    assert_eq!(action_arg_keys("hover"), &["ref", "tabId"]);
    assert_eq!(action_arg_keys("drag"), &["ref", "toRef", "tabId"]);
    assert_eq!(
        action_arg_keys("wait"),
        &["ms", "text", "textGone", "urlContains", "loadState", "tabId"]
    );
    for a in ["close_tab", "back", "forward", "reload", "snapshot", "screenshot"] {
        assert_eq!(action_arg_keys(a), &["tabId"]);
    }
    // `list_tabs` and unknown actions take no documented arguments.
    assert!(action_arg_keys("list_tabs").is_empty());
    assert!(action_arg_keys("teleport").is_empty());
}

#[test]
fn boundary_arg_keys_prefer_site_keys_and_fall_back_to_the_action_table() {
    // Per-site keys win when the error site attached them.
    let err = BrowserError::invalid("navigate needs 'url'").with_arg_keys(&["url"]);
    assert_eq!(boundary_arg_keys(&err, "navigate"), vec!["url"]);
    // Deep sites (consent gate, eval gate, transports, the no-host
    // dispatch, stub hosts) attach nothing — the parent log site's
    // fallback stamps the action's documented table (the SINGLE
    // fallback; dispatch/execute never pre-stamp).
    let deep = BrowserError::new(ERR_TIMEOUT, "eval timed out");
    assert_eq!(boundary_arg_keys(&deep, "fill"), vec!["ref", "value", "tabId"]);
    assert_eq!(
        boundary_arg_keys(&deep, "snapshot"),
        vec!["tabId"],
        "unknown/deep errors still log the action's arg shape"
    );
    assert!(
        boundary_arg_keys(&deep, "list_tabs").is_empty(),
        "no documented args → empty shape"
    );
}

/// The boundary line for `err`/`action` (the exact string the host
/// boundary logs, minus the session id which the caller redacts).
fn line_for(err: &BrowserError, action: &str) -> String {
    boundary_failure_line(
        err.code,
        action,
        &boundary_arg_keys(err, action),
        "agent-boundary-check",
        &crate::logging::redact_session_id("sess-boundary-check-123456"),
    )
}

#[test]
fn boundary_failure_line_covers_every_wire_code_with_key_names() {
    // One row per wire error code: the line carries the
    // code, the action, the argument key names, and the agent id.
    let cases: &[(&'static str, &str, BrowserError)] = &[
        // capability_unavailable — the no-host dispatch is a deep site
        // (no keys) → the parent fallback stamps the action table.
        (
            ERR_CAPABILITY,
            "navigate",
            BrowserError::capability("browser automation is only available on the desktop app"),
        ),
        // invalid_params — per-site keys (missing url).
        (
            ERR_INVALID_PARAMS,
            "navigate",
            BrowserError::invalid("navigate needs 'url'").with_arg_keys(&["url"]),
        ),
        // tab_not_found — resolve failure names the tabId key.
        (
            ERR_TAB_NOT_FOUND,
            "click",
            BrowserError::tab_not_found("agent-x").with_arg_keys(&["tabId"]),
        ),
        // stale_ref — helper-failure deep site (no keys) → action table.
        (
            ERR_STALE_REF,
            "click",
            BrowserError::new(ERR_STALE_REF, "stale_ref: @e3 detached"),
        ),
        // timeout — eval both-paths timeout (deep site).
        (ERR_TIMEOUT, "fill", BrowserError::new(ERR_TIMEOUT, "eval timed out")),
        // internal — unexpected error (deep site).
        (
            ERR_INTERNAL,
            "snapshot",
            BrowserError::internal("snapshot eval result was not an object"),
        ),
        // confirmation_required — consent gate (deep site; values never
        // logged).
        (
            ERR_CONFIRMATION,
            "navigate",
            BrowserError::new(
                ERR_CONFIRMATION,
                "user did not grant browser automation for this session",
            ),
        ),
    ];
    for (code, action, err) in cases {
        let line = line_for(err, action);
        assert!(
            line.contains(&format!("[{code}]")),
            "{code} row must carry the code: {line}"
        );
        assert!(
            line.contains(&format!("action={action}")),
            "{code} row must carry the action: {line}"
        );
        assert!(
            line.contains("agent=agent-boundary-check"),
            "{code} row must carry the agent id: {line}"
        );
        let expected_keys = boundary_arg_keys(err, action).join(", ");
        assert!(
            line.contains(&format!("arg_keys=[{expected_keys}]")),
            "{code} row must carry the argument key names: {line}"
        );
    }
}

#[test]
fn boundary_failure_line_never_contains_argument_values() {
    // The error MESSAGE embeds values (url, ref, typed text) — the log
    // line must carry key names only (CWE-532). The message itself still
    // reaches the agent-facing reply unchanged.
    const SECRET_URL: &str = "https://cap6-secret.example/a?token=hunter2";
    let err = BrowserError::invalid(format!("invalid url: {SECRET_URL}")).with_arg_keys(&["url"]);
    let line = line_for(&err, "navigate");
    assert!(!line.contains("cap6-secret.example"), "url leaked: {line}");
    assert!(!line.contains("hunter2"), "query value leaked: {line}");
    assert!(!line.contains("invalid url"), "message text leaked: {line}");
    assert!(line.contains("arg_keys=[url]"), "key name must survive: {line}");

    // Ref values (stale_ref messages name the failing ref).
    let stale = BrowserError::new(ERR_STALE_REF, "stale_ref: @e42 not in this document");
    let line = line_for(&stale, "click");
    assert!(!line.contains("@e42"), "ref value leaked: {line}");

    // Typed text (fill values ride deep internal messages).
    let deep = BrowserError::internal("eval failed after fill 'hunter2'");
    let line = line_for(&deep, "fill");
    assert!(!line.contains("hunter2"), "typed value leaked: {line}");

    // The agent-facing message is unchanged by the boundary line's
    // existence (it is the tool result — values allowed there).
    assert!(err.message.contains(SECRET_URL));
}

#[test]
fn boundary_failure_line_redacts_the_session_id() {
    let line = boundary_failure_line(
        ERR_TAB_NOT_FOUND,
        "click",
        &["tabId"],
        "agent-boundary-check",
        &crate::logging::redact_session_id("sess-boundary-check-123456"),
    );
    assert!(
        line.contains("session=sess-bou…"),
        "session must be redacted: {line}"
    );
    assert!(!line.contains("boundary-check-123456"), "raw session leaked: {line}");
}

#[test]
fn boundary_failure_line_hardens_agent_supplied_action_and_code() {
    // Only RECOGNIZED action names are logged — an agent-supplied action
    // that is not a documented verb (e.g. a URL or token sent as the
    // action) renders as "unknown" instead of flowing into the log.
    let line = boundary_failure_line(
        ERR_TAB_NOT_FOUND,
        "cli\tck",
        &["tabId"],
        "agent-1",
        "sess",
    );
    assert!(line.contains("action=unknown"), "unrecognized action: {line}");
    assert!(!line.contains('\t'), "control char leaked: {line}");

    let line = boundary_failure_line(ERR_TAB_NOT_FOUND, "click", &["tabId"], "agent-1", "sess");
    assert!(line.contains("action=click"), "recognized action renders: {line}");

    // Any non-verb action — forgeries, URLs, tokens, empty — renders as
    // "unknown" and no forged field ever renders.
    for forged in [
        "click session=x",
        "click\n arg_keys=[url]",
        "click\n agent=evil",
        "",
        "https://evil.example/path",
        "tok=sekret",
    ] {
        let line = boundary_failure_line(ERR_TAB_NOT_FOUND, forged, &["tabId"], "agent-1", "sess");
        assert!(
            line.contains("action=unknown"),
            "unrecognized action must render as unknown: {line}"
        );
        assert!(!line.contains("session=x"), "forged session field: {line}");
        assert!(!line.contains("agent=evil"), "forged agent field: {line}");
        assert!(
            !line.contains("arg_keys=[url]"),
            "forged arg_keys field: {line}"
        );
        assert!(
            !line.contains("evil.example") && !line.contains("sekret"),
            "value-bearing action text leaked: {line}"
        );
    }

    // A redacted session prefix containing control characters is stripped
    // before interpolation (CWE-117: no forged log lines). The remaining
    // text stays inside the session value on the same line — it cannot
    // forge a field boundary because session is the final field.
    let line = boundary_failure_line(
        ERR_TAB_NOT_FOUND,
        "click",
        &["tabId"],
        "agent-1",
        "ses\nsion=9 action=navigate",
    );
    assert!(!line.contains('\n'), "newline leaked via session prefix: {line}");
    assert!(!line.contains("ses\nsion"), "control char leaked: {line}");
    assert!(
        line.ends_with("session=session=9 action=navigate"),
        "session prefix text stays inline within the field: {line}"
    );

    // An empty error code renders as "unknown".
    let line = boundary_failure_line("", "click", &["tabId"], "agent-1", "sess");
    assert!(line.contains("[unknown]"), "empty code must render as unknown: {line}");
}
