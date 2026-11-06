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

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use ui::set_input_files;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod ui {
    use std::path::PathBuf;

    use serde_json::Value;
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    use super::{release_tab, stage};
    use crate::browser_automation::budgets::{FILE_CHOOSER, UPLOAD_SETTLE};
    use crate::browser_automation::engine::string_eval::{self, Completion};
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
        let (chosen_tx, chosen_rx) = oneshot::channel();
        let label = tab.to_string();
        let want = files.len();
        let files = files.to_vec();
        // Staged in the same UI-thread job that opens the chooser, so the
        // hook can never see the chooser before the files.
        let opened = string_eval::call(tabs, tab, move |platform, done| {
            stage(&label, files, chosen_tx);
            eval(platform, &body, &params, done);
        })
        .await;
        let outcome = match opened {
            Ok(Value::Bool(true)) => match tokio::time::timeout(FILE_CHOOSER, chosen_rx).await {
                Ok(Ok(())) => return wait_for_files(tabs, tab, path, want, eval).await,
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
    /// upload only once the input holds the files, so the agent's next step
    /// sees them.
    async fn wait_for_files<F>(
        tabs: &BrowserTabManager,
        tab: &str,
        path: &str,
        want: usize,
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
            match count.as_i64() {
                Some(n) if n >= 0 && n as usize >= want => return Ok(()),
                Some(n) if n >= 0 => {}
                _ => return Err(EngineError::new(EngineErrorKind::PageException)),
            }
            if tokio::time::Instant::now() >= deadline {
                log::warn!(
                    "[browser-tab] upload chooser answered but the file input never held the files"
                );
                return Err(EngineError::new(EngineErrorKind::Timeout));
            }
            tokio::time::sleep(SETTLE_POLL).await;
        }
    }

    const SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(50);
}

#[cfg(test)]
#[path = "file_chooser_tests.rs"]
mod tests;
