//! Host classification of sensitive agent actions.
//!
//! The page helper reports closed [`SensitivityFacts`] about an action's
//! target; [`classify`] turns them, with what the host knows about the tab
//! and the session, into the sensitive classes the action needs consent
//! for. Classification is pure and monotonic: a fact can only add classes,
//! and a fact the helper could not establish counts as the sensitive case.
//! The agent's stated intent is never an input.

use std::collections::HashSet;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use tauri::Url;

use super::ports::{ActionClass, CanonicalOrigin};

/// What the sensitivity helper observed about an action's target element.
///
/// The region is the target's form, or, for a target outside every form,
/// every shown field of its document and its same-origin frames, forms
/// included: a pay button outside the card form can submit it by script.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SensitivityFacts {
    /// Origin of the element's document.
    pub frame_origin: Option<String>,
    /// The element belongs to a form.
    pub target_in_form: bool,
    /// The region has a password or one-time-code field.
    pub region_has_password: bool,
    /// The region has a payment-card field.
    pub region_has_payment: bool,
    /// Activating the element submits its form.
    pub is_submitter: bool,
    /// The element takes typed text, so a click only focuses it. Unknown
    /// counts as an element a click or key activates.
    pub is_text_entry: bool,
    pub is_file_input: bool,
    /// Absolute URL the form submits to.
    pub form_action: Option<String>,
    /// Absolute URL of the link the element sits in.
    pub link_target: Option<String>,
}

impl SensitivityFacts {
    /// The helper's reply as facts. A reply of any other shape is
    /// ambiguous, which classifies as a password and payment submit.
    pub fn from_helper(out: &Value) -> Self {
        serde_json::from_value(out.clone()).unwrap_or_else(|_| Self::ambiguous())
    }

    fn ambiguous() -> Self {
        Self {
            target_in_form: true,
            region_has_password: true,
            region_has_payment: true,
            is_submitter: true,
            ..Self::default()
        }
    }
}

/// The agent action being classified.
#[derive(Debug, Clone, Copy)]
pub enum Gesture<'a> {
    /// A pointer click.
    Click,
    /// `check` and `uncheck`: a click that changes a control's state.
    Toggle,
    Key(&'a str),
    Type(&'a str),
    Fill,
    /// `select_option`: a change a page can act on like a click.
    Select,
    Navigate(&'a Url),
    Upload,
}

/// What the host knows about the tab and session an action runs in.
#[derive(Debug, Clone, Copy)]
pub struct Scene<'a> {
    pub tab_url: &'a str,
    /// The session has read page content (a snapshot or screenshot).
    pub tainted: bool,
    /// The facts came from an isolated world page script cannot reach.
    pub facts_trusted: bool,
    /// The tab's origin is loopback or allow-listed.
    pub trusted_origin: bool,
}

/// One class an action needs consent for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sensitive {
    pub class: ActionClass,
    /// The origin a pre-approval is keyed on. `None` when no http(s)
    /// origin could be established: such an action is refused.
    pub origin: Option<CanonicalOrigin>,
    /// The URL the consent ticket shows.
    pub target: String,
    /// Page-controlled facts classified it: it always prompts and is never
    /// pre-approvable.
    pub pinned: bool,
}

fn origin_of(url: &str) -> Option<CanonicalOrigin> {
    CanonicalOrigin::parse(url).ok()
}

fn is_enter(key: &str) -> bool {
    ["enter", "numpadenter", "return", "\n", "\r"]
        .iter()
        .any(|k| key.eq_ignore_ascii_case(k))
}

fn is_space(key: &str) -> bool {
    ["space", "spacebar", " "]
        .iter()
        .any(|k| key.eq_ignore_ascii_case(k))
}

fn has_newline(text: &str) -> bool {
    text.contains(['\n', '\r'])
}

/// A URL carries data when it has a query or a fragment. An unparseable
/// one is assumed to.
fn carries_data(url: &str) -> bool {
    url.parse::<Url>().map_or(true, |u| {
        u.query().is_some_and(|q| !q.is_empty()) || u.fragment().is_some_and(|f| !f.is_empty())
    })
}

/// Whether `url` goes to another origin than the tab's. Unknown on either
/// side counts as leaving.
fn leaves(url: Option<&str>, tab: Option<&CanonicalOrigin>) -> bool {
    match (url.and_then(origin_of), tab) {
        (Some(to), Some(from)) => &to != from,
        _ => true,
    }
}

struct Classes(Vec<Sensitive>);

impl Classes {
    fn add(
        &mut self,
        class: ActionClass,
        origin: Option<CanonicalOrigin>,
        target: &str,
        pinned: bool,
    ) {
        if let Some(seen) = self
            .0
            .iter_mut()
            .find(|s| s.class == class && s.origin == origin)
        {
            seen.pinned |= pinned;
            return;
        }
        self.0.push(Sensitive {
            class,
            origin,
            target: target.to_string(),
            pinned,
        });
    }
}

