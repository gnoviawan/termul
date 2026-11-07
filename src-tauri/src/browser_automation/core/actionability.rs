//! Actionability: before every pointer or key action the core reads the
//! target's facts until it is visible, stable, enabled (and editable, for
//! text) and the hit test at the action point lands on it. A target that
//! never gets there fails with `timeout` and the reason, never with an
//! action on whatever covers it.

use super::reply::engine_error;
use super::tabs::{stale_ref_error, RefNode, RefStale};
use super::{BrowserError, ERR_TIMEOUT};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::{
    ActionabilityFacts, BrowserEngine, ControlKind, ElementState, Point,
};

/// What an action needs from its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Need {
    /// Hover: visible, stable, hit.
    Pointer,
    /// Click and press: also enabled.
    Activate,
    /// Fill: also a text control or a `<select>`.
    Fill,
    /// Type: also a text control.
    Type,
}

/// Where the action lands, what kind of control is there, and whether a
/// click there focuses something.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Target {
    pub point: Point,
    pub kind: ControlKind,
    pub focus_on_click: bool,
}

/// The first unmet check, as the reply's `reason`.
fn blocker(state: &ElementState, need: Need) -> Option<&'static str> {
    if !state.visible {
        return Some("not_visible");
    }
    if !state.stable {
        return Some("unstable");
    }
    if need != Need::Pointer && !state.enabled {
        return Some("disabled");
    }
    let editable = match need {
        Need::Fill => state.kind != ControlKind::Other,
        Need::Type => state.kind == ControlKind::Text,
        Need::Pointer | Need::Activate => true,
    };
    if !editable {
        return Some("not_editable");
    }
    if !state.hit {
        return Some("covered");
    }
    None
}

fn not_actionable(reason: &'static str) -> BrowserError {
    BrowserError::new(
        ERR_TIMEOUT,
        format!("the element did not become actionable in time ({reason}); take a new snapshot or wait"),
    )
    .with_reason(reason)
    .with_arg_keys(&["ref"])
}

/// Read `node`'s facts until it meets `need`, within the actionability
/// wait. A node that is gone, or no longer has its role (or, while shown,
/// its name), is `stale_ref`.
pub(super) async fn wait_until_actionable(
    engine: &dyn BrowserEngine,
    tab: &str,
    token: &str,
    node: &RefNode,
    need: Need,
    deadline: Deadline,
) -> Result<Target, BrowserError> {
    let wait = Deadline::after(deadline.clamp(budgets::ACTIONABILITY_WAIT));
    loop {
        let frame = (!node.frame.is_empty()).then_some(node.frame.as_str());
        let facts = engine
            .element_facts(tab, frame, &node.path)
            .await
            .map_err(|e| engine_error(e, tab))?;
        let ActionabilityFacts::Present(state) = facts else {
            return Err(stale_ref_error(token, RefStale::Gone));
        };
        if state.role != node.role || (state.visible && state.name != node.name) {
            return Err(stale_ref_error(token, RefStale::Gone));
        }
        let Some(reason) = blocker(&state, need) else {
            return Ok(Target {
                point: state.point,
                kind: state.kind,
                focus_on_click: state.focus_on_click,
            });
        };
        if wait.remaining().is_zero() {
            log::info!(
                "[browser-agent] target not actionable on tab {} ({reason})",
                super::events::label_prefix(tab)
            );
            return Err(not_actionable(reason));
        }
        tokio::time::sleep(wait.clamp(budgets::ACTIONABILITY_POLL)).await;
    }
}

#[cfg(test)]
#[path = "actionability_tests.rs"]
mod tests;
