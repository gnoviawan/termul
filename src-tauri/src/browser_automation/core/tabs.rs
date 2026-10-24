//! The host tab registry: every browser tab webview, user and agent, with
//! its owner, effective profile, document epoch, live URL and title, the
//! navigations waiting on a commit, each session's default tab, and the
//! refs minted for agent tabs.
//!
//! The registry is plain state behind the host's lock: callers mutate it
//! through the methods here, and engine events reach it only through
//! `core::events`. Labels are minted here (agent tabs) or validated here
//! (user tabs the renderer names), never trusted as given.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::dialogs::TabDialogs;
use super::ports::TabProfile;
use super::BrowserError;
use crate::browser_automation::engine::events::{CommitKind, NavVerdict};

mod blank;
mod popups;
pub use blank::FirstLoad;
pub use popups::PopupNote;
#[cfg(test)]
pub use popups::MAX_OPEN_POPUPS;

pub(super) const EVENT_AGENT_TAB: &str = "acp:browser_agent_tab";

/// Placement request for the renderer: open the agent tab in the agent
/// pane, or drop its workspace tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentTabEvent {
    pub action: &'static str, // "open" | "close"
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub session_id: String,
}

// ---------------------------------------------------------------------------
// Labels

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelKind {
    User,
    Agent,
}

/// Parse a tab label: `tab-<uuid>` (user) or `agent-<uuid>` (agent), with
/// the uuid in its canonical lowercase hyphenated form. Anything else is
/// not a tab label.
pub fn parse_label(label: &str) -> Option<LabelKind> {
    let (kind, id) = match label.strip_prefix("tab-") {
        Some(id) => (LabelKind::User, id),
        None => (LabelKind::Agent, label.strip_prefix("agent-")?),
    };
    let parsed = Uuid::try_parse(id).ok()?;
    (parsed.hyphenated().to_string() == id).then_some(kind)
}

pub(super) fn mint_agent_label() -> String {
    format!("agent-{}", Uuid::new_v4())
}

// ---------------------------------------------------------------------------
// Records

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    User,
    /// `profile` is the agent identity the adapter built the tab with,
    /// fixed for the tab's life.
    Agent { session_id: String, profile: TabProfile },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    /// The webview is being built; the engine has not confirmed it yet.
    Creating,
    Live,
    /// Close requested; the record goes when the engine confirms.
    Closing,
}

/// How a navigation verb ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavOutcome {
    /// The navigation (or one that superseded it) committed or finished.
    Committed { epoch: u64 },
    /// Policy denied a hop of the navigation.
    Denied,
    /// The tab closed before the navigation completed.
    Closed,
}

/// A navigation verb waiting for its commit. It claims the first hop that
/// starts after it was registered; earlier hops belong to someone else.
struct NavWaiter {
    started_before: u64,
    claimed: Option<u64>,
    tx: oneshot::Sender<NavOutcome>,
}

impl NavWaiter {
    fn finish(self, outcome: NavOutcome) {
        let _ = self.tx.send(outcome);
    }
}

pub struct TabRecord {
    pub owner: Owner,
    /// Bumped on every new-document commit. Zero until the first commit.
    pub epoch: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
    life: Lifecycle,
    /// Open order, for a deterministic default-tab promotion.
    opened: u64,
    last_started: u64,
    waiters: Vec<NavWaiter>,
    opener: Option<Opener>,
    pub refs: TabRefs,
    /// The agent tab whose page opened this one as a popup.
    pub popup_of: Option<String>,
    pub dialogs: TabDialogs,
    /// Popup outcomes not yet reported to the agent.
    pub popups: Vec<PopupNote>,
    pub observed: super::observe::Observations,
}

type OpenResult = Result<oneshot::Receiver<NavOutcome>, String>;

/// The agent verb that asked for this tab, waiting for it to go live.
struct Opener {
    tx: oneshot::Sender<OpenResult>,
    first_nav: oneshot::Receiver<NavOutcome>,
}