/// Whether `gesture` can set off what its target does: a click on
/// anything but a text field, Enter, Space on anything but a text field,
/// a change of a control's state. A region holding credentials then
/// counts it as their submit, however the page wired it up.
fn activates(gesture: Gesture<'_>, facts: &SensitivityFacts) -> bool {
    match gesture {
        Gesture::Click | Gesture::Toggle | Gesture::Fill => !facts.is_text_entry,
        Gesture::Select => true,
        Gesture::Key(key) => is_enter(key) || (is_space(key) && !facts.is_text_entry),
        Gesture::Type(text) => has_newline(text) || !facts.is_text_entry,
        Gesture::Navigate(_) | Gesture::Upload => false,
    }
}

/// Whether the region's credential fields count for `gesture`. A form's
/// fields count for anything that activates one of its controls. Outside
/// every form the region is the whole page, so only what a page script
/// takes as "submit" counts there: a click, Enter, Space or typed keys, not
/// a state change of a control (`check`, `select_option`, `fill`). Every
/// click on a checkout page still asks; changing its quantity does not.
fn region_counts(gesture: Gesture<'_>, facts: &SensitivityFacts) -> bool {
    facts.target_in_form || matches!(gesture, Gesture::Click | Gesture::Key(_) | Gesture::Type(_))
}

/// Whether `gesture` submits the target's form natively: Enter or a
/// typed newline in it, or activating its submitter.
fn submits_form(gesture: Gesture<'_>, facts: &SensitivityFacts) -> bool {
    let implicit = match gesture {
        Gesture::Key(key) => is_enter(key),
        Gesture::Type(text) => has_newline(text),
        _ => false,
    };
    facts.target_in_form && (implicit || (facts.is_submitter && activates(gesture, facts)))
}

/// Every sensitive class `gesture` falls in.
pub fn classify(
    gesture: Gesture<'_>,
    facts: &SensitivityFacts,
    scene: &Scene<'_>,
) -> Vec<Sensitive> {
    let tab_origin = origin_of(scene.tab_url);
    let page_origin = facts
        .frame_origin
        .as_deref()
        .and_then(origin_of)
        .or_else(|| tab_origin.clone());
    let page = scene.tab_url;
    let mut out = Classes(Vec::new());

    if activates(gesture, facts) {
        let region = region_counts(gesture, facts);
        if region && facts.region_has_password {
            out.add(ActionClass::PasswordSubmit, page_origin.clone(), page, false);
        }
        if region && facts.region_has_payment {
            out.add(ActionClass::PaymentSubmit, page_origin.clone(), page, false);
        }
        if let Some(link) = facts.link_target.as_deref() {
            if scene.tainted && carries_data(link) && leaves(Some(link), tab_origin.as_ref()) {
                out.add(ActionClass::TaintedExfil, origin_of(link), link, false);
            }
        }
    }
    if submits_form(gesture, facts) && scene.tainted {
        let action = facts.form_action.as_deref();
        if leaves(action, tab_origin.as_ref()) {
            let target = action.unwrap_or(page);
            let origin = action.and_then(origin_of).or_else(|| page_origin.clone());
            out.add(ActionClass::TaintedExfil, origin, target, false);
        }
    }

    match gesture {
        Gesture::Navigate(url) => {
            let url = url.as_str();
            if scene.tainted && carries_data(url) && leaves(Some(url), tab_origin.as_ref()) {
                out.add(ActionClass::TaintedExfil, origin_of(url), url, false);
            }
        }
        Gesture::Upload => out.add(ActionClass::Upload, page_origin.clone(), page, false),
        _ => {}
    }

    // Facts the page can forge cannot clear a submit-shaped action on an
    // origin the user has not vouched for: it is treated as a credential
    // submit that always prompts.
    if !scene.facts_trusted && !scene.trusted_origin {
        let submit_shaped = match gesture {
            Gesture::Click | Gesture::Toggle | Gesture::Select => {
                facts.is_submitter || facts.target_in_form
            }
            Gesture::Key(key) => is_enter(key) || is_space(key),
            Gesture::Type(text) => has_newline(text) || facts.target_in_form,
            Gesture::Fill => facts.target_in_form,
            Gesture::Navigate(_) | Gesture::Upload => false,
        };
        if submit_shaped {
            out.add(ActionClass::PasswordSubmit, page_origin, page, true);
        }
    }
    out.0
}

/// Sessions whose agent has read page content. Untrusted content can carry
/// instructions, so from then on data-carrying requests to other origins
/// are exfiltration-shaped. A session never becomes untainted.
#[derive(Default)]
pub struct Taint {
    sessions: Mutex<HashSet<String>>,
}

impl Taint {
    pub fn mark(&self, session_id: &str) {
        self.sessions.lock().insert(session_id.to_string());
    }

    pub fn is_tainted(&self, session_id: &str) -> bool {
        self.sessions.lock().contains(session_id)
    }

    pub fn forget(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }
}

#[cfg(test)]
#[path = "sensitivity_tests.rs"]
mod tests;
