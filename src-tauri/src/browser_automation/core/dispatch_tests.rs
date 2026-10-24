use serde_json::{json, Value};

use super::*;
use crate::browser_automation::engine::{CapabilityTable, EngineTraits};
use crate::browser_automation::{ERR_INVALID_PARAMS, ERR_CAPABILITY};

const ALL_VERBS: [&str; 25] = [
    "navigate",
    "snapshot",
    "screenshot",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "hover",
    "upload",
    "wait",
    "new_tab",
    "list_tabs",
    "close_tab",
    "back",
    "forward",
    "reload",
    "select_option",
    "check",
    "uncheck",
    "switch_tab",
    "handle_dialog",
    "console",
    "network",
    "drag",
];

fn no_screenshots() -> EngineFacts {
    EngineFacts {
        capabilities: CapabilityTable::uniform(Support::Synthetic)
            .with(CapabilityId::Screenshot, Support::Unavailable("no screenshots here")),
        traits: EngineTraits {
            isolated_world: true,
            background_render: false,
            network_observe: false,
        },
    }
}

#[test]
fn registry_holds_each_verb_once_in_documented_order() {
    let names: Vec<&str> = REGISTRY.iter().map(|s| s.name).collect();
    assert_eq!(names, ALL_VERBS);
    for name in ALL_VERBS {
        assert_eq!(spec(name).map(|s| s.name), Some(name));
    }
    assert!(spec("teleport").is_none());
    assert!(spec("Navigate").is_none(), "verbs are exact lowercase names");
}

#[test]
fn expected_args_text_comes_from_the_registry() {
    let table = [
        ("navigate", "'url' (optional 'tabId')"),
        ("new_tab", "'url'"),
        ("click", "'ref' (optional 'tabId')"),
        ("fill", "'ref' and 'value' (optional 'tabId')"),
        ("type", "'text' (optional 'ref', 'tabId')"),
        ("press", "optional 'key', 'ref', 'tabId'"),
        ("scroll", "optional 'dy', 'ref', 'tabId'"),
        ("hover", "'ref' (optional 'tabId')"),
        ("upload", "'ref' and 'path' (optional 'tabId')"),
        ("drag", "'ref' and 'toRef' (optional 'tabId')"),
        ("wait", "'ms' or 'text' or 'textGone' or 'urlContains' or 'loadState' (optional 'tabId')"),
        ("select_option", "'ref' and 'value' (optional 'tabId')"),
        ("check", "'ref' (optional 'tabId')"),
        ("switch_tab", "'tabId'"),
        ("handle_dialog", "'accept' (optional 'text', 'tabId')"),
        ("snapshot", "optional 'tabId'"),
        ("back", "optional 'tabId'"),
        ("list_tabs", "no arguments"),
        ("teleport", "action-specific fields"),
    ];
    for (action, text) in table {
        assert_eq!(expected_args_text(action), text, "{action}");
    }
}

#[test]
fn validate_names_missing_required_keys_and_the_one_of_rule() {
    let err = spec("fill").unwrap().validate(&mut json!({ "ref": "@e1" })).unwrap_err();
    assert_eq!(err.code, ERR_INVALID_PARAMS);
    assert_eq!(err.message, "fill needs 'ref' and 'value' (optional 'tabId')");
    assert_eq!(err.arg_keys, vec!["value"]);

    let err = spec("navigate").unwrap().validate(&mut Value::Null).unwrap_err();
    assert_eq!(err.arg_keys, vec!["url"]);

    let err = spec("wait").unwrap().validate(&mut json!({ "tabId": "agent-a" })).unwrap_err();
    assert_eq!(
        err.message,
        "wait needs 'ms' or 'text' or 'textGone' or 'urlContains' or 'loadState' (optional 'tabId')"
    );
    assert_eq!(err.arg_keys, vec!["ms", "text", "textGone", "urlContains", "loadState"]);

    // JSON null counts as absent.
    let err = spec("navigate").unwrap().validate(&mut json!({ "url": null })).unwrap_err();
    assert_eq!(err.arg_keys, vec!["url"]);
}

#[test]
fn validate_rejects_wrong_json_types_naming_the_key() {
    for (action, args, key, message) in [
        ("navigate", json!({ "url": 7 }), "url", "navigate: 'url' must be a string"),
        ("navigate", json!({ "url": "https://x", "tabId": 3 }), "tabId", "navigate: 'tabId' must be a string"),
        ("wait", json!({ "ms": "soon" }), "ms", "wait: 'ms' must be a non-negative integer"),
        ("wait", json!({ "ms": -1 }), "ms", "wait: 'ms' must be a non-negative integer"),
        ("wait", json!({ "ms": "-1" }), "ms", "wait: 'ms' must be a non-negative integer"),
        ("wait", json!({ "ms": "1.5" }), "ms", "wait: 'ms' must be a non-negative integer"),
        ("wait", json!({ "ms": "" }), "ms", "wait: 'ms' must be a non-negative integer"),
        ("scroll", json!({ "dy": "down" }), "dy", "scroll: 'dy' must be a number"),
        ("scroll", json!({ "dy": "NaN" }), "dy", "scroll: 'dy' must be a number"),
        ("scroll", json!({ "dy": "inf" }), "dy", "scroll: 'dy' must be a number"),
    ] {
        let mut args = args;
        let err = spec(action).unwrap().validate(&mut args).unwrap_err();
        assert_eq!((err.message.as_str(), err.arg_keys.clone()), (message, vec![key]));
    }
}

