//! Per-verb handlers: argument checks, the engine and surface calls they
//! make, and the success reply each one shapes.

use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::dispatch::Verb;
use super::events::label_prefix;
use super::ports::CanonicalOrigin;
use super::reply::{
    engine_error, resolve_result, shape_parsed, Fidelity, PageData, PageSnapshot, ResolvedElement, Success, TabFacts,
};
use super::surface::HistoryStep;
use super::tabs::{mint_agent_label, stale_ref_error, BindRefusal, NavOutcome, RefNode, RefStale};
use super::{BrowserError, DesktopBrowserHost, ERR_CONFIRMATION, ERR_TIMEOUT};

#[path = "page_actions.rs"]
mod page_actions;
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::assets::{self, Script};
use crate::browser_automation::BrowserCall;

/// Validate + normalize a navigation target. http(s) only.
pub(super) fn check_url(url: &str) -> Result<String, BrowserError> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| BrowserError::invalid(format!("invalid url: {url}")).with_arg_keys(&["url"]))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        other => Err(BrowserError::invalid(format!(
            "scheme '{other}' is not allowed (http/https only)"
        ))
        .with_arg_keys(&["url"])),
    }
}

/// Extract the required `url` arg for navigate/new_tab — a missing or
/// non-string value fails with `invalid_params` naming the key.
pub(super) fn require_url_arg(args: &Value, action: &str) -> Result<String, BrowserError> {
    args.get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BrowserError::invalid(format!("{action} needs 'url'")).with_arg_keys(&["url"]))
}

/// Extract the optional `tabId` arg. Absent (or JSON null) means the
/// session's default tab. Any other value that is not a string naming a
/// tab is `tab_not_found`: treating it as absent would retarget a tab the
/// caller never named.
pub(super) fn tab_id_arg(args: &Value) -> Result<Option<String>, BrowserError> {
    match args.get("tabId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
        Some(_) => Err(BrowserError::tab_not_found("(malformed tabId)")
            .with_reason("malformed_tab_id")
            .with_arg_keys(&["tabId"])),
    }
}

/// Refs are host-minted `@eN` tokens. Validating before script build
/// keeps an agent-supplied value out of the page entirely (defense in
/// depth on top of the script builders' JSON encoding).
pub(super) fn check_ref(ref_id: &str) -> Result<(), BrowserError> {
    let ok = ref_id.starts_with("@e")
        && ref_id.len() > 2
        && ref_id[2..].chars().all(|c| c.is_ascii_digit());
    if ok {
        Ok(())
    } else {
        Err(BrowserError::invalid(format!("invalid ref '{ref_id}' (expected @eN)")).with_arg_keys(&["ref"]))
    }
}

pub(super) fn ref_arg(args: &Value) -> Result<Option<&str>, BrowserError> {
    let r = args.get("ref").and_then(Value::as_str);
    if let Some(r) = r {
        check_ref(r)?;
    }
    Ok(r)
}

fn required_ref(args: &Value) -> Result<&str, BrowserError> {
    ref_arg(args)?.ok_or_else(|| BrowserError::invalid("missing 'ref'").with_arg_keys(&["ref"]))
}

fn required_to_ref(args: &Value) -> Result<&str, BrowserError> {
    let token = args
        .get("toRef")
        .and_then(Value::as_str)
        .ok_or_else(|| BrowserError::invalid("missing 'toRef'").with_arg_keys(&["toRef"]))?;
    check_ref(token).map_err(|e| e.with_arg_keys(&["toRef"]))?;
    Ok(token)
}

fn mutated(fidelity: Fidelity, tab: TabFacts) -> Success {
    Success {
        fidelity: Some(fidelity),
        tab: Some(tab),
        ..Success::default()
    }
}

/// A ref resolved against the tab's current document. `node.path` is the
/// page helper's locator for the element.
pub(super) struct ResolvedRef {
    pub(super) node: RefNode,
}

