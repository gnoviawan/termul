//! The sensitivity pass a call goes through after origin consent and before
//! it acts: the facts behind the action, its sensitive classes, and the
//! confirmation each class needs.

use serde_json::Value;
use tauri::Url;

use super::actions::{check_ref, check_url, tab_id_arg};
use super::consent::SensitiveRequest;
use super::dispatch::Verb;
use super::reply::reported_failure;
use super::sensitivity::{classify, Gesture, Scene, SensitivityFacts};
use super::stop::StopToken;
use super::tabs::stale_ref_error;
use super::{BrowserError, DesktopBrowserHost};
use crate::browser_automation::budgets::Deadline;
use crate::browser_automation::engine::assets;
use crate::browser_automation::BrowserCall;

const BLANK: &str = "about:blank";

/// What the pass reads the facts from.
#[derive(Clone, Copy)]
enum Probe {
    /// Navigations: the tab's page, no element.
    Page,
    /// The element the call targets, or the focused one when the verb
    /// allows no ref.
    Element { needs_ref: bool },
}

fn text_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

impl DesktopBrowserHost {
    /// Confirm every sensitive class `call` falls in. Calls that classify
    /// as nothing pass straight through.
    pub(super) async fn confirm_sensitive_call(
        &self,
        token: &StopToken,
        session_id: &str,
        verb: Verb,
        call: &BrowserCall,
        deadline: Deadline,
    ) -> Result<(), BrowserError> {
        let args = &call.args;
        let text = |key: &str| text_arg(args, key);
        let target;
        let (gesture, probe) = match verb {
            Verb::Navigate | Verb::NewTab => {
                let Some(Ok(url)) = text("url").map(check_url) else {
                    return Ok(());
                };
                target = url
                    .parse::<Url>()
                    .map_err(|_| BrowserError::invalid("invalid url"))?;
                (Gesture::Navigate(&target), Probe::Page)
            }
            // `check` and `uncheck` click: a submit styled as a switch
            // submits its form all the same.
            Verb::Click | Verb::Check | Verb::Uncheck => {
                (Gesture::Click, Probe::Element { needs_ref: true })
            }
            Verb::SelectOption => (Gesture::Select, Probe::Element { needs_ref: true }),
            Verb::Fill => (Gesture::Fill, Probe::Element { needs_ref: true }),
            Verb::Upload => (Gesture::Upload, Probe::Element { needs_ref: true }),
            Verb::Press => (
                Gesture::Key(text("key").unwrap_or("Enter")),
                Probe::Element { needs_ref: false },
            ),
            Verb::Type => (
                Gesture::Type(text("text").unwrap_or_default()),
                Probe::Element { needs_ref: false },
            ),
            _ => return Ok(()),
        };
        let file = match verb {
            Verb::Upload => Some(self.upload_source(session_id, args).await?.ticket_file()),
            _ => None,
        };
        let (label, facts) = match probe {
            Probe::Page if verb == Verb::NewTab => (None, SensitivityFacts::default()),
            Probe::Page => match self
                .registry
                .lock()
                .resolve(session_id, tab_id_arg(args)?.as_deref())
            {
                Ok(label) => (label, SensitivityFacts::default()),
                // The verb reports the tab error itself.
                Err(_) => return Ok(()),
            },
            Probe::Element { needs_ref } => {
                let label = self.resolve_tab(session_id, args)?;
                let facts = self.sensitivity_facts(&label, args, needs_ref).await?;
                (Some(label), facts)
            }
        };
        if verb == Verb::Upload && !facts.is_file_input {
            return Err(
                BrowserError::invalid("upload needs the ref of a file input")
                    .with_reason("not_a_file_input")
                    .with_arg_keys(&["ref"]),
            );
        }
        let profile = self.call_profile(session_id, verb, call).await;
        let tab_url = label
            .as_deref()
            .and_then(|label| self.registry.lock().get(label).map(|r| r.url.clone()))
            .unwrap_or_else(|| BLANK.to_string());
        let trusted_origin = tab_url
            .parse::<Url>()
            .is_ok_and(|url| self.gate.vouched_for(session_id, &url, profile));
        let scene = Scene {
            tab_url: &tab_url,
            tainted: self.gate.is_tainted(session_id),
            facts_trusted: self.engine.facts().traits.isolated_world,
            trusted_origin,
        };
        let items = classify(gesture, &facts, &scene);
        if items.is_empty() {
            return Ok(());
        }
        let project_id = (self.project_of)(session_id);
        let req = SensitiveRequest {
            session_id,
            project_id: &project_id,
            element: call.element.as_deref(),
            file,
            profile,
            deadline,
        };
        for item in &items {
            self.gate.confirm_sensitive(token, &req, item).await?;
        }
        Ok(())
    }

    /// The sensitivity facts of the call's target: its ref, or the focused
    /// element when the verb allows no ref.
    async fn sensitivity_facts(
        &self,
        label: &str,
        args: &Value,
        needs_ref: bool,
    ) -> Result<SensitivityFacts, BrowserError> {
        let token = args.get("ref").and_then(Value::as_str);
        if let Some(token) = token {
            check_ref(token)?;
        } else if needs_ref {
            return Err(BrowserError::invalid("missing 'ref'").with_arg_keys(&["ref"]));
        }
        // A ref's facts come from the frame it was minted in.
        let out = match token {
            Some(token) => {
                let node = {
                    let registry = self.registry.lock();
                    let record = registry
                        .get(label)
                        .ok_or_else(|| BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))?;
                    record
                        .refs
                        .resolve(token, record.epoch)
                        .map_err(|why| stale_ref_error(token, why))?
                        .clone()
                };
                self.eval_ref(label, &node, assets::sensitivity(Some(&node.path))).await?
            }
            None => self.eval(label, assets::sensitivity(None)).await?,
        };
        reported_failure(&out, token)?;
        Ok(SensitivityFacts::from_helper(&out))
    }
}