impl TabRecord {
    fn new(owner: Owner, url: &str, opened: u64) -> Self {
        Self {
            owner,
            epoch: 0,
            url: url.to_string(),
            title: String::new(),
            loading: true,
            life: Lifecycle::Creating,
            opened,
            last_started: 0,
            waiters: Vec::new(),
            opener: None,
            refs: TabRefs::default(),
            popup_of: None,
            dialogs: TabDialogs::default(),
            popups: Vec::new(),
            observed: super::observe::Observations::default(),
        }
    }

    /// Whether a navigation the agent asked for is still in flight.
    pub fn agent_navigating(&self) -> bool {
        self.waiters.iter().any(|w| !w.tx.is_closed())
    }

    pub fn session_id(&self) -> Option<&str> {
        match &self.owner {
            Owner::Agent { session_id, .. } => Some(session_id),
            Owner::User => None,
        }
    }

    /// The agent identity of an agent tab; user tabs have none.
    pub fn profile(&self) -> Option<TabProfile> {
        match &self.owner {
            Owner::Agent { profile, .. } => Some(*profile),
            Owner::User => None,
        }
    }

    pub fn is_live(&self) -> bool {
        self.life == Lifecycle::Live
    }

    fn wait(&mut self) -> oneshot::Receiver<NavOutcome> {
        let (tx, rx) = oneshot::channel();
        self.waiters.push(NavWaiter {
            started_before: self.last_started,
            claimed: None,
            tx,
        });
        rx
    }

    fn finish_where(&mut self, outcome: &NavOutcome, done: impl Fn(&NavWaiter) -> bool) {
        let (finished, pending): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.waiters).into_iter().partition(|w| done(w));
        self.waiters = pending;
        for waiter in finished {
            waiter.finish(outcome.clone());
        }
    }

    pub(super) fn nav_starting(&mut self, nav_id: u64, verdict: NavVerdict) {
        self.last_started = self.last_started.max(nav_id);
        for w in &mut self.waiters {
            if w.claimed.is_none() && nav_id > w.started_before {
                w.claimed = Some(nav_id);
            }
        }
        match verdict {
            NavVerdict::Allow => self.loading = true,
            // A denied hop at or after a waiter's claim ends that navigation.
            NavVerdict::Deny => self.finish_where(&NavOutcome::Denied, |w| {
                w.claimed.is_some_and(|c| nav_id >= c)
            }),
        }
    }

    pub(super) fn committed(&mut self, nav_id: Option<u64>, kind: CommitKind, url: &str) {
        self.url = url.to_string();
        if kind == CommitKind::NewDocument {
            self.epoch += 1;
        }
        let outcome = NavOutcome::Committed { epoch: self.epoch };
        self.finish_where(&outcome, |w| match nav_id {
            Some(n) => n > w.started_before && w.claimed.is_none_or(|c| n >= c),
            // A same-document commit raised no start hop, so it can only
            // finish a waiter that never saw one: page script that runs
            // while a real navigation is starting must not finish it.
            None => w.claimed.is_none(),
        });
    }

    /// A finished load ends every navigation that started a hop, including
    /// ones that never produced a new-document commit (fragment targets,
    /// failed loads).
    pub(super) fn load_finished(&mut self) {
        self.loading = false;
        let outcome = NavOutcome::Committed { epoch: self.epoch };
        self.finish_where(&outcome, |w| w.claimed.is_some());
    }

    fn close(&mut self, why: &str) {
        self.finish_where(&NavOutcome::Closed, |_| true);
        if let Some(opener) = self.opener.take() {
            let _ = opener.tx.send(Err(why.to_string()));
        }
    }
}

// ---------------------------------------------------------------------------
// Registry

/// An agent tab the host asked the renderer to mount.
struct PendingAgentTab {
    session_id: String,
    url: String,
    profile: TabProfile,
    popup_of: Option<String>,
    opened: oneshot::Sender<OpenResult>,
}

