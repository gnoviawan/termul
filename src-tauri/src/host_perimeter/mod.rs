//! Host perimeter: what keeps pages in browser tabs away from termul itself.
//!
//! Browser tabs are child webviews of the main window. Tauri injects its IPC
//! bridge into every one of them, and treats the dev server and the app
//! protocol origins as local, so a tab that loads one of those origins would
//! otherwise reach every app command. The rules here close that:
//!
//! - only the main webview reaches app commands ([`main_webview_only`]); the
//!   capability files grant plugin commands to the main webview by label;
//! - tabs never navigate to app origins, termul's own ports, unspecified
//!   addresses or link-local/metadata addresses ([`allow_tab_navigation`]);
//! - engine debug switches inherited from the environment are removed before
//!   any webview starts ([`scrub_engine_debug_env`]).

mod env_scrub;
#[cfg(test)]
mod env_scrub_tests;
mod navigation;
#[cfg(test)]
mod navigation_tests;
mod owned_ports;
#[cfg(test)]
mod owned_ports_tests;
#[cfg(test)]
#[path = "../../tests/browser_fixtures/security/mod.rs"]
mod security_fixtures;

pub(crate) use owned_ports::is_owned as is_owned_port;
pub(crate) use owned_ports::owned_list as owned_ports;
pub(crate) use owned_ports::{claim_for_process, OwnedPort};

use tauri::ipc::Invoke;
use tauri::{Manager, Runtime, Url};

/// The only webview that may invoke app commands. Capability files target it
/// by the same label.
const COMMAND_WEBVIEW_LABEL: &str = "main";

/// Agent tab labels are minted as `agent-<uuid>`.
const AGENT_TAB_LABEL_PREFIX: &str = "agent-";

/// Agentation never runs in agent tabs: its toolbar would hand an
/// agent-driven page a channel into the user's annotation store.
pub(crate) fn agentation_allowed(label: &str) -> bool {
    !label.starts_with(AGENT_TAB_LABEL_PREFIX)
}

/// Wrap the app's command handler so a command from any webview other than
/// the main one is rejected before it runs.
///
/// Tauri checks the ACL for app commands only when the request comes from a
/// remote origin. A tab that loads the dev server or the app protocol origin
/// counts as local, so the label check has to live here.
pub(crate) fn main_webview_only<R, H>(handler: H) -> impl Fn(Invoke<R>) -> bool + Send + Sync
where
    R: Runtime,
    H: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke: Invoke<R>| {
        if invoke.message.webview_ref().label() == COMMAND_WEBVIEW_LABEL {
            return handler(invoke);
        }
        log::warn!(
            "[perimeter] rejected command from tab webview: command={} label={}",
            invoke.message.command(),
            invoke.message.webview_ref().label()
        );
        invoke
            .resolver
            .reject("command not allowed from this webview");
        true
    }
}

fn tab_denial<R: Runtime>(
    manager: &impl Manager<R>,
    label: &str,
    url: &Url,
) -> Option<navigation::TabNavDenial> {
    let dev_url = if tauri::is_dev() {
        manager.config().build.dev_url.clone()
    } else {
        None
    };
    let denial = navigation::tab_navigation_denial(url, owned_ports::is_owned, dev_url.as_ref())?;
    log::warn!(
        "[perimeter] denied tab navigation: reason={} label={label} port={}",
        denial.reason(),
        url.port_or_known_default()
            .map_or_else(|| "none".to_string(), |port| port.to_string())
    );
    Some(denial)
}

/// Navigation verdict for one hop of a tab webview, from the engine's
/// navigation hook. Denials are silent to the page and never prompt; the
/// log line names the reason, label and port only.
pub(crate) fn allow_tab_navigation<R: Runtime>(
    manager: &impl Manager<R>,
    label: &str,
    url: &Url,
) -> bool {
    tab_denial(manager, label, url).is_none()
}

/// The same verdict for a target termul loads itself (tab creation and
/// address-bar navigation). WebView2 sends the request of a navigation it was
/// told to start before the hook can cancel it, so these are refused before
/// the engine sees them.
pub(crate) fn check_tab_target<R: Runtime>(
    manager: &impl Manager<R>,
    label: &str,
    url: &Url,
) -> Result<(), String> {
    match tab_denial(manager, label, url) {
        None => Ok(()),
        Some(denial) => Err(format!(
            "navigation target not allowed ({})",
            denial.reason()
        )),
    }
}

/// What the startup scrub did, for the caller to log once a logger exists.
pub(crate) struct ScrubReport {
    pub(crate) changed: Vec<&'static str>,
    /// Debug builds only: the dev opt-in kept a WebView2 debug switch.
    #[cfg(debug_assertions)]
    pub(crate) engine_debug_kept: bool,
}

/// Remove engine debug and automation switches from this process's
/// environment. Call before any webview is created. A debug build can keep
/// the WebView2 debug port through an explicit opt-in; release builds have
/// no such path.
pub(crate) fn scrub_engine_debug_env() -> ScrubReport {
    let plan = env_scrub::plan(|key| std::env::var_os(key), cfg!(debug_assertions));
    for action in &plan.actions {
        match action {
            env_scrub::EnvScrub::Remove(key) => std::env::remove_var(key),
            env_scrub::EnvScrub::Replace(key, value) => std::env::set_var(key, value),
        }
    }
    ScrubReport {
        changed: plan.actions.iter().map(env_scrub::EnvScrub::key).collect(),
        #[cfg(debug_assertions)]
        engine_debug_kept: plan.engine_debug_kept,
    }
}
