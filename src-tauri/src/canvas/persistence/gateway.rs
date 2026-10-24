//! The agent gateway's half of the mount registry (spine AD-19, AD-21,
//! AD-29): which renderer connection holds each mount, and the calls waiting
//! on one. `host_mcp::canvas::CanvasRouter` is the thin front the transports
//! and the `host_mcp` parent use.
//!
//! Only the mount's lease holder (AD-30) may attach a connection to it. When
//! that connection ends the holder keeps the lease for the mount's grace
//! ([`CanvasPersistence::release_holder`]); the gateway front then calls
//! [`CanvasPersistence::expire_lease`], which drops a mount nobody took up
//! again.
//!
//! A call waits on three things at once: the reply, its timeout, and the
//! connection it went to. A [`Connection`] owns a `watch` sender that is never
//! sent on; every waiting call holds a receiver, so dropping the connection
//! (a newer connection or mountSeq replaced it, the renderer reported the
//! unmount or disconnected, or the mount closed) resolves those calls
//! `CANVAS_CLOSED` without a list to sweep. An agent call that arrives while
//! the holder's connection is lost but inside its grace waits for the holder
//! to attach again, within the same call timeout.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::{CanvasPersistence, ExpiredLease, Lifecycle, Link, Mount, RendererId};
use crate::acp::host_mcp::bridge::MAX_REPLY_BYTES;
use crate::acp::host_mcp::canvas::{
    CanvasCallFrame, CanvasError, CanvasErrorCode, CanvasHolder, CanvasOutcome,
};

/// The renderer connection a mount's editor runs in.
pub(super) struct Connection {
    holder: CanvasHolder,
    gone: watch::Sender<()>,
}

impl Connection {
    pub(super) fn holder(&self) -> &CanvasHolder {
        &self.holder
    }

    fn new(holder: CanvasHolder) -> Self {
        let (gone, _) = watch::channel(());
        Self { holder, gone }
    }
}

struct Pending {
    holder_id: String,
    mount_seq: u64,
    sent_at: Instant,
    deadline: Instant,
    /// Whether the call feeds the crash detector ([`Route::watched`]).
    watched: bool,
    /// The leading slices of a long reply, which arrive ahead of its last one.
    slices: String,
    responder: oneshot::Sender<CanvasOutcome>,
}

type Waiting = Arc<Mutex<HashMap<u64, Pending>>>;

/// The most watched calls remembered after they timed out, for a late
/// answer to prove the editor alive.
const TIMED_OUT_REMEMBERED: usize = 256;

pub(super) struct Calls {
    /// Shared with each [`LateAnswer`], which removes its call when dropped.
    waiting: Waiting,
    /// Watched calls that timed out, by call id: the connection and mount
    /// they went to.
    timed_out: Mutex<HashMap<u64, (String, u64)>>,
    next_id: AtomicU64,
    /// The longest reply, slices joined. A field so a test can lower it.
    reply_limit: AtomicU64,
}

impl Default for Calls {
    fn default() -> Self {
        Self {
            waiting: Waiting::default(),
            timed_out: Mutex::default(),
            next_id: AtomicU64::default(),
            reply_limit: AtomicU64::new(MAX_REPLY_BYTES),
        }
    }
}

/// Who is asking. Agent calls are refused while the mount quiesces and are
/// counted so the quiesce can wait them out; the host's own calls belong to
/// the close sequence and name the mount they expect. Presence lookups
/// follow an agent call already answered, and render-budget lookups size an
/// agent call about to be sent: they reach only a connected
/// editor, and never count as activity, as a call the quiesce waits for, or
/// toward the crash timeouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Caller {
    Agent,
    Host { mount_seq: u64 },
    Presence,
}

/// Keeps an agent call counted in its mount's `in_flight` until it settles.
struct InFlight(Arc<Mount>);

impl InFlight {
    /// Call with the mount's state lock held, so a quiesce that flips the
    /// lifecycle under the same lock sees every call it lets through.
    fn enter(mount: &Arc<Mount>) -> Self {
        mount.in_flight.send_modify(|count| *count += 1);
        Self(Arc::clone(mount))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0
            .in_flight
            .send_modify(|count| *count = count.saturating_sub(1));
    }
}