/// Why the registry refused to bind a session's next tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindRefusal {
    /// The global agent profile is being cleared.
    GlobalClearing,
}

/// Why the registry refused a renderer create request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateRefusal {
    /// Not a `tab-<uuid>` or `agent-<uuid>` label.
    Malformed,
    /// An agent label the host did not ask for (or no longer waits on).
    UnknownAgentTab,
    AlreadyExists,
}

impl CreateRefusal {
    pub fn code(self) -> &'static str {
        match self {
            CreateRefusal::Malformed => "BROWSER_TAB_LABEL_INVALID",
            CreateRefusal::UnknownAgentTab => "BROWSER_TAB_UNKNOWN_AGENT_TAB",
            CreateRefusal::AlreadyExists => "BROWSER_TAB_EXISTS",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            CreateRefusal::Malformed => "not a browser tab label",
            CreateRefusal::UnknownAgentTab => "no agent asked for this tab",
            CreateRefusal::AlreadyExists => "a tab with this label already exists",
        }
    }
}

/// The snapshot the renderer projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub agent_controlled: bool,
    pub epoch: u64,
}

#[derive(Default)]
pub struct TabRegistry {
    tabs: HashMap<String, TabRecord>,
    pending: HashMap<String, PendingAgentTab>,
    default_tab: HashMap<String, String>,
    /// Sessions in teardown: they get no new tabs and no admissions.
    closing: HashSet<String>,
    /// Clears of the global agent profile in progress; while any runs, no
    /// tab binds to it.
    global_clearing: u32,
    next_open: u64,
}

impl TabRegistry {
    pub fn get(&self, label: &str) -> Option<&TabRecord> {
        self.tabs.get(label)
    }

    pub(super) fn get_mut(&mut self, label: &str) -> Option<&mut TabRecord> {
        self.tabs.get_mut(label)
    }

    pub fn view(&self, label: &str) -> Option<TabView> {
        let record = self.tabs.get(label)?;
        Some(TabView {
            tab_id: label.to_string(),
            url: record.url.clone(),
            title: record.title.clone(),
            loading: record.loading,
            agent_controlled: matches!(record.owner, Owner::Agent { .. }),
            epoch: record.epoch,
        })
    }

    pub fn is_closing(&self, session_id: &str) -> bool {
        self.closing.contains(session_id)
    }

    /// Register an agent tab the renderer is about to mount, bound to the
    /// session's profile (see [`super::profile::bind`]). The receiver
    /// resolves when the engine confirmed the webview, with a waiter for
    /// its first navigation.
    pub(super) fn expect_agent_tab(
        &mut self,
        label: &str,
        session_id: &str,
        url: &str,
        requested: TabProfile,
    ) -> Result<oneshot::Receiver<OpenResult>, BindRefusal> {
        let profile = super::profile::bind(self.session_profile(session_id), requested);
        if profile == TabProfile::Global && self.global_clearing > 0 {
            return Err(BindRefusal::GlobalClearing);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.insert(
            label.to_string(),
            PendingAgentTab {
                session_id: session_id.to_string(),
                url: url.to_string(),
                profile,
                popup_of: None,
                opened: tx,
            },
        );
        Ok(rx)
    }

    /// The profile the session's open or opening tabs run in.
    pub fn session_profile(&self, session_id: &str) -> Option<TabProfile> {
        let open = self
            .tabs
            .values()
            .filter(|r| r.life != Lifecycle::Closing && r.session_id() == Some(session_id))
            .filter_map(TabRecord::profile);
        let opening = self
            .pending
            .values()
            .filter(|p| p.session_id == session_id)
            .map(|p| p.profile);
        open.chain(opening).min()
    }

    /// Every agent tab built on the global profile, with its session.
    pub fn global_tabs(&self) -> Vec<(String, String)> {
        self.tabs
            .iter()
            .filter_map(|(label, r)| match &r.owner {
                Owner::Agent {
                    session_id,
                    profile: TabProfile::Global,
                } => Some((label.clone(), session_id.clone())),
                _ => None,
            })
            .collect()
    }

    /// Webviews that hold the global profile or are about to.
    pub fn global_lease(&self) -> usize {
        let opening = self
            .pending
            .values()
            .filter(|p| p.profile == TabProfile::Global)
            .count();
        self.global_tabs().len() + opening
    }

    /// Start or end clearing the global profile. Starting refuses new
    /// global binds and withdraws the global tabs not yet mounted.
    pub fn set_global_clearing(&mut self, clearing: bool) {
        if !clearing {
            self.global_clearing = self.global_clearing.saturating_sub(1);
            return;
        }
        self.global_clearing += 1;
        let pending: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| p.profile == TabProfile::Global)
            .map(|(label, _)| label.clone())
            .collect();
        for label in pending {
            if let Some(p) = self.pending.remove(&label) {
                let _ = p.opened.send(Err("the agent browser profile is being cleared".to_string()));
            }
        }
    }

