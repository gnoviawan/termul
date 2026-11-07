//! Engine debug and automation switches a process can inherit from its
//! environment. Each one makes a webview engine listen on a local port or
//! pipe that any same-user process could attach to and drive the app UI or
//! a tab through.

use std::ffi::OsString;

/// Variables removed outright.
const REMOVED: &[&str] = &[
    // WebView2 script-debugger pipe.
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
    // WebKitGTK remote inspector servers.
    "WEBKIT_INSPECTOR_SERVER",
    "WEBKIT_INSPECTOR_HTTP_SERVER",
    // Makes Tauri enable WebKitGTK automation mode.
    "TAURI_WEBVIEW_AUTOMATION",
];

/// Chromium switches WebView2 reads from this variable. Only the debugging
/// switches are removed; other switches the user set stay.
const WEBVIEW2_ARGS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

const DEBUG_SWITCHES: &[&str] = &["remote-debugging", "remote-allow-origins"];

/// Dropped even under the dev opt-in, so the debug port keeps the engine's
/// loopback default.
const BIND_SWITCH: &str = "remote-debugging-address";

/// Debug builds only. When set to `1` the WebView2 debug port switches
/// survive the scrub so live verification can attach. The name and the read
/// do not exist in release builds.
#[cfg(debug_assertions)]
pub(crate) const DEV_OPT_IN: &str = "TERMUL_DEV_ALLOW_ENGINE_DEBUG";

#[cfg(debug_assertions)]
fn dev_opt_in(read: &impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    read(DEV_OPT_IN)
}

#[cfg(not(debug_assertions))]
fn dev_opt_in(_read: &impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EnvScrub {
    Remove(&'static str),
    Replace(&'static str, String),
}

impl EnvScrub {
    pub(crate) fn key(&self) -> &'static str {
        match self {
            Self::Remove(key) | Self::Replace(key, _) => key,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ScrubPlan {
    pub(crate) actions: Vec<EnvScrub>,
    /// The opt-in was honored and a debug switch stays in the environment.
    /// Only debug builds read it.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub(crate) engine_debug_kept: bool,
}

fn opt_in_honored(debug_build: bool, opt_in: Option<OsString>) -> bool {
    debug_build && opt_in.is_some_and(|value| value == "1")
}

/// What to change, given a reader for the current environment.
/// `debug_build` is `cfg!(debug_assertions)` in production, and a parameter
/// so tests can decide for both build kinds.
pub(crate) fn plan(read: impl Fn(&str) -> Option<OsString>, debug_build: bool) -> ScrubPlan {
    let keep_debug = opt_in_honored(debug_build, dev_opt_in(&read));
    let mut engine_debug_kept = false;
    let mut actions: Vec<EnvScrub> = REMOVED
        .iter()
        .filter(|key| read(key).is_some())
        .map(|key| EnvScrub::Remove(key))
        .collect();
    if let Some(value) = read(WEBVIEW2_ARGS) {
        // A value that is not UTF-8 cannot be split safely, so it goes whole.
        match value.into_string() {
            Err(_) => actions.push(EnvScrub::Remove(WEBVIEW2_ARGS)),
            Ok(text) => {
                let blocked = |arg: &str| {
                    if keep_debug {
                        is_switch(arg, BIND_SWITCH)
                    } else {
                        is_debug_switch(arg)
                    }
                };
                let kept: Vec<&str> = text
                    .split_whitespace()
                    .filter(|arg| !blocked(arg))
                    .collect();
                engine_debug_kept = keep_debug && kept.iter().any(|arg| is_debug_switch(arg));
                if kept.len() != text.split_whitespace().count() {
                    actions.push(if kept.is_empty() {
                        EnvScrub::Remove(WEBVIEW2_ARGS)
                    } else {
                        EnvScrub::Replace(WEBVIEW2_ARGS, kept.join(" "))
                    });
                }
            }
        }
    }
    ScrubPlan {
        actions,
        engine_debug_kept,
    }
}

/// Chromium accepts `--`, `-` and, on Windows, `/` as switch prefixes, and
/// matches switch names case-insensitively on Windows.
fn switch_name(arg: &str) -> Option<String> {
    arg.strip_prefix("--")
        .or_else(|| arg.strip_prefix('-'))
        .or_else(|| arg.strip_prefix('/'))
        .map(str::to_ascii_lowercase)
}

fn is_debug_switch(arg: &str) -> bool {
    switch_name(arg)
        .is_some_and(|name| DEBUG_SWITCHES.iter().any(|switch| name.starts_with(switch)))
}

fn is_switch(arg: &str, switch: &str) -> bool {
    switch_name(arg).is_some_and(|name| name.starts_with(switch))
}
