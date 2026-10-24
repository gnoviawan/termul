//! Handlers for the form verbs (`select_option`, `check`, `uncheck`), the
//! semantic `wait`, and `switch_tab`. Form verbs act only through the
//! paths `fill` and `click` already use.

use std::time::Duration;

use serde_json::{json, Value};

use super::{mutated, required_ref, ResolvedRef};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::core::reply::{
    action_result, check_result, CheckState, Fidelity, Success,
};
use crate::browser_automation::core::{
    BrowserError, DesktopBrowserHost, ERR_INTERNAL, ERR_TIMEOUT,
};
use crate::browser_automation::engine::assets::{self, Script};
use crate::browser_automation::engine::{CapabilityId, InputMode};

/// What a `wait` call waits for: exactly one condition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum WaitFor {
    Sleep(Duration),
    Text(String),
    TextGone(String),
    UrlContains(String),
    Load(LoadState),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LoadState {
    DomContentLoaded,
    Load,
}

impl LoadState {
    fn reached(self, ready_state: &str) -> bool {
        match self {
            LoadState::DomContentLoaded => matches!(ready_state, "interactive" | "complete"),
            LoadState::Load => ready_state == "complete",
        }
    }
}

const WAIT_KEYS: [&str; 5] = ["ms", "text", "textGone", "urlContains", "loadState"];

impl WaitFor {
    pub(super) fn parse(args: &Value) -> Result<Self, BrowserError> {
        let present: Vec<&'static str> = WAIT_KEYS
            .into_iter()
            .filter(|k| args.get(*k).is_some_and(|v| !v.is_null()))
            .collect();
        let [key] = present.as_slice() else {
            return Err(BrowserError::invalid(
                "wait needs exactly one of 'ms', 'text', 'textGone', 'urlContains' or 'loadState'",
            )
            .with_arg_keys(if present.is_empty() {
                &WAIT_KEYS
            } else {
                &present
            }));
        };
        let text = || {
            args.get(*key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Ok(match *key {
            "ms" => {
                let ms = args.get("ms").and_then(Value::as_u64).unwrap_or_default();
                WaitFor::Sleep(Duration::from_millis(ms).min(budgets::WAIT_MAX))
            }
            "text" => WaitFor::Text(text()),
            "textGone" => WaitFor::TextGone(text()),
            "urlContains" => WaitFor::UrlContains(text()),
            _ => match text().as_str() {
                "domcontentloaded" => WaitFor::Load(LoadState::DomContentLoaded),
                "load" => WaitFor::Load(LoadState::Load),
                _ => {
                    return Err(BrowserError::invalid(
                        "wait: 'loadState' must be domcontentloaded or load",
                    )
                    .with_arg_keys(&["loadState"]))
                }
            },
        })
    }

    /// The helper whose value decides the condition.
    fn probe(&self) -> Option<Script> {
        match self {
            WaitFor::Sleep(_) => None,
            WaitFor::Text(text) | WaitFor::TextGone(text) => Some(assets::contains_text(text)),
            WaitFor::UrlContains(_) => Some(assets::location()),
            WaitFor::Load(_) => Some(assets::ready_state()),
        }
    }

    fn met(&self, probe: &Value) -> bool {
        match self {
            WaitFor::Sleep(_) => true,
            WaitFor::Text(_) => probe.as_bool() == Some(true),
            WaitFor::TextGone(_) => probe.as_bool() == Some(false),
            WaitFor::UrlContains(part) => probe
                .as_str()
                .is_some_and(|url| url.contains(part.as_str())),
            WaitFor::Load(state) => probe.as_str().is_some_and(|s| state.reached(s)),
        }
    }

    fn timed_out(&self) -> BrowserError {
        let (message, reason, key) = match self {
            WaitFor::Sleep(_) => unreachable!("a sleep cannot time out"),
            WaitFor::Text(_) => (
                "wait: text did not appear within 30s",
                "text_not_found",
                "text",
            ),
            WaitFor::TextGone(_) => (
                "wait: text was still on the page after 30s",
                "text_still_present",
                "textGone",
            ),
            WaitFor::UrlContains(_) => (
                "wait: the tab URL did not match within 30s",
                "url_not_matched",
                "urlContains",
            ),
            WaitFor::Load(_) => (
                "wait: the document did not reach that state within 30s",
                "load_state_not_reached",
                "loadState",
            ),
        };
        BrowserError::new(ERR_TIMEOUT, message)
            .with_reason(reason)
            .with_arg_keys(&[key])
    }
}

fn not_checkable(token: &str) -> BrowserError {
    BrowserError::invalid(format!("{token}: not a checkbox, switch or radio button"))
        .with_reason("not_checkable")
        .with_arg_keys(&["ref"])
}

/// A form helper's refusal that is the caller's mistake rather than a page
/// failure: `invalid_params` with its reason.
fn form_refusal(out: &Value, token: &str) -> Result<(), BrowserError> {
    let refused = |message: &str, reason: &'static str| {
        Err(BrowserError::invalid(format!("{token}: {message}"))
            .with_reason(reason)
            .with_arg_keys(&["ref"]))
    };
    match out.get("error").and_then(Value::as_str) {
        Some("not_checkable") => Err(not_checkable(token)),
        Some("not_a_select") => refused("not a select element", "not_a_select"),
        Some("no_such_option") => refused("no option has that value or label", "no_such_option"),
        Some("option_disabled") => refused("that option is disabled", "option_disabled"),
        _ => Ok(()),
    }
}

impl DesktopBrowserHost {
    pub(super) async fn select_option(
        &self,
        label: &str,
        args: &Value,
    ) -> Result<Success, BrowserError> {
        let token = required_ref(args)?;
        let value = args
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| BrowserError::invalid("missing 'value'").with_arg_keys(&["value"]))?;
        let resolved = self.resolve_ref(label, token)?;
        self.revalidate(label, token, &resolved).await?;
        let out = self
            .eval_ref(label, &resolved.node, assets::select_option(&resolved.node.path, value))
            .await?;
        form_refusal(&out, token)?;
        action_result(out, Some(token))?;
        Ok(mutated(Fidelity::Synthetic, self.tab_facts(label)?))
    }