    /// The opener gave up: the renderer may still mount the tab, and then
    /// finds no request for it.
    pub(super) fn forget_pending(&mut self, label: &str) {
        self.pending.remove(label);
    }

    /// Admit a renderer request to build `label`. The record exists from
    /// here on in `Creating`, so engine events from the first navigation
    /// land on it. Returns how the webview loads its first page.
    pub fn begin_create(&mut self, label: &str, url: &str) -> Result<FirstLoad, CreateRefusal> {
        let kind = parse_label(label).ok_or(CreateRefusal::Malformed)?;
        if self.tabs.contains_key(label) {
            return Err(CreateRefusal::AlreadyExists);
        }
        self.next_open += 1;
        let opened = self.next_open;
        let (owner, url) = match kind {
            LabelKind::User => (Owner::User, url.to_string()),
            LabelKind::Agent => {
                let pending = self.pending.remove(label).ok_or(CreateRefusal::UnknownAgentTab)?;
                if self.closing.contains(&pending.session_id) {
                    let _ = pending.opened.send(Err("the session ended".to_string()));
                    return Err(CreateRefusal::UnknownAgentTab);
                }
                // The host chose the agent tab's URL; the renderer's copy
                // is only a hint.
                let mut record = TabRecord::new(
                    Owner::Agent {
                        session_id: pending.session_id,
                        profile: pending.profile,
                    },
                    &pending.url,
                    opened,
                );
                record.popup_of = pending.popup_of;
                // Registered before the webview exists, so the first
                // navigation's start hop is the one it claims.
                let first_nav = record.wait();
                record.opener = Some(Opener {
                    tx: pending.opened,
                    first_nav,
                });
                self.tabs.insert(label.to_string(), record);
                return Ok(FirstLoad::ViaBlank(pending.url));
            }
        };
        self.tabs.insert(label.to_string(), TabRecord::new(owner, &url, opened));
        Ok(FirstLoad::Direct(url))
    }

    /// The engine confirmed the webview: the tab goes live and a pending
    /// agent opener gets the first navigation's waiter. Returns false when
    /// a close was requested meanwhile (the caller closes it).
    pub fn finish_create(&mut self, label: &str) -> bool {
        let Some(record) = self.tabs.get_mut(label) else {
            return false;
        };
        if record.life == Lifecycle::Closing {
            return false;
        }
        record.life = Lifecycle::Live;
        if let Some(opener) = record.opener.take() {
            if let Some(session) = record.session_id().filter(|_| record.popup_of.is_none()) {
                self.default_tab
                    .entry(session.to_string())
                    .or_insert_with(|| label.to_string());
            }
            let _ = opener.tx.send(Ok(opener.first_nav));
        }
        true
    }

    /// The engine refused or failed to build the webview.
    pub fn fail_create(&mut self, label: &str, why: &str) {
        if let Some(mut record) = self.tabs.remove(label) {
            record.close(why);
        }
    }

