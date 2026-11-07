//! What the host does about in-page events on agent tabs: script dialogs
//! (decided by [`super::dialogs`], answered through the engine), popups
//! (opened as owned popup tabs), and external-app launches (denied on
//! every tab). Also the reply side: a dialog that opens while a call runs
//! ends the call with the dialog in `page.dialog`, and popup outcomes
//! reach the opener's next reply as `data.popups`.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};
use tauri::Url;

use super::actions::check_url;
use super::dialogs::Disposition;
use super::dispatch::{self, ActionSpec, Verb};
use super::events::label_prefix;
use super::reply::{engine_error, Fidelity, PageData, Success};
use super::tabs::{mint_agent_label, BrowserAgentTabEvent, PopupNote, EVENT_AGENT_TAB};
use super::{spawn, BrowserCall, BrowserError, DesktopBrowserHost, ERR_CONFIRMATION};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::events::{DialogAnswer, DialogKind};
use crate::browser_automation::engine::{CapabilityId, Support};

/// Schemes a page may navigate to without leaving the engine. termul's
/// own app schemes are left to the host perimeter, which denies them.
const IN_ENGINE_SCHEMES: [&str; 12] = [
    "http",
    "https",
    "about",
    "data",
    "blob",
    "javascript",
    "file",
    "ws",
    "wss",
    "tauri",
    "asset",
    "ipc",
];

/// Whether a navigation to `url` would hand it to another application.
pub(super) fn launches_external_app(url: &Url) -> bool {
    !IN_ENGINE_SCHEMES.contains(&url.scheme())
}

pub(super) fn log_external_launch(tab: &str) {
    log::info!(
        "[browser-tab] external app launch denied tab={}",
        label_prefix(tab)
    );
}

/// The fidelity a mutating call reports when a dialog ended it before its
/// engine step returned: the tier of the input the step was using.
fn interrupted_fidelity(verb: Verb, host: &DesktopBrowserHost) -> Fidelity {
    let tier = |id| match host.engine.facts().capabilities.get(id) {
        Support::Trusted => Fidelity::Trusted,
        Support::Synthetic | Support::Unavailable(_) => Fidelity::Synthetic,
    };
    match verb {
        Verb::Click | Verb::Check | Verb::Uncheck => tier(CapabilityId::PointerClick),
        Verb::Drag => tier(CapabilityId::Drag),
        Verb::Navigate | Verb::Back | Verb::Forward | Verb::Reload => Fidelity::Trusted,
        _ => Fidelity::Synthetic,
    }
}

impl DesktopBrowserHost {
    /// Refuse a page verb on a tab a dialog blocks. Tab resolution errors
    /// are left to the verb.
    pub(super) fn refuse_if_blocked(
        &self,
        session_id: &str,
        verb: Verb,
        args: &Value,
    ) -> Result<(), BrowserError> {
        if !verb.touches_page() {
            return Ok(());
        }
        let Ok(label) = self.resolve_tab(session_id, args) else {
            return Ok(());
        };
        let registry = self.registry.lock();
        let Some(open) = registry.get(&label).and_then(|r| r.dialogs.open()) else {
            return Ok(());
        };
        Err(BrowserError::new(
            ERR_CONFIRMATION,
            format!(
                "a {} dialog is open on this tab; answer it with handle_dialog first",
                open.kind.as_str()
            ),
        )
        .with_reason("tab_blocked"))
    }

