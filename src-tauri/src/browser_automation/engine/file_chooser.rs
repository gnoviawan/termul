//! Files the host staged for an agent tab's next file chooser.
//!
//! WebKit sets a file input's files only by answering the chooser the
//! input opens. An upload stages its files here, has the input open its
//! chooser from the isolated world, and the adapter's chooser hook answers
//! with what it finds staged. A chooser that opens with nothing staged is
//! cancelled, so an agent tab never shows the native file panel.
//!
//! The engine objects belong to the UI thread, so the staged files live in
//! a UI-thread table keyed by tab label, like held dialogs.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use tokio::sync::oneshot;

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
use super::string_eval::{self, CallResult};
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
use super::{EngineError, EngineErrorKind};

struct Staged {
    files: Vec<PathBuf>,
    chosen: oneshot::Sender<()>,
}

thread_local! {
    static STAGED: RefCell<HashMap<String, Staged>> = RefCell::new(HashMap::new());
}

/// Stage `files` for the next chooser `tab` opens; `chosen` fires once a
/// chooser took them. An earlier staging for the tab is dropped, which its
/// waiter sees as a closed channel.
pub fn stage(tab: &str, files: Vec<PathBuf>, chosen: oneshot::Sender<()>) {
    STAGED.with(|staged| {
        staged
            .borrow_mut()
            .insert(tab.to_string(), Staged { files, chosen })
    });
}

/// What a chooser `tab` just opened answers with: the staged files, or
/// `None` to cancel it. Staged files answer one chooser only.
pub fn answer(tab: &str) -> Option<Vec<PathBuf>> {
    let staged = STAGED.with(|staged| staged.borrow_mut().remove(tab))?;
    let _ = staged.chosen.send(());
    Some(staged.files)
}

/// Drop what `tab` has staged, when its upload gave up or it closes.
pub fn release_tab(tab: &str) {
    STAGED.with(|staged| staged.borrow_mut().remove(tab));
}

/// Whether an answered chooser's files reached the page: the input's
/// `input` or `change` fired after they were set (`heard`), or the input
/// holds at least `want` files (`count`, from the `input_file_count`
/// helper). A page may clear the input, or replace it, in its handler, so
/// what was heard wins. Fails when `count` says the path names no file
/// input and nothing was heard.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn upload_landed(count: &serde_json::Value, want: usize, heard: bool) -> Result<bool, EngineError> {
    if heard {
        return Ok(true);
    }
    match count.as_i64() {
        Some(n) if n >= 0 => Ok(usize::try_from(n).is_ok_and(|n| n >= want)),
        _ => Err(EngineError::new(EngineErrorKind::PageException)),
    }
}

/// One poll of the settle wait: `Ok(true)` once the upload landed,
/// `Ok(false)` to poll again, an error once the wait is over (`expired`).
/// The chooser opened from a file input at the path, so a path that names
/// none now was replaced or removed, likely in a change handler whose watch
/// answer has not arrived yet: wait for it until the deadline, and only then
/// fail with `PageException`. Files that never arrive end in `Timeout`.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn settle_poll(
    count: &serde_json::Value,
    want: usize,
    heard: bool,
    expired: bool,
) -> Result<bool, EngineError> {
    match upload_landed(count, want, heard) {
        Ok(true) => Ok(true),
        Ok(false) if expired => Err(EngineError::new(EngineErrorKind::Timeout)),
        Err(e) if expired => Err(e),
        _ => Ok(false),
    }
}