struct Route {
    mount_seq: u64,
    holder: CanvasHolder,
    gone: watch::Receiver<()>,
    _in_flight: Option<InFlight>,
    /// Whether the answer or timeout feeds the crash detector.
    watched: bool,
}

/// Where a call can go right now.
enum Routed {
    Ready(Route),
    /// The holder's connection dropped and its lease grace runs until
    /// `grace_ends`; `ended` wakes when the holder attaches again or the
    /// mount goes.
    Reconnecting {
        ended: watch::Receiver<()>,
        grace_ends: Instant,
    },
}

fn refused(code: CanvasErrorCode, message: &str) -> CanvasError {
    CanvasError::new(code, message)
}

fn not_running() -> CanvasError {
    refused(
        CanvasErrorCode::CanvasClosed,
        "the canvas is not running in any window",
    )
}

/// The answer to a call that timed out at the gateway while the editor may
/// still be working on it (an export with a `path` still gets written).
/// Dropping it stops waiting.
pub struct LateAnswer {
    call_id: u64,
    waiting: Waiting,
    answer: oneshot::Receiver<CanvasOutcome>,
    gone: watch::Receiver<()>,
}

impl LateAnswer {
    /// The editor's answer, or `None` when its connection ended or `limit`
    /// passed first.
    pub async fn wait(mut self, limit: Duration) -> Option<CanvasOutcome> {
        tokio::select! {
            answered = &mut self.answer => answered.ok(),
            _ = self.gone.changed() => None,
            () = tokio::time::sleep(limit) => None,
        }
    }
}

impl Drop for LateAnswer {
    fn drop(&mut self) {
        self.waiting.lock().remove(&self.call_id);
    }
}

/// A call that failed; `late` is set when it timed out and the caller asked
/// to keep waiting for the editor's answer.
pub struct CallFailed {
    pub error: CanvasError,
    pub late: Option<LateAnswer>,
}

impl From<CanvasError> for CallFailed {
    fn from(error: CanvasError) -> Self {
        Self { error, late: None }
    }
}

fn timed_out(timeout: Duration) -> CanvasError {
    CanvasError::new(
        CanvasErrorCode::CanvasTimeout,
        format!(
            "the canvas did not answer within {} ms",
            timeout.as_millis()
        ),
    )
}

/// A mount whose holder's connection ended: the holder keeps the lease for
/// `grace`, then [`CanvasPersistence::expire_lease`] drops the mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LostLease {
    pub project_id: String,
    pub mount_seq: u64,
    pub grace: Duration,
}

fn held_by(link: &Link, connection_id: &str) -> bool {
    link.connection()
        .is_some_and(|connection| connection.holder.id() == connection_id)
}

impl CanvasPersistence {
    /// `holder` now runs the editor of `project_id`'s mount at `mount_seq`,
    /// which also takes up a lease kept through a reconnect. A previous
    /// connection's calls resolve `CANVAS_CLOSED`. Refused (false) when the
    /// host holds no such mount or another renderer holds its lease: a stale
    /// report cannot claim a project.
    pub fn attach(&self, project_id: &str, mount_seq: u64, holder: CanvasHolder) -> bool {
        let Some(mount) = self.mounts.lock().get(project_id).cloned() else {
            return false;
        };
        if mount.mount_seq != mount_seq || mount.holder != *holder.renderer() {
            return false;
        }
        let previous = {
            let mut state = mount.state.lock();
            if state.lifecycle == Lifecycle::Closed {
                return false;
            }
            std::mem::replace(&mut state.link, Link::Attached(Connection::new(holder)))
        };
        drop(previous);
        true
    }

    /// The renderer reports it no longer runs the mount. Only the connection
    /// holding `(project_id, mount_seq)` can detach it; the mount itself
    /// stays (it is unmounted only through [`Self::close`]).
    pub fn detach(&self, project_id: &str, holder_id: &str, mount_seq: u64) -> bool {
        let Some(mount) = self.mounts.lock().get(project_id).cloned() else {
            return false;
        };
        if mount.mount_seq != mount_seq {
            return false;
        }
        let taken = {
            let mut state = mount.state.lock();
            if !held_by(&state.link, holder_id) {
                return false;
            }
            state.activity.visible = false;
            std::mem::replace(&mut state.link, Link::Unattached)
        };
        drop(taken);
        true
    }