    /// `check` (`want` true) or `uncheck`: click through the click path
    /// only when the state differs, then confirm the click changed it
    /// while the deadline still allows the read.
    pub(super) async fn set_checked(
        &self,
        label: &str,
        args: &Value,
        want: bool,
        deadline: Deadline,
    ) -> Result<Success, BrowserError> {
        let token = required_ref(args)?;
        let resolved = self.resolve_ref(label, token)?;
        let mode = self.input_mode(CapabilityId::PointerClick)?;
        let element = self.revalidate(label, token, &resolved).await?;
        let before = element.check.ok_or_else(|| not_checkable(token))?;
        if !want && before.radio {
            return Err(BrowserError::invalid(format!(
                "{token}: a radio button cannot be unchecked; check another option instead"
            ))
            .with_reason("radio_uncheck")
            .with_arg_keys(&["ref"]));
        }
        let fidelity = if before.checked == want {
            match mode {
                InputMode::Trusted => Fidelity::Trusted,
                InputMode::Synthetic => Fidelity::Synthetic,
            }
        } else {
            let fidelity = self.click(label, token, &resolved, deadline).await?;
            if deadline.admits(budgets::EVAL_STEP)
                && self.checked(label, token, &resolved).await?.checked != want
            {
                return Err(BrowserError::new(
                    ERR_INTERNAL,
                    "the click did not change the element's checked state",
                )
                .with_reason("state_unchanged"));
            }
            fidelity
        };
        Ok(Success {
            data: Some(json!({ "changed": before.checked != want })),
            ..mutated(fidelity, self.tab_facts(label)?)
        })
    }

    async fn checked(
        &self,
        label: &str,
        token: &str,
        resolved: &ResolvedRef,
    ) -> Result<CheckState, BrowserError> {
        let out = self
            .eval_ref(label, &resolved.node, assets::checked_state(&resolved.node.path))
            .await?;
        form_refusal(&out, token)?;
        check_result(out, Some(token))
    }

    pub(super) async fn wait(
        &self,
        session_id: &str,
        args: &Value,
        deadline: Deadline,
    ) -> Result<Success, BrowserError> {
        let label = self.resolve_tab(session_id, args)?;
        let condition = WaitFor::parse(args)?;
        let done = || -> Result<Success, BrowserError> {
            Ok(Success {
                tab: Some(self.tab_facts(&label)?),
                ..Success::default()
            })
        };
        let Some(probe) = condition.probe() else {
            if let WaitFor::Sleep(ms) = condition {
                tokio::time::sleep(deadline.clamp(ms)).await;
            }
            return done();
        };
        let wait = Deadline::after(deadline.clamp(budgets::WAIT_MAX));
        loop {
            // A probe that fails (a navigation replaced the document) is
            // retried until the wait ends.
            if let Ok(value) = self.eval(&label, probe.clone()).await {
                if condition.met(&value) {
                    return done();
                }
            }
            if wait.remaining().is_zero() {
                return Err(condition.timed_out());
            }
            tokio::time::sleep(wait.clamp(budgets::WAIT_POLL)).await;
        }
    }

    pub(super) fn switch_tab(
        &self,
        session_id: &str,
        args: &Value,
    ) -> Result<Success, BrowserError> {
        let label = self.resolve_tab(session_id, args)?;
        self.registry.lock().set_default_tab(session_id, &label);
        Ok(Success {
            tab: Some(self.tab_facts(&label)?),
            page: self.page_meta(&label),
            ..Success::default()
        })
    }
}

#[cfg(test)]
#[path = "page_actions_tests.rs"]
mod tests;
