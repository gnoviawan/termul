//! Every time budget of a browser tool call, and the absolute deadline the
//! parent stamps on each call frame.
//!
//! The child gives up after [`ROUND_TRIP`] (served to it in the describe
//! reply). The parent stamps a deadline [`MARGIN`] earlier, so the host
//! always answers before the child stops listening; the core refuses an
//! action whose budget no longer fits instead of running it late.

use std::time::Duration;

use tokio::time::Instant;

const fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

/// How long the child waits for the parent's reply to a browser call.
pub const ROUND_TRIP: Duration = secs(200);
/// Headroom between the host's deadline and the child giving up.
pub const MARGIN: Duration = secs(5);
/// The deadline the parent stamps on a browser frame when it arrives.
pub const FRAME_BUDGET: Duration = ROUND_TRIP.saturating_sub(MARGIN);
/// How long the child waits for the describe reply at startup.
pub const DESCRIBE: Duration = secs(5);

/// How long a consent prompt may wait for the user.
pub const CONSENT_WAIT: Duration = secs(120);
/// Renderer round trip to mount an agent tab's pane and webview.
pub const TAB_OPEN: Duration = secs(15);
/// How long the engine may take to confirm a webview was created, or to
/// process its close.
pub const TAB_CONFIRM: Duration = secs(5);
/// Post-navigation wait for the document to become interactive.
pub const NAV_SETTLE: Duration = secs(15);
pub const SETTLE_POLL: Duration = Duration::from_millis(200);
/// How long a script dialog may hold an agent tab before the host
/// dismisses it.
pub const DIALOG_ANSWER: Duration = secs(60);
/// Longest `wait`, by `ms` or for `text`.
pub const WAIT_MAX: Duration = secs(30);
pub const WAIT_POLL: Duration = Duration::from_millis(300);

/// WebView2: how long the UI thread may take to pick up a CDP command.
pub const CDP_ISSUE: Duration = secs(5);
/// WebView2: how long an issued CDP command may take to answer.
pub const CDP_RESULT: Duration = secs(15);
/// One CDP command, issue plus result.
pub const CDP_CALL: Duration = CDP_ISSUE.saturating_add(CDP_RESULT);
/// One helper round trip on any engine, from the first engine call to the
/// helper's result. On WebView2 it covers the frame lookup, the isolated
/// world and the helper call.
pub const EVAL_STEP: Duration = CDP_CALL;
/// WebKit: how long a file input may take to open its chooser after the
/// helper clicked it.
pub const FILE_CHOOSER: Duration = secs(5);

/// Per-verb action budgets, referenced by the action registry. Each is the
/// worst case of the steps the verb runs.
pub const ACTION_INSTANT: Duration = secs(1);
pub const ACTION_EVAL: Duration = EVAL_STEP;
/// How long the core waits for an element to become actionable, and how
/// often it reads the element's facts again.
pub const ACTIONABILITY_WAIT: Duration = secs(5);
pub const ACTIONABILITY_POLL: Duration = Duration::from_millis(100);
/// Native input on macOS and Linux: one UI-thread round trip.
#[cfg(not(windows))]
pub const NATIVE_INPUT: Duration = secs(5);
/// One trusted input event on any engine; CDP is the slowest.
const INPUT_EVENT: Duration = CDP_CALL;
/// After trusted input, how long the core waits for the page to render it.
pub const INPUT_SETTLE: Duration = secs(1);
/// The actionability wait can start its last facts probe just before it
/// ends.
const ACTIONABLE: Duration = ACTIONABILITY_WAIT.saturating_add(EVAL_STEP);
/// Wait until the element is actionable, press and release, then let the
/// page render the click. Hover and scroll need no more.
pub const ACTION_CLICK: Duration = ACTIONABLE
    .saturating_add(INPUT_EVENT)
    .saturating_add(INPUT_EVENT)
    .saturating_add(INPUT_SETTLE);
/// The press, the moves and the release of a drag, as one cut.
pub const DRAG_INPUT: Duration = secs(10);
/// Text verbs click to focus, place the caret, then type or press: more
/// steps than a click, held to the same bound. Every step is cut at it, so
/// a slow engine answers `timeout` instead of late.
pub const ACTION_TEXT: Duration = ACTION_CLICK;
/// Wait until the source and then the target are actionable, run the
/// drag, then let the page render it.
pub const ACTION_DRAG: Duration = ACTIONABLE
    .saturating_add(ACTIONABLE)
    .saturating_add(DRAG_INPUT)
    .saturating_add(INPUT_SETTLE);
/// A settle loop can start its last readiness probe just before it ends.
pub const ACTION_HISTORY: Duration = NAV_SETTLE.saturating_add(EVAL_STEP);
pub const ACTION_NAVIGATE: Duration = TAB_OPEN.saturating_add(ACTION_HISTORY);
/// Opens the tab, then waits for its first navigation the way navigate does.
pub const ACTION_NEW_TAB: Duration = ACTION_NAVIGATE;
pub const ACTION_WAIT: Duration = WAIT_MAX.saturating_add(EVAL_STEP);
/// Resolve the ref, then run the select helper.
pub const ACTION_SELECT: Duration = EVAL_STEP.saturating_add(EVAL_STEP);
/// The click path, whose resolve step also reads the checked state. The
/// confirming read after the click runs only if it still fits.
pub const ACTION_TOGGLE: Duration = ACTION_CLICK;
/// Revalidate the ref, then set the staged file: one helper call, plus the
/// chooser round trip on WebKit.
pub const ACTION_UPLOAD: Duration = EVAL_STEP.saturating_add(EVAL_STEP).saturating_add(FILE_CHOOSER);

/// An absolute point in time a call must finish by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadline(Instant);

impl Deadline {
    pub fn after(budget: Duration) -> Self {
        Self(Instant::now() + budget)
    }

    pub fn remaining(self) -> Duration {
        self.0.saturating_duration_since(Instant::now())
    }

    /// True when `budget` still fits before the deadline.
    pub fn admits(self, budget: Duration) -> bool {
        self.remaining() >= budget
    }

    /// `step`, cut short to what is left.
    pub fn clamp(self, step: Duration) -> Duration {
        step.min(self.remaining())
    }
}

#[cfg(test)]
#[path = "budgets_tests.rs"]
mod tests;