    /// The connection `holder_id` ended. Calls it was handed resolve
    /// `CANVAS_CLOSED` now, but each mount it ran keeps its lease for the
    /// mount's grace; the caller schedules [`Self::expire_lease`] for each
    /// returned [`LostLease`].
    pub fn release_holder(&self, holder_id: &str) -> Vec<LostLease> {
        let mounts: Vec<(String, Arc<Mount>)> = self
            .mounts
            .lock()
            .iter()
            .map(|(project, mount)| (project.clone(), Arc::clone(mount)))
            .collect();
        let mut lost = Vec::new();
        for (project_id, mount) in mounts {
            let taken = {
                let mut state = mount.state.lock();
                if !held_by(&state.link, holder_id) {
                    continue;
                }
                state.activity.visible = false;
                std::mem::replace(&mut state.link, Link::lost())
            };
            drop(taken);
            lost.push(LostLease {
                project_id,
                mount_seq: mount.mount_seq,
                grace: mount.lease_grace,
            });
        }
        lost
    }

    /// The grace of a [`LostLease`] ran out: if the holder has not taken the
    /// mount up again, unmount it without a save (no renderer is left to
    /// snapshot it; its last autosave stands). `None` when the mount was
    /// reattached, replaced or closed meanwhile, or lost again since.
    pub fn expire_lease(&self, project_id: &str, mount_seq: u64) -> Option<ExpiredLease> {
        let mut mounts = self.mounts.lock();
        let mount = mounts
            .get(project_id)
            .filter(|mount| mount.mount_seq == mount_seq)
            .cloned()?;
        {
            let state = mount.state.lock();
            let Link::Lost { since, .. } = state.link else {
                return None;
            };
            if state.lifecycle != Lifecycle::Open || since.elapsed() < mount.lease_grace {
                return None;
            }
        }
        mounts.remove(project_id);
        drop(mounts);
        let expired = ExpiredLease::of(&mount.view());
        Self::retire(&mount);
        Some(expired)
    }

    /// The renderer holding `project_id`'s lease, whether or not it is
    /// connected.
    pub fn lease_holder(&self, project_id: &str) -> Option<RendererId> {
        let mount = self.mounts.lock().get(project_id).cloned()?;
        let open = mount.state.lock().lifecycle != Lifecycle::Closed;
        open.then(|| mount.holder.clone())
    }

    /// The renderer connection running `project_id`'s editor, if any.
    pub fn holder_of(&self, project_id: &str) -> Option<(u64, String)> {
        let mount = self.mounts.lock().get(project_id).cloned()?;
        let state = mount.state.lock();
        let holder_id = state.link.connection()?.holder.id().to_string();
        Some((mount.mount_seq, holder_id))
    }

    fn route(&self, project_id: &str, caller: Caller) -> Result<Routed, CanvasError> {
        let no_canvas = || {
            refused(
                CanvasErrorCode::CanvasClosed,
                "no canvas is open for this project",
            )
        };
        let mount = self
            .mounts
            .lock()
            .get(project_id)
            .cloned()
            .ok_or_else(no_canvas)?;
        if let Caller::Host { mount_seq } = caller {
            if mount.mount_seq != mount_seq {
                return Err(refused(
                    CanvasErrorCode::CanvasClosed,
                    "the canvas was remounted",
                ));
            }
        }
        let mut state = mount.state.lock();
        match (state.lifecycle, caller) {
            (Lifecycle::Closed, _) => return Err(no_canvas()),
            (Lifecycle::Closing, Caller::Agent | Caller::Presence) => {
                return Err(refused(
                    CanvasErrorCode::CanvasClosing,
                    "the canvas is closing",
                ))
            }
            _ => {}
        }
        let connection = match &state.link {
            Link::Attached(connection) => connection,
            Link::Lost { since, ended }
                if caller != Caller::Presence && since.elapsed() < mount.lease_grace =>
            {
                return Ok(Routed::Reconnecting {
                    ended: ended.subscribe(),
                    grace_ends: *since + mount.lease_grace,
                });
            }
            Link::Lost { .. } | Link::Unattached => return Err(not_running()),
        };
        let holder = connection.holder.clone();
        let gone = connection.gone.subscribe();
        if caller == Caller::Agent {
            state.activity.tick = self.tick();
        }
        Ok(Routed::Ready(Route {
            mount_seq: mount.mount_seq,
            holder,
            gone,
            _in_flight: (caller == Caller::Agent).then(|| InFlight::enter(&mount)),
            watched: caller != Caller::Presence,
        }))
    }

