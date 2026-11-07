//! The agent cursor, host side: every answered agent canvas call becomes a
//! guest cursor gliding to what the agent touched, plus a ring flash on those
//! nodes (agent cursor contract; the editor draws, the host decides).
//!
//! Nothing here can slow or fail the agent: the call's reply is final before
//! [`Presence::after_call`] runs, which only hands the call to its own task
//! (reading the result, the lookups and the notices all happen there, and a
//! result past [`RESULT_PARSE_LIMIT`] is not read at all), and a failed
//! lookup or notice is only logged at debug. Each session is one guest
//! (id = ACP session id, the agent's display name, a palette colour by hash)
//! whose moves are paced to one per [`MOVE_EVERY`]; the latest activity wins.
//! The host keeps no document state, only each guest's last target (AD-17).

pub mod activity;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::time::Instant;

pub use activity::{derive_activity, Activity, Bounds, Look, Targets};

use crate::canvas::persistence::CanvasPersistence;

/// At most one cursor move per guest per this long.
pub const MOVE_EVERY: Duration = Duration::from_millis(120);
/// A guest already on screen rings its nodes this long after it moves, so
/// the ring and the cursor arrive together.
pub const FLASH_DELAY: Duration = Duration::from_millis(300);
/// The editor fades a guest out on its own after this long without an
/// update, so a later move spawns it afresh.
pub const EDITOR_IDLE: Duration = Duration::from_secs(5);
/// A bounds lookup that takes longer is dropped.
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);

pub const GUEST_CURSOR: &str = "host.guestCursor";
pub const GUEST_FLASH: &str = "host.guestFlash";
pub const GUEST_HIDE: &str = "host.guestHide";

/// Guest colours, picked by a stable hash of the session id.
pub const PALETTE: [&str; 8] = [
    "#7C9CFF", "#FF7A90", "#3DBE8B", "#F5A524", "#B57CFF", "#2EC5CE", "#FF8A4C", "#E05CC0",
];

const UNNAMED_AGENT: &str = "Agent";

/// The longest call result presence reads ids and bounds from; a longer one
/// (a deep `inspect_document`) shows what the params name only.
pub const RESULT_PARSE_LIMIT: usize = 1024 * 1024;

/// The guest colour of `session_id` (FNV-1a over its bytes).
#[must_use]
pub fn colour_of(session_id: &str) -> &'static str {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in session_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    PALETTE[usize::try_from(hash % PALETTE.len() as u64).unwrap_or(0)]
}

/// The agent call presence follows: whose session, which agent, which canvas.
#[derive(Debug, Clone, Copy)]
pub struct CallOrigin<'a> {
    pub session_id: &'a str,
    pub agent_id: &'a str,
    pub project_id: &'a str,
}

/// One session's guest on a canvas. `epoch` names this guest's lifetime: a
/// hide drops it, and a drain task or a delayed flash holding an older epoch
/// then finds nothing to act on.
struct Guest {
    epoch: u64,
    project_id: String,
    name: String,
    pending: Option<Activity>,
    draining: bool,
    last_move: Option<Instant>,
    last_target: Option<(f64, f64)>,
}

/// What a guest's drain task does next.
#[derive(Debug, PartialEq)]
enum Step {
    Done,
    Wait(Instant),
    Locate {
        project_id: String,
        activity: Activity,
        last_target: Option<(f64, f64)>,
    },
}

/// The notices one located activity sends.
#[derive(Debug, PartialEq)]
struct Shown {
    cursor: Option<Value>,
    flash: Option<(Value, Duration)>,
}

/// A session's answered calls not yet offered, and how many times it was
/// hidden since the oldest of them was handed off.
#[derive(Default)]
struct Handed {
    calls: u32,
    hides: u64,
}

/// Every guest, keyed by session id. Pure state: time comes in as `now`.
#[derive(Default)]
struct GuestBook {
    guests: HashMap<String, Guest>,
    epochs: u64,
    handed: HashMap<String, Handed>,
}

impl GuestBook {
    /// A call of `session_id` goes to its own task: the token its offer
    /// presents, so a hide in between voids it.
    fn hand_off(&mut self, session_id: &str) -> u64 {
        let handed = self.handed.entry(session_id.to_string()).or_default();
        handed.calls += 1;
        handed.hides
    }

    /// The handed-off call presenting `token` arrived: whether no hide
    /// happened since it was handed off.
    fn arrive(&mut self, session_id: &str, token: u64) -> bool {
        let Some(handed) = self.handed.get_mut(session_id) else {
            return false;
        };
        let current = handed.hides == token;
        handed.calls -= 1;
        if handed.calls == 0 {
            self.handed.remove(session_id);
        }
        current
    }