/// Whether the `watch_input_files` call has answered that the input
/// changed. False while it still watches, and when it ran out or failed.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn heard_change(watch: &mut oneshot::Receiver<CallResult>) -> bool {
    watch.try_recv().is_ok_and(|result| {
        matches!(
            string_eval::parse(result),
            Ok(serde_json::Value::Bool(true))
        )
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use ui::set_input_files;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod ui {
    use std::path::PathBuf;

    use serde_json::Value;
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    use super::{heard_change, release_tab, settle_poll, stage};
    use crate::browser_automation::budgets::{FILE_CHOOSER, UPLOAD_SETTLE, UPLOAD_WATCH};
    use crate::browser_automation::engine::string_eval::{self, CallResult, Completion};
    use crate::browser_automation::engine::{assets, EngineError, EngineErrorKind};
    use crate::browser_tab_manager::BrowserTabManager;

    /// Set `files` on the file input at `path`: stage them, have the input
    /// open its chooser through the adapter's `eval`, and wait for the
    /// adapter's chooser hook to take them.
    pub async fn set_input_files<F>(
        tabs: &BrowserTabManager,
        tab: &str,
        path: &str,
        files: &[PathBuf],
        eval: F,
    ) -> Result<(), EngineError>
    where
        F: Fn(&PlatformWebview, &str, &str, Completion) + Copy + Send + 'static,
    {
        let script = assets::open_file_chooser(path);
        let body = string_eval::call_body(&script);
        let params = string_eval::params_json(&script);
        let watch = assets::watch_input_files(path, UPLOAD_WATCH);
        let watch_body = string_eval::call_body(&watch);
        let watch_params = string_eval::params_json(&watch);
        let (watch_tx, watch_rx) = oneshot::channel();
        let (chosen_tx, chosen_rx) = oneshot::channel();
        let label = tab.to_string();
        let want = files.len();
        let files = files.to_vec();
        // Staged in the same UI-thread job that opens the chooser, so the
        // hook can never see the chooser before the files. The watch is
        // issued first in that job, so it listens before the files are set.
        let opened = string_eval::call(tabs, tab, move |platform, done| {
            eval(platform, &watch_body, &watch_params, watch_tx);
            stage(&label, files, chosen_tx);
            eval(platform, &body, &params, done);
        })
        .await;
        let outcome = match opened {
            Ok(Value::Bool(true)) => match tokio::time::timeout(FILE_CHOOSER, chosen_rx).await {
                Ok(Ok(())) => return wait_for_files(tabs, tab, path, want, watch_rx, eval).await,
                Ok(Err(_)) => EngineError::new(EngineErrorKind::NoReply),
                Err(_) => EngineError::new(EngineErrorKind::Timeout),
            },
            // The path names no file input.
            Ok(_) => EngineError::new(EngineErrorKind::PageException),
            Err(e) => e,
        };
        if let Ok(webview) = tabs.webview(tab) {
            let label = tab.to_string();
            let _ = webview.with_webview(move |_| release_tab(&label));
        }
        Err(outcome)
    }

    /// The chooser hook answered, but WebKit may fill the input (and fire
    /// its `change`) a moment later: WKWebView on macOS 15 does. Report the
    /// upload only once the input holds the files or fired `input` or
    /// `change` (`watch`), so the agent's next step sees them even when the
    /// page cleared the input in its handler.
    async fn wait_for_files<F>(
        tabs: &BrowserTabManager,
        tab: &str,
        path: &str,
        want: usize,
        mut watch: oneshot::Receiver<CallResult>,
        eval: F,
    ) -> Result<(), EngineError>
    where
        F: Fn(&PlatformWebview, &str, &str, Completion) + Copy + Send + 'static,
    {
        let script = assets::input_file_count(path);
        let body = string_eval::call_body(&script);
        let params = string_eval::params_json(&script);
        let deadline = tokio::time::Instant::now() + UPLOAD_SETTLE;
        loop {
            let (body, params) = (body.clone(), params.clone());
            let count = string_eval::call(tabs, tab, move |platform, done| {
                eval(platform, &body, &params, done)
            })
            .await?;
            // A watch answers once, so a change heard ends the wait here.
            let heard = heard_change(&mut watch);
            let expired = tokio::time::Instant::now() >= deadline;
            match settle_poll(&count, want, heard, expired) {
                Ok(true) => {
                    if heard {
                        log::debug!(
                            "[browser-tab] upload landed: the file input fired input or change"
                        );
                    }
                    return Ok(());
                }
                Ok(false) => tokio::time::sleep(SETTLE_POLL).await,
                Err(e) => {
                    log::warn!(
                        "[browser-tab] upload chooser answered but the file input never held the files or changed ({:?})",
                        e.kind
                    );
                    return Err(e);
                }
            }
        }
    }

    const SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(50);
}

#[cfg(test)]
#[path = "file_chooser_tests.rs"]
mod tests;