    /// An agent call: forwarded to the renderer holding the project's mount
    /// and answered from its editor, or a typed refusal. A call that arrives
    /// while the holder reconnects inside its lease grace waits for it to
    /// attach again. Waits up to `timeout` in all; nothing else times a
    /// canvas call out (AD-29).
    pub async fn call(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> CanvasOutcome {
        self.agent_call(project_id, method, params, timeout, false)
            .await
            .map_err(|failed| failed.error)
    }

    /// [`Self::call`], except that a call the editor received but did not
    /// answer in time hands back a [`LateAnswer`] for its answer.
    pub async fn call_keeping_late(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> Result<String, CallFailed> {
        self.agent_call(project_id, method, params, timeout, true)
            .await
    }

    async fn agent_call(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
        keep_late: bool,
    ) -> Result<String, CallFailed> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.route(project_id, Caller::Agent)? {
                Routed::Ready(route) => {
                    return self
                        .forward(
                            project_id,
                            route,
                            method,
                            params,
                            (deadline, timeout),
                            keep_late,
                        )
                        .await;
                }
                Routed::Reconnecting {
                    mut ended,
                    grace_ends,
                } => {
                    tokio::select! {
                        _ = ended.changed() => {}
                        () = tokio::time::sleep_until(grace_ends.min(deadline)) => {}
                    }
                    if Instant::now() >= deadline {
                        return Err(timed_out(timeout).into());
                    }
                }
            }
        }
    }

    /// The host's own editor call on the mount at `mount_seq`. It passes the
    /// quiesce: the close sequence uses it to snapshot and verify.
    pub(super) async fn host_call(
        &self,
        project_id: &str,
        mount_seq: u64,
        method: &str,
        params: &str,
    ) -> CanvasOutcome {
        let Routed::Ready(route) = self.route(project_id, Caller::Host { mount_seq })? else {
            return Err(not_running());
        };
        self.forward(
            project_id,
            route,
            method,
            params.to_string(),
            (
                Instant::now() + self.host_call_timeout,
                self.host_call_timeout,
            ),
            false,
        )
        .await
        .map_err(|failed| failed.error)
    }

