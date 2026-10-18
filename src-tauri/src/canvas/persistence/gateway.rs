//! The agent gateway's half of the mount registry (spine AD-19, AD-21,
//! AD-29): which renderer connection holds each mount, and the calls waiting
//! on one. `host_mcp::canvas::CanvasRouter` is the thin front the transports
//! and the `host_mcp` parent use.
//!
//! A call waits on three things at once: the reply, its timeout, and the
//! connection it went to. A [`Connection`] owns a `watch` sender that is never
//! sent on; every waiting call holds a receiver, so dropping the connection
//! (a newer connection or mountSeq replaced it, the renderer reported the
//! unmount or disconnected, or the mount closed) resolves those calls
//! `CANVAS_CLOSED` without a list to sweep.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{oneshot, watch};

use super::{CanvasPersistence, Lifecycle, Mount};
use crate::acp::host_mcp::canvas::{
    CanvasCallFrame, CanvasError, CanvasErrorCode, CanvasHolder, CanvasOutcome,
};

/// The renderer connection a mount's editor runs in.
pub(super) struct Connection {
    holder: CanvasHolder,
    gone: watch::Sender<()>,
}

impl Connection {
    fn new(holder: CanvasHolder) -> Self {
        let (gone, _) = watch::channel(());
        Self { holder, gone }
    }
}

struct Pending {
    holder_id: String,
    mount_seq: u64,
    responder: oneshot::Sender<CanvasOutcome>,
}

#[derive(Default)]
pub(super) struct Calls {
    waiting: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
}

/// Who is asking. Agent calls are refused while the mount quiesces and are
/// counted so the quiesce can wait them out; the host's own calls belong to
/// the close sequence and name the mount they expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Caller {
    Agent,
    Host { mount_seq: u64 },
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
}

fn refused(code: CanvasErrorCode, message: &str) -> CanvasError {
    CanvasError::new(code, message)
}

impl CanvasPersistence {
    /// `holder` now runs the editor of `project_id`'s mount at `mount_seq`.
    /// A previous connection's calls resolve `CANVAS_CLOSED`. Refused (false)
    /// when the host holds no such mount: a stale report cannot claim a
    /// project.
    pub fn attach(&self, project_id: &str, mount_seq: u64, holder: CanvasHolder) -> bool {
        let Some(mount) = self.mounts.lock().get(project_id).cloned() else {
            return false;
        };
        if mount.mount_seq != mount_seq {
            return false;
        }
        let previous = {
            let mut state = mount.state.lock();
            if state.lifecycle == Lifecycle::Closed {
                return false;
            }
            state.connection.replace(Connection::new(holder))
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
            let held = state
                .connection
                .as_ref()
                .is_some_and(|connection| connection.holder.id() == holder_id);
            if !held {
                return false;
            }
            state.connection.take()
        };
        drop(taken);
        true
    }

    /// The connection `holder_id` ended: it holds nothing any more. Returns
    /// the projects it held.
    pub fn release_holder(&self, holder_id: &str) -> Vec<String> {
        let mounts: Vec<(String, Arc<Mount>)> = self
            .mounts
            .lock()
            .iter()
            .map(|(project, mount)| (project.clone(), Arc::clone(mount)))
            .collect();
        let mut released = Vec::new();
        for (project, mount) in mounts {
            let taken = {
                let mut state = mount.state.lock();
                let held = state
                    .connection
                    .as_ref()
                    .is_some_and(|connection| connection.holder.id() == holder_id);
                if held {
                    state.connection.take()
                } else {
                    None
                }
            };
            if taken.is_some() {
                released.push(project);
            }
        }
        released
    }

    /// The renderer connection running `project_id`'s editor, if any.
    pub fn holder_of(&self, project_id: &str) -> Option<(u64, String)> {
        let mount = self.mounts.lock().get(project_id).cloned()?;
        let state = mount.state.lock();
        let holder_id = state.connection.as_ref()?.holder.id().to_string();
        Some((mount.mount_seq, holder_id))
    }

    fn route(&self, project_id: &str, caller: Caller) -> Result<Route, CanvasError> {
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
        let state = mount.state.lock();
        match (state.lifecycle, caller) {
            (Lifecycle::Closed, _) => return Err(no_canvas()),
            (Lifecycle::Closing, Caller::Agent) => {
                return Err(refused(
                    CanvasErrorCode::CanvasClosing,
                    "the canvas is closing",
                ))
            }
            _ => {}
        }
        let connection = state.connection.as_ref().ok_or_else(|| {
            refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas is not running in any window",
            )
        })?;
        Ok(Route {
            mount_seq: mount.mount_seq,
            holder: connection.holder.clone(),
            gone: connection.gone.subscribe(),
            _in_flight: (caller == Caller::Agent).then(|| InFlight::enter(&mount)),
        })
    }

    /// An agent call: forwarded to the renderer holding the project's mount
    /// and answered from its editor, or a typed refusal. Waits up to
    /// `timeout`; nothing else times a canvas call out (AD-29).
    pub async fn call(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> CanvasOutcome {
        let route = self.route(project_id, Caller::Agent)?;
        self.forward(project_id, route, method, params, timeout)
            .await
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
        let route = self.route(project_id, Caller::Host { mount_seq })?;
        self.forward(
            project_id,
            route,
            method,
            params.to_string(),
            self.host_call_timeout,
        )
        .await
    }

    async fn forward(
        &self,
        project_id: &str,
        route: Route,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> CanvasOutcome {
        let Route {
            mount_seq,
            holder,
            mut gone,
            _in_flight,
        } = route;
        let call_id = self.calls.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (responder, waiting) = oneshot::channel();
        self.calls.waiting.lock().insert(
            call_id,
            Pending {
                holder_id: holder.id().to_string(),
                mount_seq,
                responder,
            },
        );
        let frame = CanvasCallFrame::new(call_id, project_id, mount_seq, method, params);
        if !holder.deliver(frame) {
            self.calls.waiting.lock().remove(&call_id);
            return Err(refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas renderer is not reachable",
            ));
        }
        let outcome = tokio::select! {
            answered = waiting => answered.unwrap_or_else(|_| {
                Err(refused(CanvasErrorCode::CanvasClosed, "the canvas closed before it answered"))
            }),
            _ = gone.changed() => Err(refused(
                CanvasErrorCode::CanvasClosed,
                "the canvas closed before it answered",
            )),
            () = tokio::time::sleep(timeout) => Err(CanvasError::new(
                CanvasErrorCode::CanvasTimeout,
                format!("the canvas did not answer within {} ms", timeout.as_millis()),
            )),
        };
        self.calls.waiting.lock().remove(&call_id);
        outcome
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
        let Some(call) = pending else {
            return ReplyMatch::NotWaiting;
        };
        if call.mount_seq == mount_seq {
            let _ = call.responder.send(outcome);
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