    /// Mark `label` closing. Returns false when it is unknown or already
    /// closing; a tab still being built is closed once it is confirmed.
    pub fn begin_close(&mut self, label: &str) -> bool {
        match self.tabs.get_mut(label) {
            Some(record) if record.life != Lifecycle::Closing => {
                record.life = Lifecycle::Closing;
                record.close("the tab was closed");
                true
            }
            _ => false,
        }
    }

    /// The engine confirmed the close: drop the record and move the
    /// session's default to its oldest remaining tab.
    pub fn remove(&mut self, label: &str) -> Option<TabRecord> {
        let mut record = self.tabs.remove(label)?;
        record.close("the tab was closed");
        if let Some(session) = record.session_id() {
            if self.default_tab.get(session).is_some_and(|d| d == label) {
                let next = self
                    .owned(session)
                    .into_iter()
                    .find(|l| self.tabs.get(l).is_some_and(|r| r.popup_of.is_none()));
                match next {
                    Some(next) => self.default_tab.insert(session.to_string(), next),
                    None => self.default_tab.remove(session),
                };
            }
        }
        Some(record)
    }

    /// Live agent tabs owned by `session_id`, oldest first.
    pub fn owned(&self, session_id: &str) -> Vec<String> {
        let mut owned: Vec<(&String, u64)> = self
            .tabs
            .iter()
            .filter(|(_, r)| r.is_live() && r.session_id() == Some(session_id))
            .map(|(label, r)| (label, r.opened))
            .collect();
        owned.sort_by_key(|(_, opened)| *opened);
        owned.into_iter().map(|(label, _)| label.clone()).collect()
    }

    /// Every tab the session owns, live or not, for teardown.
    pub fn session_tabs(&self, session_id: &str) -> Vec<String> {
        self.tabs
            .iter()
            .filter(|(_, r)| r.session_id() == Some(session_id))
            .map(|(label, _)| label.clone())
            .collect()
    }

    pub fn default_tab(&self, session_id: &str) -> Option<&str> {
        self.default_tab.get(session_id).map(String::as_str)
    }

    /// Make `label`, a tab the caller resolved for this session, its default.
    pub fn set_default_tab(&mut self, session_id: &str, label: &str) {
        self.default_tab.insert(session_id.to_string(), label.to_string());
    }

    /// Resolve an agent verb's target. An explicit label must name a live
    /// agent tab this session owns; anything else is `tab_not_found` and
    /// never falls back to another tab. `None` is the session's default.
    pub fn resolve(&self, session_id: &str, tab_id: Option<&str>) -> Result<Option<String>, BrowserError> {
        if let Some(label) = tab_id {
            let owned = parse_label(label) == Some(LabelKind::Agent)
                && self
                    .tabs
                    .get(label)
                    .is_some_and(|r| r.is_live() && r.session_id() == Some(session_id));
            return if owned {
                Ok(Some(label.to_string()))
            } else {
                Err(BrowserError::tab_not_found(label).with_arg_keys(&["tabId"]))
            };
        }
        Ok(self
            .default_tab(session_id)
            .filter(|label| self.tabs.get(*label).is_some_and(TabRecord::is_live))
            .map(str::to_string))
    }

    /// Register a navigation waiter on `label` before the navigation is
    /// issued, so its commit cannot be missed.
    pub fn wait_for_navigation(&mut self, label: &str) -> Option<oneshot::Receiver<NavOutcome>> {
        let record = self.tabs.get_mut(label).filter(|r| r.is_live())?;
        Some(record.wait())
    }

    /// Refuse new tabs and admissions for `session_id` until teardown ends.
    pub fn begin_session_teardown(&mut self, session_id: &str) {
        self.closing.insert(session_id.to_string());
        let pending: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| p.session_id == session_id)
            .map(|(label, _)| label.clone())
            .collect();
        for label in pending {
            if let Some(p) = self.pending.remove(&label) {
                let _ = p.opened.send(Err("the session ended".to_string()));
            }
        }
    }

    pub fn end_session_teardown(&mut self, session_id: &str) {
        self.closing.remove(session_id);
        self.default_tab.remove(session_id);
    }
}