    /// A presence lookup (`node.get`, `document.inspect`) for an agent call
    /// already answered, or the bounds lookup that sizes a render's wait
    /// (`host_mcp::canvas_budget`). It goes only to a connected editor, never waits out
    /// a reconnect, and leaves activity, the quiesce and the crash count
    /// alone (see [`Caller::Presence`]).
    pub async fn presence_call(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> CanvasOutcome {
        let Routed::Ready(route) = self.route(project_id, Caller::Presence)? else {
            return Err(not_running());
        };
        self.forward(
            project_id,
            route,
            method,
            params,
            (Instant::now() + timeout, timeout),
            false,
        )
        .await
        .map_err(|failed| failed.error)
    }

    /// A presence notice (`host.guest*`) to the connected editor of
    /// `project_id`'s open mount. False when none is connected or the frame
    /// was not queued; nothing waits for the answer.
    pub fn presence_notice(&self, project_id: &str, method: &str, params: String) -> bool {
        let Some(mount) = self.mounts.lock().get(project_id).cloned() else {
            return false;
        };
        let holder = {
            let state = mount.state.lock();
            if state.lifecycle != Lifecycle::Open {
                return false;
            }
            let Some(connection) = state.link.connection() else {
                return false;
            };
            connection.holder.clone()
        };
        self.notify(&holder, project_id, mount.mount_seq, method, params)
    }

    async fn forward(
        &self,
        project_id: &str,
        route: Route,
        method: &str,
        params: String,
        (deadline, timeout): (Instant, Duration),
        keep_late: bool,
    ) -> Result<String, CallFailed> {
        let Route {
            mount_seq,
            holder,
            mut gone,
            _in_flight,
            watched,
        } = route;
        let call_id = self.calls.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (responder, mut waiting) = oneshot::channel();
        let sent_at = Instant::now();
        self.calls.waiting.lock().insert(
            call_id,
            Pending {
                holder_id: holder.id().to_string(),
                mount_seq,
                sent_at,
                deadline,
                watched,
                slices: String::new(),
                responder,
            },
        );
        let frame = CanvasCallFrame::new(call_id, project_id, mount_seq, method, params)
            .expiring_in(deadline.saturating_duration_since(sent_at));
        if !holder.deliver(frame) {
            self.calls.waiting.lock().remove(&call_id);
            return Err(refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas renderer is not reachable",
            )
            .into());
        }
        let gone_before_answer = || {
            Err(refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas closed before it answered",
            ))
        };
        let outcome = tokio::select! {
            answered = &mut waiting => match answered {
                Ok(outcome) => {
                    if watched && answered_by_editor(&outcome) {
                        self.call_answered(project_id, mount_seq);
                    }
                    outcome
                }
                Err(_) => gone_before_answer(),
            },
            _ = gone.changed() => gone_before_answer(),
            () = tokio::time::sleep_until(deadline) => {
                if !keep_late {
                    self.calls.waiting.lock().remove(&call_id);
                }
                if watched {
                    self.remember_timed_out(call_id, holder.id(), mount_seq);
                    if !self.calls.busy_before(holder.id(), mount_seq, sent_at) {
                        self.call_timed_out(project_id, mount_seq, sent_at);
                    }
                }
                let late = keep_late.then(|| LateAnswer {
                    call_id,
                    waiting: Arc::clone(&self.calls.waiting),
                    answer: waiting,
                    gone,
                });
                return Err(CallFailed {
                    error: timed_out(timeout),
                    late,
                });
            }
        };
        self.calls.waiting.lock().remove(&call_id);
        outcome.map_err(CallFailed::from)
    }

    /// A host notice to the renderer on `holder`, on the call channel so it
    /// reaches both transports alike. Nothing waits for the answer: a reply
    /// to it finds no waiting call and is dropped. False when it was not
    /// queued.
    pub(super) fn notify(
        &self,
        holder: &CanvasHolder,
        project_id: &str,
        mount_seq: u64,
        method: &str,
        params: String,
    ) -> bool {
        let call_id = self.calls.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        holder.deliver(CanvasCallFrame::new(
            call_id, project_id, mount_seq, method, params,
        ))
    }

    /// Lower the longest reply to `bytes`.
    #[cfg(test)]
    pub(crate) fn limit_replies_to(&self, bytes: u64) {
        self.calls.reply_limit.store(bytes, Ordering::Relaxed);
    }

    /// A renderer sent the next slice of its reply to `call_id`, which is not
    /// its last: the slices are joined when the last one arrives. A slice that
    /// takes the reply past the limit ([`MAX_REPLY_BYTES`]) resolves the call with an
    /// `ENGINE_ERROR`, as the bridge does for an oversize frame.
    pub fn push_reply_slice(&self, holder_id: &str, call_id: u64, slice: &str) -> SliceMatch {
        let limit = self.calls.reply_limit.load(Ordering::Relaxed);
        let mut waiting = self.calls.waiting.lock();
        let Some(call) = waiting
            .get_mut(&call_id)
            .filter(|call| call.holder_id == holder_id)
        else {
            return SliceMatch::NotWaiting;
        };
        if call.slices.len().saturating_add(slice.len()) as u64 <= limit {
            call.slices.push_str(slice);
            return SliceMatch::Buffered;
        }
        if let Some(call) = waiting.remove(&call_id) {
            let _ = call.responder.send(Err(reply_too_large(limit)));
        }
        SliceMatch::TooLarge
    }

    /// A renderer answered `call_id`. Only the connection the call went to
    /// may answer it; a reply stamped with another `mountSeq` means the mount
    /// changed under the call, which resolves `CANVAS_CLOSED`. Returns
    /// whether a waiting call was resolved.
    pub fn reply(
        &self,
        holder_id: &str,
        call_id: u64,
        mount_seq: u64,
        outcome: CanvasOutcome,
    ) -> ReplyMatch {
        let pending = {
            let mut waiting = self.calls.waiting.lock();
            match waiting.get(&call_id) {
                Some(call) if call.holder_id == holder_id => waiting.remove(&call_id),
                _ => None,
            }
        };
        let late = self.calls.timed_out.lock().remove(&call_id);
        if let Some((sent_to, sent_seq)) = late {
            if sent_to == holder_id && sent_seq == mount_seq && answered_by_editor(&outcome) {
                self.late_answer(holder_id, mount_seq);
            }
        }
        let Some(call) = pending else {
            return ReplyMatch::NotWaiting;
        };
        if call.mount_seq == mount_seq {
            let _ = call.responder.send(join_slices(
                call.slices,
                outcome,
                self.calls.reply_limit.load(Ordering::Relaxed),
            ));
            ReplyMatch::Resolved
        } else {
            let _ = call.responder.send(Err(refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas was remounted",
            )));
            ReplyMatch::StaleMount {
                sent_to: call.mount_seq,
            }
        }
    }
}

