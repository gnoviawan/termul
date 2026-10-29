//! Script dialogs an adapter holds open until the core answers them.
//!
//! The engine objects that complete a dialog (a WebView2 deferral, a
//! WKWebView completion block, a WebKitGTK dialog) belong to the UI
//! thread, so held dialogs live in a UI-thread table keyed by tab label
//! and dialog id, and every answer is delivered through `with_webview`.
//! Every engine needs each dialog completed exactly once: a held dialog
//! dropped unanswered is dismissed.

use std::cell::RefCell;
use std::collections::HashMap;

use super::events::DialogAnswer;

type Complete = Box<dyn FnOnce(&DialogAnswer)>;

/// Completes one engine dialog.
pub struct HeldDialog(Option<Complete>);

impl HeldDialog {
    pub fn new(complete: impl FnOnce(&DialogAnswer) + 'static) -> Self {
        Self(Some(Box::new(complete)))
    }

    fn complete(mut self, answer: &DialogAnswer) {
        if let Some(complete) = self.0.take() {
            complete(answer);
        }
    }
}

impl Drop for HeldDialog {
    fn drop(&mut self) {
        if let Some(complete) = self.0.take() {
            complete(&DialogAnswer::Dismiss);
        }
    }
}

thread_local! {
    static HELD: RefCell<HashMap<(String, u64), HeldDialog>> = RefCell::new(HashMap::new());
}

/// Keep `dialog` open until the core answers `(tab, id)`. Runs on the UI
/// thread, inside the engine's dialog hook.
pub fn hold(tab: &str, id: u64, dialog: HeldDialog) {
    HELD.with(|held| held.borrow_mut().insert((tab.to_string(), id), dialog));
}

/// Complete a held dialog. False when it is no longer held.
pub fn answer_held(tab: &str, id: u64, answer: &DialogAnswer) -> bool {
    // Taken out before completing: completion may re-enter the engine.
    let dialog = HELD.with(|held| held.borrow_mut().remove(&(tab.to_string(), id)));
    dialog.map(|d| d.complete(answer)).is_some()
}

/// Dismiss every dialog `tab` still holds, before its webview closes.
pub fn release_tab(tab: &str) {
    let released: Vec<HeldDialog> = HELD.with(|held| {
        let mut held = held.borrow_mut();
        let ids: Vec<(String, u64)> = held.keys().filter(|(t, _)| t == tab).cloned().collect();
        ids.into_iter()
            .filter_map(|key| held.remove(&key))
            .collect()
    });
    drop(released);
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use ui::answer;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod ui {
    use tokio::sync::oneshot;

    use super::answer_held;
    use crate::browser_automation::budgets::TAB_CONFIRM;
    use crate::browser_automation::engine::events::DialogAnswer;
    use crate::browser_automation::engine::{EngineError, EngineErrorKind};
    use crate::browser_tab_manager::BrowserTabManager;

    /// Deliver `answer` to the dialog `tab` holds as `id`, on its UI
    /// thread. Ok(false) when that dialog is no longer held.
    pub async fn answer(
        tabs: &BrowserTabManager,
        tab: &str,
        id: u64,
        answer: DialogAnswer,
    ) -> Result<bool, EngineError> {
        let webview = tabs
            .webview(tab)
            .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
        let (tx, rx) = oneshot::channel();
        let label = tab.to_string();
        webview
            .with_webview(move |_| {
                let _ = tx.send(answer_held(&label, id, &answer));
            })
            .map_err(|_| EngineError::new(EngineErrorKind::Dispatch))?;
        match tokio::time::timeout(TAB_CONFIRM, rx).await {
            Ok(Ok(answered)) => Ok(answered),
            Ok(Err(_)) => Err(EngineError::new(EngineErrorKind::NoReply)),
            Err(_) => Err(EngineError::new(EngineErrorKind::Timeout)),
        }
    }
}

#[cfg(test)]
#[path = "dialogs_tests.rs"]
mod tests;
