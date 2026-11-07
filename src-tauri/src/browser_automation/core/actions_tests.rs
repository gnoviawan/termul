use serde_json::json;

use super::*;
use crate::browser_automation::{ERR_INVALID_PARAMS, ERR_TAB_NOT_FOUND};

#[test]
fn url_allowlist_accepts_http_s_only() {
    assert!(check_url("https://example.com").is_ok());
    assert!(check_url("http://127.0.0.1:3000/app").is_ok());
    for bad in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<h1>x</h1>",
        "about:blank",
        "not a url",
        "",
    ] {
        let err = check_url(bad).unwrap_err();
        assert_eq!(err.code, ERR_INVALID_PARAMS);
        // Site attribution pinned from origin: the failing key is `url`.
        assert_eq!(err.arg_keys, vec!["url"], "must name 'url': {bad}");
    }
}

#[test]
fn require_url_arg_missing_or_non_string_names_url() {
    let missing = require_url_arg(&json!({ "tabId": "t-1" }), "navigate")
        .expect_err("missing url must error");
    assert_eq!(missing.code, ERR_INVALID_PARAMS);
    // Site attribution pinned from origin: the failing key is `url`.
    assert_eq!(missing.arg_keys, vec!["url"]);
    assert!(
        missing.message.contains("url"),
        "must name 'url': {}",
        missing.message
    );
    assert!(
        missing.message.contains("navigate"),
        "must name the action: {}",
        missing.message
    );

    let non_string = require_url_arg(&json!({ "url": 7 }), "new_tab")
        .expect_err("non-string url must error");
    assert_eq!(non_string.code, ERR_INVALID_PARAMS);
    assert_eq!(non_string.arg_keys, vec!["url"]);
    assert!(
        non_string.message.contains("url"),
        "must name 'url': {}",
        non_string.message
    );
    assert!(
        non_string.message.contains("new_tab"),
        "must name the action: {}",
        non_string.message
    );

    let ok =
        require_url_arg(&json!({ "url": "https://example.com" }), "navigate")
            .expect("string url extracts");
    assert_eq!(ok, "https://example.com");
}

#[test]
fn a_malformed_tab_id_is_tab_not_found_never_the_default_tab() {
    assert_eq!(tab_id_arg(&json!({})).unwrap(), None, "absent means the default tab");
    assert_eq!(tab_id_arg(&json!({"tabId": null})).unwrap(), None);
    for bad in [json!(7), json!(""), json!(["agent-a"])] {
        let err = tab_id_arg(&json!({ "tabId": bad })).expect_err("malformed tabId");
        assert_eq!((err.code, err.reason), (ERR_TAB_NOT_FOUND, Some("malformed_tab_id")), "{bad}");
        assert_eq!(err.arg_keys, vec!["tabId"]);
    }
    assert_eq!(tab_id_arg(&json!({"tabId": "agent-a"})).unwrap().as_deref(), Some("agent-a"));
}

#[test]
fn check_ref_validates_host_minted_tokens_naming_ref() {
    // Host-minted `@eN` shape only.
    assert!(check_ref("@e12").is_ok());
    for bad in ["@e", "@ex", "e3", "@e3x", ""] {
        let err = check_ref(bad).unwrap_err();
        assert_eq!(err.code, ERR_INVALID_PARAMS);
        // Site attribution pinned from origin: the failing key is `ref`.
        assert_eq!(err.arg_keys, vec!["ref"], "must name 'ref': {bad}");
    }
}