#[test]
fn validate_accepts_well_formed_calls_and_ignores_unknown_keys() {
    for (action, args) in [
        ("navigate", json!({ "url": "https://example.com" })),
        ("wait", json!({ "ms": 0 })),
        ("wait", json!({ "text": "Done" })),
        ("scroll", json!({ "dy": -120.5 })),
        ("scroll", Value::Null),
        ("list_tabs", json!({ "foo": 1 })),
        ("press", json!({})),
    ] {
        let mut args = args;
        spec(action)
            .unwrap()
            .validate(&mut args)
            .unwrap_or_else(|e| panic!("{action} {args}: {}", e.message));
    }
}

#[test]
fn quoted_numbers_for_numeric_keys_are_read_as_numbers() {
    let facts = EngineFacts::all_trusted();
    for (action, args, folded) in [
        ("wait", json!({ "ms": "30000" }), json!({ "ms": 30000 })),
        ("scroll", json!({ "dy": "-250.5" }), json!({ "dy": -250.5 })),
        ("scroll", json!({ "dy": "600", "ref": "@e3" }), json!({ "dy": 600.0, "ref": "@e3" })),
    ] {
        let mut args = args;
        admit(action, &mut args, &facts).unwrap_or_else(|e| panic!("{action}: {}", e.message));
        assert_eq!(args, folded, "{action}");
    }
}

#[test]
fn admit_refuses_unknown_and_withdrawn_verbs_before_any_side_effect() {
    let facts = no_screenshots();
    let err = admit("teleport", &mut Value::Null, &facts).unwrap_err();
    assert_eq!(err.code, ERR_INVALID_PARAMS);
    assert_eq!(
        err.message,
        "unknown action 'teleport'; valid actions: navigate, snapshot, click, fill, type, press, scroll, hover, upload, wait, new_tab, list_tabs, close_tab, back, forward, reload, select_option, check, uncheck, switch_tab, handle_dialog, console, network, drag"
    );

    let err = admit("screenshot", &mut Value::Null, &facts).unwrap_err();
    assert_eq!((err.code, err.message.as_str()), (ERR_CAPABILITY, "no screenshots here"));

    // The capability pre-check runs before argument validation.
    let err = admit("screenshot", &mut json!({ "tabId": 5 }), &facts).unwrap_err();
    assert_eq!(err.code, ERR_CAPABILITY);

    let admitted = admit("click", &mut json!({ "ref": "@e1" }), &facts).expect("synthetic click is available");
    assert_eq!(admitted.verb, Verb::Click);
    assert_eq!(
        admit("click", &mut Value::Null, &facts).unwrap_err().arg_keys,
        vec!["ref"]
    );
}