    /// Run the verb; if a dialog starts holding its tab first, reply at
    /// once with the dialog instead of waiting on a page that cannot move.
    pub(super) async fn act_watched(
        &self,
        session_id: &str,
        spec: &'static ActionSpec,
        call: BrowserCall,
        deadline: Deadline,
    ) -> Result<Success, BrowserError> {
        let watched = spec
            .verb
            .touches_page()
            .then(|| self.resolve_tab(session_id, &call.args).ok())
            .flatten()
            .and_then(|label| {
                let watch = self.registry.lock().get(&label)?.dialogs.watch();
                Some((label, watch))
            });
        let result = match watched {
            None => self.act(session_id, spec.verb, call, deadline).await,
            Some((label, mut held)) => tokio::select! {
                result = self.act(session_id, spec.verb, call, deadline) => result,
                Ok(()) = held.changed() => Ok(Success {
                    fidelity: spec.mutating.then(|| interrupted_fidelity(spec.verb, self)),
                    tab: self.tab_facts(&label).ok(),
                    ..Success::default()
                }),
            },
        };
        result.map(|success| self.with_page_events(success))
    }

    /// Add the dialog and popup outcomes of the reply's tab.
    fn with_page_events(&self, mut success: Success) -> Success {
        let Some(label) = success.tab.as_ref().map(|t| t.id.clone()) else {
            return success;
        };
        let (dialog, popups, meta) = {
            let mut registry = self.registry.lock();
            let Some(record) = registry.get_mut(&label) else {
                return success;
            };
            let meta = PageData::meta(&record.url, &record.title);
            (
                record.dialogs.report(),
                std::mem::take(&mut record.popups),
                meta,
            )
        };
        if let Some(dialog) = dialog {
            success.page.get_or_insert(meta).dialog = Some(dialog);
        }
        if !popups.is_empty() {
            let data = success.data.get_or_insert_with(|| json!({}));
            if let Some(map) = data.as_object_mut() {
                map.insert("popups".to_string(), json!(popups));
            }
        }
        success
    }

    /// The engine holds a dialog the registry just decided.
    pub(super) fn on_dialog(
        self: &Arc<Self>,
        label: &str,
        id: u64,
        kind: DialogKind,
        disposition: Disposition,
    ) {
        log::info!(
            "[browser-agent] dialog kind={} {} tab={}",
            kind.as_str(),
            match disposition {
                Disposition::Accept => "accepted",
                Disposition::Dismiss => "dismissed",
                Disposition::Hold => "held for the agent",
            },
            label_prefix(label)
        );
        let me = Arc::downgrade(self);
        let label = label.to_string();
        let answer = match disposition {
            Disposition::Accept => DialogAnswer::Accept { text: None },
            Disposition::Dismiss => DialogAnswer::Dismiss,
            Disposition::Hold => {
                spawn(expire_after_budget(me, label, id));
                return;
            }
        };
        spawn(async move {
            if let Some(host) = me.upgrade() {
                host.deliver(&label, id, answer).await;
            }
        });
    }

    async fn deliver(&self, label: &str, id: u64, answer: DialogAnswer) -> bool {
        match self.engine.answer_dialog(label, id, answer).await {
            Ok(delivered) => delivered,
            Err(e) => {
                log::warn!(
                    "[browser-agent] dialog answer failed tab={} ({:?})",
                    label_prefix(label),
                    e.kind
                );
                false
            }
        }
    }

    pub(super) async fn handle_dialog(
        &self,
        session_id: &str,
        args: &Value,
    ) -> Result<Success, BrowserError> {
        let label = self.resolve_tab(session_id, args)?;
        let accept = args.get("accept").and_then(Value::as_bool).unwrap_or(false);
        let claimed = {
            let mut registry = self.registry.lock();
            let dialogs = registry.get_mut(&label).map(|r| &mut r.dialogs);
            dialogs.and_then(|d| {
                let open = d.open()?.clone();
                d.answered(open.id, accept).map(|view| (open, view))
            })
        };
        let Some((open, view)) = claimed else {
            return Err(
                BrowserError::invalid("no dialog is open on this tab").with_reason("no_dialog")
            );
        };
        let answer = if accept {
            let text = args.get("text").and_then(Value::as_str);
            DialogAnswer::Accept {
                text: (open.kind == DialogKind::Prompt).then(|| {
                    text.map(str::to_string)
                        .or(open.view.default_text.clone())
                        .unwrap_or_default()
                }),
            }
        } else {
            DialogAnswer::Dismiss
        };
        let delivered = self
            .engine
            .answer_dialog(&label, open.id, answer)
            .await
            .map_err(|e| engine_error(e, &label))?;
        if !delivered {
            return Err(
                BrowserError::invalid("the dialog already closed").with_reason("dialog_closed")
            );
        }
        let mut page = self.page_meta(&label);
        if let Some(page) = page.as_mut() {
            page.dialog = Some(view);
        }
        Ok(Success {
            fidelity: Some(Fidelity::Trusted),
            tab: Some(self.tab_facts(&label)?),
            page,
            ..Success::default()
        })
    }