impl Calls {
    /// Whether a watched call sent to the same editor before `sent_at` is
    /// still inside its own wait. The editor runs one call at a time, so a
    /// call queued behind a long render times out while the editor works,
    /// which is not a stall. Calls that all wait the same time never overlap
    /// this way, so for them the crash count is unchanged.
    fn busy_before(&self, holder_id: &str, mount_seq: u64, sent_at: Instant) -> bool {
        let now = Instant::now();
        self.waiting.lock().values().any(|call| {
            call.watched
                && call.holder_id == holder_id
                && call.mount_seq == mount_seq
                && call.sent_at < sent_at
                && call.deadline > now
        })
    }
}

impl CanvasPersistence {
    fn remember_timed_out(&self, call_id: u64, holder_id: &str, mount_seq: u64) {
        let mut timed_out = self.calls.timed_out.lock();
        if timed_out.len() >= TIMED_OUT_REMEMBERED {
            let floor = call_id.saturating_sub(TIMED_OUT_REMEMBERED as u64);
            timed_out.retain(|id, _| *id > floor);
        }
        timed_out.insert(call_id, (holder_id.to_string(), mount_seq));
    }
}

/// A reply the editor itself gave, not the renderer answering for a call
/// that never reached it (its own timeout, or no mount).
fn answered_by_editor(outcome: &CanvasOutcome) -> bool {
    !matches!(
        outcome,
        Err(error) if matches!(
            error.code,
            CanvasErrorCode::CanvasTimeout | CanvasErrorCode::CanvasClosed
        )
    )
}

/// What a renderer reply matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyMatch {
    Resolved,
    /// The call went to `sent_to`; the reply came from another mount.
    StaleMount {
        sent_to: u64,
    },
    NotWaiting,
}

/// What became of one slice of a long reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliceMatch {
    Buffered,
    /// No call of that connection waits for it; the slice was dropped.
    NotWaiting,
    /// The reply grew past the limit; the call was resolved with an error.
    TooLarge,
}

fn reply_too_large(limit: u64) -> CanvasError {
    refused(
        CanvasErrorCode::EngineError,
        &format!(
            "the canvas reply is larger than the {} MiB limit",
            limit / (1024 * 1024)
        ),
    )
}

/// The reply a renderer ended with, behind the slices it sent first.
fn join_slices(mut slices: String, last: CanvasOutcome, limit: u64) -> CanvasOutcome {
    let last = last?;
    if slices.is_empty() {
        return Ok(last);
    }
    if slices.len().saturating_add(last.len()) as u64 > limit {
        return Err(reply_too_large(limit));
    }
    slices.push_str(&last);
    Ok(slices)
}