// ---------------------------------------------------------------------------
// Refs
//
// Refs are host tokens `@eN`, unique per tab across epochs, so a ref from an
// older document can never name an element of the current one. Within an
// epoch an identical node keeps its ref across snapshots. A ref resolves
// only while its node was in the tab's latest snapshot of the current
// epoch. Its path names one element and pins the identity the snapshot
// gave it, so nodes that share a role and name each resolve to their own,
// and once the page moves elements a path that would land on another one
// resolves to none (`stale_ref`); actionability then checks that the
// element still has the role and name the ref was minted for.

/// One actionable node as an adapter reports it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RefNode {
    pub role: String,
    pub name: String,
    /// The adapter's locator for the node inside its frame.
    pub path: String,
    pub frame: String,
}

/// Why a ref no longer names an element. All map to `stale_ref`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefStale {
    /// Never minted on this tab.
    Unknown,
    /// Minted for an older document.
    OlderDocument,
    /// Not in the latest snapshot.
    Superseded,
    /// The element behind it no longer has its role and name.
    Gone,
}

impl RefStale {
    pub fn reason(self) -> &'static str {
        match self {
            RefStale::Unknown | RefStale::Gone => "ref_not_resolved",
            RefStale::OlderDocument => "ref_older_document",
            RefStale::Superseded => "ref_superseded",
        }
    }
}

struct MintedRef {
    epoch: u64,
    generation: u64,
    node: RefNode,
}

#[derive(Default)]
pub struct TabRefs {
    next: u64,
    generation: u64,
    epoch: u64,
    /// The first ref number minted for `epoch`; every lower number was
    /// minted for an older document.
    epoch_floor: u64,
    minted: HashMap<u64, MintedRef>,
}

fn ref_number(token: &str) -> Option<u64> {
    token.strip_prefix("@e")?.parse().ok()
}

impl TabRefs {
    /// Mint refs for one snapshot of `epoch`, in node order.
    pub fn mint_snapshot(&mut self, epoch: u64, nodes: Vec<RefNode>) -> Vec<String> {
        self.generation += 1;
        let generation = self.generation;
        if epoch != self.epoch {
            self.epoch = epoch;
            self.epoch_floor = self.next + 1;
            self.minted.clear();
        }
        nodes
            .into_iter()
            .map(|node| {
                let reuse = self
                    .minted
                    .iter()
                    .find(|(_, r)| r.node == node)
                    .map(|(n, _)| *n);
                let n = reuse.unwrap_or_else(|| {
                    self.next += 1;
                    self.next
                });
                self.minted.insert(
                    n,
                    MintedRef {
                        epoch,
                        generation,
                        node,
                    },
                );
                format!("@e{n}")
            })
            .collect()
    }

    /// The node `token` names in the current document.
    pub fn resolve(&self, token: &str, epoch: u64) -> Result<&RefNode, RefStale> {
        let n = ref_number(token).ok_or(RefStale::Unknown)?;
        let Some(minted) = self.minted.get(&n) else {
            return Err(if n >= 1 && n < self.epoch_floor {
                RefStale::OlderDocument
            } else {
                RefStale::Unknown
            });
        };
        if minted.epoch != epoch {
            return Err(RefStale::OlderDocument);
        }
        if minted.generation != self.generation {
            return Err(RefStale::Superseded);
        }
        Ok(&minted.node)
    }
}

pub(super) fn stale_ref_error(token: &str, why: RefStale) -> BrowserError {
    BrowserError::new(
        super::ERR_STALE_REF,
        format!("ref {token} no longer resolves; take a new snapshot"),
    )
    .with_reason(why.reason())
    .with_arg_keys(&["ref"])
}

#[cfg(test)]
#[path = "tabs_tests.rs"]
mod tests;