fn action_enum(schema: &ToolSchema) -> Vec<String> {
    schema.input_schema["properties"]["action"]["enum"]
        .as_array()
        .expect("action enum")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn schema_advertises_every_available_verb_in_flat_and_nested_form() {
    let schema = schema(Some(&EngineFacts::all_trusted()));
    assert_eq!(action_enum(&schema), ALL_VERBS);
    let props = &schema.input_schema["properties"];
    let nested = &props["args"];
    assert_eq!(nested["type"], "object");
    for (key, ty) in [
        ("url", "string"),
        ("tabId", "string"),
        ("ref", "string"),
        ("toRef", "string"),
        ("value", "string"),
        ("text", "string"),
        ("key", "string"),
        ("ms", "integer"),
        ("dy", "number"),
        ("textGone", "string"),
        ("urlContains", "string"),
        ("loadState", "string"),
        ("accept", "boolean"),
        ("cursor", "integer"),
        ("limit", "integer"),
        ("path", "string"),
    ] {
        assert_eq!(props[key]["type"], ty, "flat {key}");
        assert_eq!(nested["properties"][key]["type"], ty, "nested {key}");
    }
    assert_eq!(props["element"]["type"], "string");
    assert_eq!(schema.input_schema["required"], json!(["action"]));
    for line in [
        "- navigate {url, tabId?}:",
        "- fill {ref, value, tabId?}:",
        "- wait {ms?, text?, textGone?, urlContains?, loadState?, tabId?}:",
        "- select_option {ref, value, tabId?}:",
        "- switch_tab {tabId}:",
        "- list_tabs {}:",
        "- upload {ref, path, tabId?}:",
        "- drag {ref, toRef, tabId?}:",
    ] {
        assert!(schema.description.contains(line), "missing {line:?}: {}", schema.description);
    }
    assert!(schema.description.contains("never a string"));
    assert!(!schema.description.contains("Not available on this host"));
    assert!(!schema.description.contains("isolated script world"));
}

#[test]
fn schema_omits_withdrawn_verbs_and_says_which() {
    let schema = schema(Some(&no_screenshots()));
    let verbs = action_enum(&schema);
    assert!(!verbs.contains(&"screenshot".to_string()));
    assert_eq!(verbs.len(), ALL_VERBS.len() - 1);
    assert!(!schema.description.contains("- screenshot"));
    assert!(schema.description.contains("Not available on this host: screenshot."));
    assert!(!schema.description.contains("isolated script world"));
}

fn no_isolated_world() -> EngineFacts {
    EngineFacts {
        capabilities: CapabilityTable::unavailable("isolated eval needs macOS 11 or later"),
        traits: EngineTraits {
            isolated_world: false,
            background_render: false,
            network_observe: false,
        },
    }
}

#[test]
fn an_engine_without_an_isolated_world_advertises_no_page_verb_and_does_not_claim_helpers() {
    let facts = no_isolated_world();
    let schema = schema(Some(&facts));
    assert_eq!(action_enum(&schema), ["list_tabs", "close_tab", "switch_tab"]);
    for withdrawn in ["navigate", "new_tab", "back", "forward", "reload", "wait", "snapshot"] {
        let err = admit(withdrawn, &mut json!({ "url": "https://a.test", "ms": 1 }), &facts).unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (ERR_CAPABILITY, "isolated eval needs macOS 11 or later"),
            "{withdrawn}"
        );
    }
    assert!(schema.description.contains(
        "Not available on this host: navigate, snapshot, screenshot, click, fill, type, press, scroll, hover, upload, wait, new_tab, back, forward, reload, select_option, check, uncheck, handle_dialog, console, network, drag."
    ));
    assert!(schema.description.contains("cannot run page helpers in an isolated script world"));
    assert!(!schema.description.contains("page's own script context"));
}

#[test]
fn schema_without_a_host_fails_closed() {
    let schema = schema(None);
    assert!(schema.description.contains("not available on this host"));
    assert!(schema.description.contains("capability_unavailable"));
    assert_eq!(
        schema.input_schema,
        json!({
            "type": "object",
            "properties": { "action": { "type": "string" } },
            "required": ["action"],
        })
    );
}

#[test]
fn schema_rev_tracks_the_served_content() {
    let trusted = EngineFacts::all_trusted();
    assert_eq!(schema(Some(&trusted)).schema_rev, schema(Some(&trusted)).schema_rev);
    assert_ne!(schema(Some(&trusted)).schema_rev, schema(Some(&no_screenshots())).schema_rev);
    assert_ne!(schema(Some(&trusted)).schema_rev, schema(None).schema_rev);
}

#[test]
fn served_text_never_leaks_an_identifier_name_and_documents_the_key_param() {
    let schema = schema(Some(&EngineFacts::all_trusted()));
    let served = format!("{} {}", schema.description, schema.input_schema);
    assert!(!served.contains("ArgKey"), "{served}");
    assert_eq!(
        schema.input_schema["properties"]["key"]["description"],
        "Key to press: one character, or Enter (the default), Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown or Space."
    );
}

#[test]
fn description_says_where_results_live_and_lists_every_failure_code() {
    let description = schema(Some(&EngineFacts::all_trusted())).description;
    for line in [
        "new_tab gives the new tab's id as tab.id",
        "list_tabs gives data.tabs[], each {tab, page}",
        "snapshot gives the outline in page.snapshot and a ref count in data.refs",
        "screenshot gives the file path in data.path",
        "tab.id is the tabId to pass back",
        "the first call in a session may wait for their answer",
    ] {
        assert!(description.contains(line), "missing {line:?}: {description}");
    }
    for code in [
        "confirmation_required",
        "capability_unavailable",
        "tab_not_found",
        "stale_ref",
        "invalid_params",
        "timeout",
        "internal",
    ] {
        assert!(description.contains(&format!("{code} (")), "missing code {code}: {description}");
    }
}

#[test]
fn a_withdrawn_verb_drops_its_result_line() {
    let description = schema(Some(&no_screenshots())).description;
    assert!(!description.contains("data.path"), "{description}");
    assert!(description.contains("data.refs"));
}

#[test]
fn the_agent_tab_floor_needs_native_download_and_file_chooser_hooks() {
    assert_eq!(floor_gap(&EngineFacts::all_trusted()), None);
    for hook in [CapabilityId::DownloadIntercept, CapabilityId::FileChooser] {
        let facts = EngineFacts {
            capabilities: EngineFacts::all_trusted()
                .capabilities
                .with(hook, Support::Synthetic),
            ..EngineFacts::all_trusted()
        };
        assert_eq!(floor_gap(&facts), Some(hook), "{hook:?}");
    }
}