impl DesktopBrowserHost {
    /// Host facts for `label` from the registry.
    pub(super) fn tab_facts(&self, label: &str) -> Result<TabFacts, BrowserError> {
        let registry = self.registry.lock();
        let record = registry
            .get(label)
            .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))?;
        Ok(TabFacts {
            id: label.to_string(),
            epoch: record.epoch,
            origin: CanonicalOrigin::parse(&record.url).ok(),
            profile: record
                .profile()
                .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))?,
            opener: record.popup_of.clone(),
        })
    }

    /// Page metadata, with the dialog blocking the tab if there is one.
    pub(super) fn page_meta(&self, label: &str) -> Option<PageData> {
        let registry = self.registry.lock();
        registry.get(label).map(|record| PageData {
            dialog: record.dialogs.open().map(|open| open.view.clone()),
            ..PageData::meta(&record.url, &record.title)
        })
    }

    /// The agent tab an action targets: the explicit `tabId` (which must be
    /// this session's) or the session's default tab.
    pub(super) fn resolve_tab(&self, session_id: &str, args: &Value) -> Result<String, BrowserError> {
        let tab_id = tab_id_arg(args)?;
        self.registry
            .lock()
            .resolve(session_id, tab_id.as_deref())?
            .ok_or_else(|| {
                BrowserError::tab_not_found("(no agent tab — call navigate or new_tab first)")
                    .with_arg_keys(&["tabId"])
            })
    }

    pub(super) fn resolve_ref(&self, label: &str, token: &str) -> Result<ResolvedRef, BrowserError> {
        let registry = self.registry.lock();
        let record = registry
            .get(label)
            .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))?;
        let node = record
            .refs
            .resolve(token, record.epoch)
            .map_err(|why| stale_ref_error(token, why))?
            .clone();
        Ok(ResolvedRef { node })
    }

    /// Run a helper through the engine.
    pub(super) async fn eval(&self, tab_id: &str, script: Script) -> Result<Value, BrowserError> {
        self.engine.evaluate(tab_id, script).await.map_err(|e| {
            // Tab id + kind only: eval failures can quote page content.
            log::warn!("[browser-agent] eval failed on tab {tab_id} ({:?})", e.kind);
            engine_error(e, tab_id)
        })
    }

    /// Wait for the navigation `rx` to commit, then for the document to
    /// become interactive, all inside one post-navigation budget. Returns
    /// the post-commit epoch.
    async fn finish_navigation(
        &self,
        label: &str,
        rx: oneshot::Receiver<NavOutcome>,
        deadline: Deadline,
    ) -> Result<u64, BrowserError> {
        let nav = Deadline::after(deadline.clamp(budgets::NAV_SETTLE));
        let epoch = match tokio::time::timeout(nav.remaining(), rx).await {
            Ok(Ok(NavOutcome::Committed { epoch })) => epoch,
            Ok(Ok(NavOutcome::Denied)) => {
                return Err(BrowserError::new(
                    ERR_CONFIRMATION,
                    "the navigation was blocked by browser policy",
                )
                .with_reason("navigation_denied"));
            }
            Ok(Ok(NavOutcome::Closed) | Err(_)) => {
                return Err(BrowserError::tab_not_found(label)
                    .with_reason("tab_closed")
                    .with_arg_keys(&["tabId"]));
            }
            Err(_) => {
                return Err(BrowserError::new(
                    ERR_TIMEOUT,
                    "no page committed in time (nothing to go back or forward to?)",
                )
                .with_reason("no_commit"));
            }
        };
        self.settle(label, nav).await;
        Ok(epoch)
    }

    /// Wait until `document.readyState` reaches interactive/complete. A
    /// slow SPA still settles Ok; the agent retries reads on demand.
    async fn settle(&self, tab_id: &str, settle: Deadline) {
        loop {
            let state = self.eval(tab_id, assets::ready_state()).await.ok();
            if matches!(state.as_ref().and_then(Value::as_str), Some("complete" | "interactive")) {
                return;
            }
            if settle.remaining().is_zero() {
                return;
            }
            tokio::time::sleep(settle.clamp(budgets::SETTLE_POLL)).await;
        }
    }

    pub(super) async fn act(
        &self,
        session_id: &str,
        verb: Verb,
        call: BrowserCall,
        deadline: Deadline,
    ) -> Result<Success, BrowserError> {
        let args = &call.args;
        match verb {
            Verb::ListTabs => Ok(self.list_tabs(session_id)),
            Verb::NewTab => {
                let url = check_url(&require_url_arg(args, "new_tab")?)?;
                let (label, rx) = self.open_agent_tab(session_id, &url).await?;
                self.finish_navigation(&label, rx, deadline).await?;
                Ok(Success {
                    page: self.page_meta(&label),
                    ..mutated(Fidelity::Trusted, self.tab_facts(&label)?)
                })
            }
            Verb::CloseTab => {
                let label = self.resolve_tab(session_id, args)?;
                let facts = self.tab_facts(&label)?;
                self.close_agent_tab(&label, session_id).await;
                Ok(mutated(Fidelity::Trusted, facts))
            }
            Verb::Navigate => self.navigate(session_id, args, deadline).await,
            Verb::Back | Verb::Forward | Verb::Reload => {
                let label = self.resolve_tab(session_id, args)?;
                let step = match verb {
                    Verb::Back => HistoryStep::Back,
                    Verb::Forward => HistoryStep::Forward,
                    _ => HistoryStep::Reload,
                };
                let rx = self.navigation_waiter(&label)?;
                self.surface.history(&label, step).map_err(BrowserError::internal)?;
                self.finish_navigation(&label, rx, deadline).await?;
                Ok(Success {
                    page: self.page_meta(&label),
                    ..mutated(Fidelity::Trusted, self.tab_facts(&label)?)
                })
            }
            Verb::Snapshot => {
                let label = self.resolve_tab(session_id, args)?;
                let snapshot = self.snapshot_page(session_id, &label).await?;
                let (page, refs) = self.mint_snapshot(&label, snapshot)?;
                Ok(Success {
                    tab: Some(self.tab_facts(&label)?),
                    page: Some(page),
                    data: Some(json!({ "refs": refs })),
                    ..Success::default()
                })
            }
            Verb::ReadText => {
                let label = self.resolve_tab(session_id, args)?;
                self.read_text(&label, args).await
            }
            Verb::Screenshot => {
                let label = self.resolve_tab(session_id, args)?;
                let path = self.screenshot(session_id, &label).await?;
                Ok(Success {
                    tab: Some(self.tab_facts(&label)?),
                    data: Some(json!({ "path": path })),
                    ..Success::default()
                })
            }
            Verb::Click | Verb::Hover => {
                let label = self.resolve_tab(session_id, args)?;
                let token = required_ref(args)?;
                let resolved = self.resolve_ref(&label, token)?;
                let fidelity = if verb == Verb::Click {
                    self.click(&label, token, &resolved, deadline).await?
                } else {
                    self.hover(&label, token, &resolved, deadline).await?
                };
                Ok(mutated(fidelity, self.tab_facts(&label)?))
            }
            Verb::Drag => {
                let label = self.resolve_tab(session_id, args)?;
                let (token, to_token) = (required_ref(args)?, required_to_ref(args)?);
                if token == to_token {
                    return Err(BrowserError::invalid("drag needs two different refs")
                        .with_reason("same_ref")
                        .with_arg_keys(&["ref", "toRef"]));
                }
                let from = self.resolve_ref(&label, token)?;
                let to = self.resolve_ref(&label, to_token)?;
                let fidelity = self.drag(&label, (token, &from), (to_token, &to), deadline).await?;
                Ok(mutated(fidelity, self.tab_facts(&label)?))
            }
            Verb::Fill => {
                let label = self.resolve_tab(session_id, args)?;
                let token = required_ref(args)?;
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrowserError::invalid("missing 'value'").with_arg_keys(&["value"]))?;
                let resolved = self.resolve_ref(&label, token)?;
                let fidelity = self.fill(&label, token, &resolved, value, deadline).await?;
                Ok(mutated(fidelity, self.tab_facts(&label)?))
            }
            Verb::Type | Verb::Press | Verb::Scroll => {
                let label = self.resolve_tab(session_id, args)?;
                let fidelity = match verb {
                    Verb::Type => self.type_text(&label, args, deadline).await?,
                    Verb::Press => self.press(&label, args, deadline).await?,
                    _ => self.scroll(&label, args).await?,
                };
                Ok(mutated(fidelity, self.tab_facts(&label)?))
            }
            Verb::Wait => self.wait(session_id, args, deadline).await,
            Verb::SelectOption => {
                let label = self.resolve_tab(session_id, args)?;
                self.select_option(&label, args).await
            }
            Verb::Check | Verb::Uncheck => {
                let label = self.resolve_tab(session_id, args)?;
                self.set_checked(&label, args, verb == Verb::Check, deadline).await
            }
            Verb::SwitchTab => self.switch_tab(session_id, args),
            Verb::Console | Verb::Network => self.observe(session_id, verb, args).await,
            Verb::HandleDialog => self.handle_dialog(session_id, args).await,
            Verb::Upload => {
                let label = self.resolve_tab(session_id, args)?;
                let token = required_ref(args)?;
                let resolved = self.resolve_ref(&label, token)?;
                self.revalidate(&label, token, &resolved).await?;
                self.upload(session_id, &label, &resolved.node, args).await?;
                Ok(mutated(Fidelity::Trusted, self.tab_facts(&label)?))
            }
        }
    }

    fn navigation_waiter(&self, label: &str) -> Result<oneshot::Receiver<NavOutcome>, BrowserError> {
        self.registry
            .lock()
            .wait_for_navigation(label)
            .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))
    }

    fn list_tabs(&self, session_id: &str) -> Success {
        let owned = self.registry.lock().owned(session_id);
        let list: Vec<Value> = owned
            .iter()
            .filter_map(|label| {
                let tab = self.tab_facts(label).ok()?;
                let page = self.page_meta(label)?;
                if page.carries_page_text() {
                    self.gate.taint(session_id);
                }
                Some(json!({ "tab": tab, "page": page }))
            })
            .collect();
        Success {
            data: Some(json!({ "tabs": list })),
            ..Success::default()
        }
    }

    async fn navigate(&self, session_id: &str, args: &Value, deadline: Deadline) -> Result<Success, BrowserError> {
        let url = check_url(&require_url_arg(args, "navigate")?)?;
        let tab_id = tab_id_arg(args)?;
        let target = self.registry.lock().resolve(session_id, tab_id.as_deref());
        let (label, rx) = match target {
            Ok(Some(label)) => {
                let rx = self.navigation_waiter(&label)?;
                self.surface
                    .navigate(&label, url)
                    .map_err(BrowserError::internal)?;
                (label, rx)
            }
            // No tabId and the session has no default tab: open one whose
            // first navigation is this one.
            Ok(None) => self.open_agent_tab(session_id, &url).await?,
            // An explicit tabId that is not this session's live agent tab is
            // a caller error: never fall back to, or open, another tab.
            Err(e) => {
                log::warn!(
                    "[browser-agent] navigate: explicit tabId not owned by session {} ({}), no auto-open",
                    crate::logging::redact_session_id(session_id),
                    e.code
                );
                return Err(e);
            }
        };
        self.finish_navigation(&label, rx, deadline).await?;
        Ok(Success {
            page: self.page_meta(&label),
            ..mutated(Fidelity::Trusted, self.tab_facts(&label)?)
        })
    }

    /// Ask the renderer to mount a new agent tab at `url`, and wait for the
    /// engine to confirm it. Returns the waiter for its first navigation.
    pub(super) async fn open_agent_tab(
        &self,
        session_id: &str,
        url: &str,
    ) -> Result<(String, oneshot::Receiver<NavOutcome>), BrowserError> {
        if let Some(missing) = super::dispatch::floor_gap(self.engine.facts()) {
            return Err(super::dispatch::floor_error(missing));
        }
        let label = mint_agent_label();
        let requested = self.requested_profile(session_id).await;
        let opened = self
            .registry
            .lock()
            .expect_agent_tab(&label, session_id, url, requested)
            .map_err(|BindRefusal::GlobalClearing| {
                BrowserError::capability("the agent browser profile is being cleared; try again in a moment")
                    .with_reason("agent_profile_clearing")
            })?;
        self.emit(
            Some(session_id),
            super::tabs::EVENT_AGENT_TAB,
            &super::tabs::BrowserAgentTabEvent {
                action: "open",
                tab_id: label.clone(),
                url: Some(url.to_string()),
                session_id: session_id.to_string(),
            },
        );
        match tokio::time::timeout(budgets::TAB_OPEN, opened).await {
            Ok(Ok(Ok(first_nav))) => {
                log::info!(
                    "[browser-agent] opened agent tab {} for session {}",
                    label_prefix(&label),
                    crate::logging::redact_session_id(session_id)
                );
                Ok((label, first_nav))
            }
            Ok(Ok(Err(why))) => Err(BrowserError::internal(why).with_reason("tab_not_created")),
            _ => {
                self.registry.lock().forget_pending(&label);
                Err(BrowserError::capability(
                    "renderer did not open the agent tab (no desktop UI attached?)",
                ))
            }
        }
    }

    /// Shape a snapshot helper result, with host refs minted for its
    /// nodes on the tab's current document.
    fn mint_snapshot(&self, label: &str, snapshot: PageSnapshot) -> Result<(PageData, usize), BrowserError> {
        let mut registry = self.registry.lock();
        let record = registry
            .get_mut(label)
            .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))?;
        let epoch = record.epoch;
        Ok(shape_parsed(snapshot, |nodes| record.refs.mint_snapshot(epoch, nodes)))
    }

    /// Check the page element behind `resolved` still has the role and
    /// name its ref was minted for. Its centre is in main-frame CSS px.
    pub(super) async fn revalidate(
        &self,
        label: &str,
        token: &str,
        resolved: &ResolvedRef,
    ) -> Result<ResolvedElement, BrowserError> {
        let out = self
            .eval_ref(label, &resolved.node, assets::resolve(&resolved.node.path))
            .await?;
        let mut element = resolve_result(out, Some(token))?;
        if element.role != resolved.node.role || element.name != resolved.node.name {
            return Err(stale_ref_error(token, RefStale::Gone));
        }
        if !resolved.node.frame.is_empty() {
            let origin = self.frame_origin(label, &resolved.node.frame).await?;
            element.rect.cx += origin.x;
            element.rect.cy += origin.y;
        }
        Ok(element)
    }

    /// Capture the tab and write the PNG under the session's artifact dir.
    async fn screenshot(&self, session_id: &str, tab_id: &str) -> Result<String, BrowserError> {
        let png = self
            .engine
            .screenshot(tab_id)
            .await
            .map_err(|e| engine_error(e, tab_id))?;
        let root = self.surface.artifacts_root().map_err(BrowserError::internal)?;
        let dir = super::teardown::session_dir(&root, session_id);
        std::fs::create_dir_all(&dir).map_err(|e| BrowserError::internal(format!("artifact dir: {e}")))?;
        let path = dir.join(format!("shot-{}.png", Uuid::new_v4()));
        std::fs::write(&path, png).map_err(|e| BrowserError::internal(format!("write artifact: {e}")))?;
        Ok(path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
