//! Per-request execution with per-entity order (AD-19).
//!
//! The read loop never awaits a handler: it hands each validated request to a
//! [`KeyedExecutor`]. Requests that name the same entity (one session, agent,
//! terminal, project or store key) run one at a time in arrival order through
//! that entity's serial queue; requests on different entities, and requests
//! that name none, run concurrently. So `send_prompt` then `cancel_prompt` on
//! one session cannot reorder, while a slow install on another entity cannot
//! block a prompt.
//!
//! The executor owns its tasks: dropping it (the connection ended) aborts
//! every running handler.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;

use futures::FutureExt;
use serde_json::Value;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::WsRequest;

/// Requests queued or running on one connection before new ones are refused
/// with `rate_limited`. A well-behaved client has a handful in flight; the cap
/// only bounds a flooding peer (the read loop used to be the throttle).
pub(super) const MAX_INFLIGHT_REQUESTS: usize = 256;

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The entity a request names, namespaced by kind so ids of different kinds
/// never share a queue.
pub(super) type EntityKey = String;

/// The serial-queue key for `request`: the first entity it names, in the order
/// session, terminal, agent, project, store key. `None` for requests that name
/// no entity (they run concurrently with everything).
pub(super) fn entity_key(request: &WsRequest) -> Option<EntityKey> {
    let payload = &request.payload;
    let text = |field: &str| payload.get(field).and_then(Value::as_str).filter(|v| !v.is_empty());
    if let Some(key) = matches!(
        request.type_.as_str(),
        "store_read" | "store_write" | "store_delete"
    )
    .then(|| text("key"))
    .flatten()
    {
        return Some(format!("store:{key}"));
    }
    // `add_project` carries the new project's id as `id`.
    if request.type_ == "add_project" {
        if let Some(id) = text("id") {
            return Some(format!("project:{id}"));
        }
    }
    [
        ("sessionId", "session"),
        ("terminalId", "terminal"),
        ("agentId", "agent"),
        ("projectId", "project"),
    ]
    .into_iter()
    .find_map(|(field, kind)| text(field).map(|id| format!("{kind}:{id}")))
}

struct Inner {
    /// Pending jobs per key. A key is present exactly while one drain task
    /// owns it, so a submit to a present key only appends.
    queues: HashMap<EntityKey, VecDeque<Job>>,
    tasks: JoinSet<()>,
    /// Jobs queued or running.
    inflight: usize,
}

/// Runs request jobs concurrently across entities and serially within one.
pub(in crate::web::ws) struct KeyedExecutor {
    inner: Arc<parking_lot::Mutex<Inner>>,
    /// Raised when a job panics: the connection can no longer be trusted to
    /// answer every request, so it is closed.
    fault: CancellationToken,
}

/// Why a job was not accepted.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::web::ws) struct Saturated;

impl KeyedExecutor {
    pub(in crate::web::ws) fn new(fault: CancellationToken) -> Self {
        Self {
            inner: Arc::new(parking_lot::Mutex::new(Inner {
                queues: HashMap::new(),
                tasks: JoinSet::new(),
                inflight: 0,
            })),
            fault,
        }
    }

    /// Queue `job` behind earlier jobs with the same `key` (or start it at
    /// once for `None`). Never blocks and never awaits the job.
    pub(in crate::web::ws) fn submit(
        &self,
        key: Option<EntityKey>,
        job: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), Saturated> {
        let job: Job = Box::pin(job);
        let mut inner = self.inner.lock();
        // Reap finished tasks so the set does not grow with the connection.
        while inner.tasks.try_join_next().is_some() {}
        if inner.inflight >= MAX_INFLIGHT_REQUESTS {
            return Err(Saturated);
        }
        inner.inflight += 1;
        let Some(key) = key else {
            let shared = Arc::clone(&self.inner);
            let fault = self.fault.clone();
            inner.tasks.spawn(async move {
                run_job(job, &fault).await;
                shared.lock().inflight -= 1;
            });
            return Ok(());
        };
        if let Some(queue) = inner.queues.get_mut(&key) {
            queue.push_back(job);
            return Ok(());
        }
        inner.queues.insert(key.clone(), VecDeque::new());
        let shared = Arc::clone(&self.inner);
        let fault = self.fault.clone();
        inner.tasks.spawn(async move {
            let mut job = job;
            loop {
                run_job(job, &fault).await;
                let mut inner = shared.lock();
                inner.inflight -= 1;
                match inner.queues.get_mut(&key).and_then(VecDeque::pop_front) {
                    Some(next) => job = next,
                    None => {
                        inner.queues.remove(&key);
                        return;
                    }
                }
            }
        });
        Ok(())
    }

    /// Jobs queued or running.
    #[cfg(test)]
    pub(in crate::web::ws) fn inflight(&self) -> usize {
        self.inner.lock().inflight
    }
}

/// Run one job, containing a panic: the queue keeps draining and the
/// connection is closed (a request whose handler panicked has no reply).
async fn run_job(job: Job, fault: &CancellationToken) {
    if AssertUnwindSafe(job).catch_unwind().await.is_err() {
        error!(
            target: "termul::web::ws",
            "request handler panicked; closing the connection"
        );
        fault.cancel();
    }
}

#[cfg(test)]
mod tests;