    /// Queue `activity` as the guest's next move, replacing one not yet made.
    /// The epoch when a drain task must start for it.
    fn offer(&mut self, origin: CallOrigin<'_>, name: &str, activity: Activity) -> Option<u64> {
        let epochs = &mut self.epochs;
        let guest = self
            .guests
            .entry(origin.session_id.to_string())
            .or_insert_with(|| {
                *epochs += 1;
                Guest {
                    epoch: *epochs,
                    project_id: origin.project_id.to_string(),
                    name: name.to_string(),
                    pending: None,
                    draining: false,
                    last_move: None,
                    last_target: None,
                }
            });
        guest.project_id = origin.project_id.to_string();
        guest.pending = Some(activity);
        if guest.draining {
            return None;
        }
        guest.draining = true;
        Some(guest.epoch)
    }

    fn live(&mut self, session_id: &str, epoch: u64) -> Option<&mut Guest> {
        self.guests
            .get_mut(session_id)
            .filter(|guest| guest.epoch == epoch)
    }

    fn next(&mut self, session_id: &str, epoch: u64, now: Instant) -> Step {
        let Some(guest) = self.live(session_id, epoch) else {
            return Step::Done;
        };
        if guest.pending.is_none() {
            guest.draining = false;
            return Step::Done;
        }
        if let Some(due) = guest.last_move.map(|at| at + MOVE_EVERY) {
            if due > now {
                return Step::Wait(due);
            }
        }
        let Some(activity) = guest.pending.take() else {
            return Step::Done;
        };
        Step::Locate {
            project_id: guest.project_id.clone(),
            activity,
            last_target: guest.last_target,
        }
    }

    /// The located activity moved the cursor to `target` and touched `ids`.
    /// `None` when the guest was hidden meanwhile.
    fn shown(
        &mut self,
        session_id: &str,
        epoch: u64,
        kind: Look,
        target: Option<(f64, f64)>,
        ids: &[u64],
        now: Instant,
    ) -> Option<Shown> {
        let guest = self.live(session_id, epoch)?;
        let on_screen = guest
            .last_move
            .is_some_and(|at| now.duration_since(at) < EDITOR_IDLE);
        let cursor = target.map(|(x, y)| {
            guest.last_move = Some(now);
            guest.last_target = Some((x, y));
            json!({
                "id": session_id,
                "name": guest.name,
                "color": colour_of(session_id),
                "x": x,
                "y": y,
            })
        });
        let delay = if cursor.is_some() && on_screen {
            FLASH_DELAY
        } else {
            Duration::ZERO
        };
        let flash = (!ids.is_empty()).then(|| {
            (
                json!({ "id": session_id, "ids": ids, "kind": kind.as_str() }),
                delay,
            )
        });
        Some(Shown { cursor, flash })
    }

    /// Drop the guest. Its canvas and the hide notice when it was ever shown.
    fn hide(&mut self, session_id: &str) -> Option<(String, Value)> {
        if let Some(handed) = self.handed.get_mut(session_id) {
            handed.hides += 1;
        }
        let guest = self.guests.remove(session_id)?;
        guest.last_move?;
        Some((guest.project_id, json!({ "id": session_id })))
    }
}

/// The host's agent presence: one per `HostPlanServer`, over the process
/// mount registry.
pub struct Presence {
    mounts: Arc<CanvasPersistence>,
    book: Mutex<GuestBook>,
    names: Mutex<HashMap<String, String>>,
}

impl Presence {
    #[must_use]
    pub fn new(mounts: Arc<CanvasPersistence>) -> Arc<Self> {
        Arc::new(Self {
            mounts,
            book: Mutex::new(GuestBook::default()),
            names: Mutex::new(HashMap::new()),
        })
    }

    /// `agent_id`'s display name, shown on its sessions' cursors.
    pub fn name_agent(&self, agent_id: &str, name: &str) {
        let name = name.trim();
        if !name.is_empty() {
            self.names
                .lock()
                .insert(agent_id.to_string(), name.to_string());
        }
    }

    /// `agent_id` exited: its name goes too.
    pub fn forget_agent(&self, agent_id: &str) {
        self.names.lock().remove(agent_id);
    }

