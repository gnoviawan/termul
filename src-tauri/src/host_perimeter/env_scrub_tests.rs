use std::collections::HashMap;
use std::ffi::OsString;

use super::env_scrub::{plan, EnvScrub, ScrubPlan};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, OsString> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), OsString::from(value)))
        .collect()
}

fn plan_in(pairs: &[(&str, &str)], debug_build: bool) -> ScrubPlan {
    let vars = env(pairs);
    plan(|key| vars.get(key).cloned(), debug_build)
}

fn plan_for(pairs: &[(&str, &str)]) -> Vec<EnvScrub> {
    plan_in(pairs, false).actions
}

#[test]
fn clean_environment_needs_no_change() {
    assert_eq!(
        plan_for(&[("PATH", "/usr/bin"), ("RUST_LOG", "debug")]),
        vec![]
    );
}

#[test]
fn webview2_debug_port_is_stripped_and_other_switches_kept() {
    assert_eq!(
        plan_for(&[(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --remote-debugging-port=9222 --lang=en"
        )]),
        vec![EnvScrub::Replace(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --lang=en".to_string()
        )]
    );
}

#[test]
fn webview2_variable_with_only_debug_switches_is_removed() {
    assert_eq!(
        plan_for(&[(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-pipe /REMOTE-DEBUGGING-PORT=1 -remote-debugging-address=0.0.0.0 --remote-allow-origins=*"
        )]),
        vec![EnvScrub::Remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")]
    );
}

#[test]
fn webview2_variable_without_debug_switches_is_untouched() {
    assert_eq!(
        plan_for(&[(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu  --lang=en"
        )]),
        vec![]
    );
}

#[test]
fn inspector_and_automation_variables_are_removed() {
    assert_eq!(
        plan_for(&[
            ("WEBKIT_INSPECTOR_SERVER", "127.0.0.1:9999"),
            ("WEBKIT_INSPECTOR_HTTP_SERVER", "127.0.0.1:9998"),
            ("WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", "pipe"),
            ("TAURI_WEBVIEW_AUTOMATION", "true"),
        ]),
        vec![
            EnvScrub::Remove("WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER"),
            EnvScrub::Remove("WEBKIT_INSPECTOR_SERVER"),
            EnvScrub::Remove("WEBKIT_INSPECTOR_HTTP_SERVER"),
            EnvScrub::Remove("TAURI_WEBVIEW_AUTOMATION"),
        ]
    );
}

#[cfg(unix)]
#[test]
fn non_utf8_webview2_variable_is_removed_whole() {
    use std::os::unix::ffi::OsStringExt;
    let value = OsString::from_vec(vec![0x2d, 0x2d, 0xff]);
    assert_eq!(
        plan(
            |key| (key == "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").then(|| value.clone()),
            false
        )
        .actions,
        vec![EnvScrub::Remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")]
    );
}

const PORT_ARGS: (&str, &str) = (
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--remote-debugging-port=9222",
);

#[cfg(debug_assertions)]
const OPT_IN: &str = super::env_scrub::DEV_OPT_IN;
#[cfg(not(debug_assertions))]
const OPT_IN: &str = "TERMUL_DEV_ALLOW_ENGINE_DEBUG";

#[test]
fn release_build_scrubs_the_debug_port_with_or_without_the_opt_in() {
    for pairs in [
        vec![PORT_ARGS],
        vec![PORT_ARGS, (OPT_IN, "1")],
        vec![PORT_ARGS, (OPT_IN, "true")],
    ] {
        let result = plan_in(&pairs, false);
        assert_eq!(
            result.actions,
            vec![EnvScrub::Remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")]
        );
        assert!(!result.engine_debug_kept);
    }
}

#[test]
fn release_build_still_removes_the_other_engine_variables_with_the_opt_in() {
    assert_eq!(
        plan_in(
            &[("WEBKIT_INSPECTOR_SERVER", "0.0.0.0:9999"), (OPT_IN, "1")],
            false
        )
        .actions,
        vec![EnvScrub::Remove("WEBKIT_INSPECTOR_SERVER")]
    );
}

#[test]
fn debug_build_without_the_opt_in_scrubs_the_debug_port() {
    for pairs in [
        vec![PORT_ARGS],
        vec![PORT_ARGS, (OPT_IN, "0")],
        vec![PORT_ARGS, (OPT_IN, "")],
    ] {
        let result = plan_in(&pairs, true);
        assert_eq!(
            result.actions,
            vec![EnvScrub::Remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")]
        );
        assert!(!result.engine_debug_kept);
    }
}

#[cfg(debug_assertions)]
#[test]
fn debug_build_with_the_opt_in_keeps_the_debug_port() {
    let result = plan_in(&[PORT_ARGS, (OPT_IN, "1")], true);
    assert_eq!(result.actions, vec![]);
    assert!(result.engine_debug_kept);
}

#[cfg(debug_assertions)]
#[test]
fn opt_in_drops_the_bind_address_switch_and_keeps_the_rest() {
    let result = plan_in(
        &[
            (
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-gpu --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0",
            ),
            (OPT_IN, "1"),
        ],
        true,
    );
    assert_eq!(
        result.actions,
        vec![EnvScrub::Replace(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --remote-debugging-port=9222".to_string()
        )]
    );
    assert!(result.engine_debug_kept);
}

#[cfg(debug_assertions)]
#[test]
fn opt_in_alone_does_not_report_a_kept_port() {
    let result = plan_in(&[(OPT_IN, "1"), ("PATH", "/usr/bin")], true);
    assert_eq!(result.actions, vec![]);
    assert!(!result.engine_debug_kept);
}