    /// The page on agent tab `opener` asked for a new window: open it as
    /// an owned popup tab, or record why not.
    pub(super) fn on_new_window(self: &Arc<Self>, opener: &str, session_id: &str, url: &str) {
        let refuse = |reason: &'static str| {
            log::info!(
                "[browser-agent] popup blocked tab={} reason={reason}",
                label_prefix(opener)
            );
            self.registry
                .lock()
                .note_popup(opener, PopupNote::Blocked(reason));
        };
        if self.gate.is_stopped(session_id) {
            return refuse("stopped_by_user");
        }
        if dispatch::floor_gap(self.engine.facts()).is_some() {
            return refuse("engine_floor");
        }
        let Ok(url) = check_url(url) else {
            return refuse("popup_url_not_http");
        };
        let label = mint_agent_label();
        let opened = self.registry.lock().expect_popup_tab(&label, opener, &url);
        let opened = match opened {
            Ok(opened) => opened,
            Err(refusal) => return refuse(refusal.reason()),
        };
        self.registry
            .lock()
            .note_popup(opener, PopupNote::Opened(label.clone()));
        self.emit(
            Some(session_id),
            EVENT_AGENT_TAB,
            &BrowserAgentTabEvent {
                action: "open",
                tab_id: label.clone(),
                url: Some(url),
                session_id: session_id.to_string(),
            },
        );
        log::info!(
            "[browser-agent] popup of tab {} opening as tab {}",
            label_prefix(opener),
            label_prefix(&label)
        );
        let me = Arc::downgrade(self);
        spawn(async move {
            let mounted = matches!(
                tokio::time::timeout(budgets::TAB_OPEN, opened).await,
                Ok(Ok(Ok(_)))
            );
            if !mounted {
                if let Some(host) = me.upgrade() {
                    host.registry.lock().forget_pending(&label);
                }
                log::warn!(
                    "[browser-agent] popup tab {} was not mounted",
                    label_prefix(&label)
                );
            }
        });
    }

    /// Stop closes the session's popups.
    pub(super) fn close_popups(self: &Arc<Self>, session_id: &str) {
        let popups = self.registry.lock().session_popups(session_id);
        if popups.is_empty() {
            return;
        }
        let me = self.clone();
        let session_id = session_id.to_string();
        spawn(async move {
            for label in popups {
                me.close_agent_tab(&label, &session_id).await;
            }
        });
    }
}

/// Dismiss a held dialog the agent did not answer within the budget.
async fn expire_after_budget(host: Weak<DesktopBrowserHost>, label: String, id: u64) {
    tokio::time::sleep(budgets::DIALOG_ANSWER).await;
    let Some(host) = host.upgrade() else {
        return;
    };
    let expired = host
        .registry
        .lock()
        .get_mut(&label)
        .is_some_and(|r| r.dialogs.expired(id));
    if expired {
        log::info!(
            "[browser-agent] dialog dismissed unanswered tab={}",
            label_prefix(&label)
        );
        host.deliver(&label, id, DialogAnswer::Dismiss).await;
    }
}

#[cfg(test)]
#[path = "page_events_tests.rs"]
mod tests;