    /// An agent call `method(params) -> result` from `tool` was answered.
    /// Hands it to a task of its own and returns at once, so the reply never
    /// waits for the result to be read. Needs a tokio runtime.
    pub fn after_call(
        self: &Arc<Self>,
        origin: CallOrigin<'_>,
        tool: &str,
        method: &str,
        params: &Value,
        result: &str,
    ) {
        if self.mounts.holder_of(origin.project_id).is_none() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::debug!("[canvas-presence] {tool} {method}: no runtime, nothing shown");
            return;
        };
        let this = Arc::clone(self);
        let (session_id, agent_id, project_id) = (
            origin.session_id.to_string(),
            origin.agent_id.to_string(),
            origin.project_id.to_string(),
        );
        let (tool, method, params) = (tool.to_string(), method.to_string(), params.clone());
        let result = if result.len() <= RESULT_PARSE_LIMIT {
            result.to_string()
        } else {
            String::new()
        };
        let token = self.book.lock().hand_off(&session_id);
        runtime.spawn(async move {
            let activity = derive_activity(&tool, &method, &params, &result);
            let origin = CallOrigin {
                session_id: &session_id,
                agent_id: &agent_id,
                project_id: &project_id,
            };
            let name = this
                .names
                .lock()
                .get(origin.agent_id)
                .cloned()
                .unwrap_or_else(|| UNNAMED_AGENT.to_string());
            let started = {
                let mut book = this.book.lock();
                let current = book.arrive(&session_id, token);
                match activity {
                    Some(activity) if current => book.offer(origin, &name, activity),
                    _ => None,
                }
            };
            if let Some(epoch) = started {
                this.drain(session_id, epoch).await;
            }
        });
    }

    /// The session's turn ended or it closed: its guest fades out.
    pub fn hide(&self, session_id: &str) {
        let mut book = self.book.lock();
        if let Some((project_id, params)) = book.hide(session_id) {
            self.notice(&project_id, GUEST_HIDE, &params);
        }
    }

    async fn drain(self: Arc<Self>, session_id: String, epoch: u64) {
        loop {
            let step = self.book.lock().next(&session_id, epoch, Instant::now());
            let (project_id, activity, last_target) = match step {
                Step::Done => return,
                Step::Wait(due) => {
                    tokio::time::sleep_until(due).await;
                    continue;
                }
                Step::Locate {
                    project_id,
                    activity,
                    last_target,
                } => (project_id, activity, last_target),
            };
            let (target, ids) = self
                .locate(&project_id, activity.targets, last_target)
                .await;
            // Sent under the book lock, so a hide is never overtaken.
            let mut book = self.book.lock();
            let Some(shown) = book.shown(
                &session_id,
                epoch,
                activity.kind,
                target,
                &ids,
                Instant::now(),
            ) else {
                return;
            };
            if let Some(cursor) = shown.cursor {
                self.notice(&project_id, GUEST_CURSOR, &cursor);
            }
            match shown.flash {
                Some((flash, delay)) if delay.is_zero() => {
                    self.notice(&project_id, GUEST_FLASH, &flash);
                }
                Some((flash, delay)) => {
                    let this = Arc::clone(&self);
                    let session_id = session_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        let mut book = this.book.lock();
                        if book.live(&session_id, epoch).is_some() {
                            this.notice(&project_id, GUEST_FLASH, &flash);
                        }
                    });
                }
                None => {}
            }
        }
    }

    /// The cursor target (the centre of the last touched node) and the ids
    /// to flash. A selection or page target costs one lookup to name its
    /// nodes; nodes without known bounds cost one `node.get`.
    async fn locate(
        &self,
        project_id: &str,
        targets: Targets,
        last_target: Option<(f64, f64)>,
    ) -> (Option<(f64, f64)>, Vec<u64>) {
        let named = match targets {
            Targets::InPlace => return (last_target, Vec::new()),
            Targets::Selection => self
                .lookup(project_id, "document.inspect", json!({ "depth": 0 }))
                .await
                .map(|document| activity::selection_of(&document)),
            Targets::Page => self
                .lookup(project_id, "document.inspect", json!({ "depth": 1 }))
                .await
                .map(|document| activity::page_layers(&document)),
            nodes @ Targets::Nodes { .. } => Some(nodes),
        };
        let Some(Targets::Nodes { ids, last }) = named else {
            return (None, Vec::new());
        };
        let Some(&last_id) = ids.last() else {
            return (None, ids);
        };
        let bounds = match last {
            Some(bounds) => Some(bounds),
            None => self
                .lookup(project_id, "node.get", json!({ "id": last_id, "depth": 0 }))
                .await
                .and_then(|node| Bounds::of_node(&node)),
        };
        (bounds.map(Bounds::centre), ids)
    }

    async fn lookup(&self, project_id: &str, method: &str, params: Value) -> Option<Value> {
        match self
            .mounts
            .presence_call(project_id, method, params.to_string(), LOOKUP_TIMEOUT)
            .await
        {
            Ok(result) => serde_json::from_str(&result).ok(),
            Err(error) => {
                log::debug!(
                    "[canvas-presence] {method} for project {project_id} failed: {}",
                    error.code.as_str()
                );
                None
            }
        }
    }

    fn notice(&self, project_id: &str, method: &str, params: &Value) {
        let delivered = self
            .mounts
            .presence_notice(project_id, method, params.to_string());
        log::debug!("[canvas-presence] {method} for project {project_id} delivered={delivered}");
    }
}

#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod tests;
