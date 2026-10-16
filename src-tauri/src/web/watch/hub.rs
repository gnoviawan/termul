//! The watch hub: per-(watch, scope, connection) subscriptions with a
//! contiguous revision counter.
//!
//! A subscription starts with one full-state frame (`reset`, revision
//! `n = 1`); every later publish sends a delta whose `n` is the previous one
//! plus one. The client applies a delta only when it is `last + 1` and the
//! `hostEpoch` is the one it started with; any other revision means it missed
//! a frame, and it resubscribes for fresh state.
//!
//! Subscribers are keyed by the connection's outbound queue
//! ([`OutboundSender::same_channel`]), never by its session subscriptions, so
//! a socket with no session subscribed receives every watch exactly once.
//!
//! Frames go through the connection's bounded queue without waiting
//! (`try_enqueue`). A delta that finds the queue full is dropped but still
//! consumes its `n`, which leaves the hole the client detects. When no later
//! delta would expose the hole, a resync marker takes the next `n` and is
//! queued by a task that waits for room (a peer that never makes room is
//! closed by the queue's own overflow tolerance). A marker belongs to the
//! subscription that dropped the delta: replacing or releasing that
//! subscription cancels it, so it never lands behind a fresh state frame.
//!
//! Lock order: the hub lock is taken before the locks the state closures take
//! (agent registry, project registry, session catalog), and none of those is
//! held while a publisher calls into the hub.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::web::ws::{EnqueueOutcome, Outbound, OutboundSender};

/// Top-level frame type of every watch frame: `{"type":"watch", ...}`.
pub const WS_WATCH_TYPE: &str = "watch";

/// Longest scope (project id or store key) a watch accepts; the same bound the
/// store applies to its keys.
const MAX_SCOPE_BYTES: usize = 1024;

/// What a watch observes. The scope of a watch narrows it (`""` for the
/// host-wide watches, a project id, or a store key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WatchKind {
    /// The project list plus the host default project.
    Projects,
    /// The persisted chat-history index.
    ChatHistory,
    /// The live agent roster.
    Agents,
    /// The file changes below one project's root (scope = project id).
    Fs,
    /// One shared store key (scope = the key).
    Store,
    /// The terminals of one project (scope = project id).
    Terminals,
    /// The shared last-read marker of every agent chat.
    ChatReads,
}

impl WatchKind {
    /// The wire name of this watch.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Projects => "projects",
            Self::ChatHistory => "chat_history",
            Self::Agents => "agents",
            Self::Fs => "fs",
            Self::Store => "store",
            Self::Terminals => "terminals",
            Self::ChatReads => "chat_reads",
        }
    }

    /// Parse a wire name; `None` for an unknown watch.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "projects" => Some(Self::Projects),
            "chat_history" => Some(Self::ChatHistory),
            "agents" => Some(Self::Agents),
            "fs" => Some(Self::Fs),
            "store" => Some(Self::Store),
            "terminals" => Some(Self::Terminals),
            "chat_reads" => Some(Self::ChatReads),
            _ => None,
        }
    }

    /// Whether `scope` is a scope this watch accepts. The host-wide watches
    /// have exactly one, the empty scope; the scoped watches need a non-blank
    /// scope of a bounded length.
    #[must_use]
    pub fn accepts_scope(self, scope: &str) -> bool {
        match self {
            Self::Projects | Self::ChatHistory | Self::Agents | Self::ChatReads => scope.is_empty(),
            Self::Fs | Self::Store | Self::Terminals => {
                !scope.trim().is_empty() && scope.len() <= MAX_SCOPE_BYTES
            }
        }
    }
}

/// `(hostEpoch, n)`: which serve start produced a frame, and its position in
/// the subscription's stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRevision {
    pub host_epoch: String,
    pub n: u64,
}

/// One `{"type":"watch", ...}` frame. Exactly one of `state` (with
/// `reset: true`) and `delta` is set.
#[derive(Debug, Clone, Serialize)]
pub struct WatchFrame {
    #[serde(rename = "type")]
    type_: &'static str,
    watch: &'static str,
    scope: String,
    revision: WatchRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<Value>,
}

impl WatchFrame {
    fn state(kind: WatchKind, scope: &str, revision: WatchRevision, state: Value) -> Self {
        Self {
            type_: WS_WATCH_TYPE,
            watch: kind.as_str(),
            scope: scope.to_string(),
            revision,
            reset: Some(true),
            state: Some(state),
            delta: None,
        }
    }

    fn delta(kind: WatchKind, scope: &str, revision: WatchRevision, delta: Value) -> Self {
        Self {
            type_: WS_WATCH_TYPE,
            watch: kind.as_str(),
            scope: scope.to_string(),
            revision,
            reset: None,
            state: None,
            delta: Some(delta),
        }
    }

    /// The revision this frame carries.
    #[must_use]
    pub fn revision(&self) -> &WatchRevision {
        &self.revision
    }

    /// The full state of a `reset` frame.
    #[must_use]
    pub fn state_value(&self) -> Option<&Value> {
        self.state.as_ref()
    }

    /// The delta of a delta frame.
    #[must_use]
    pub fn delta_value(&self) -> Option<&Value> {
        self.delta.as_ref()
    }
}

/// Why a subscription was not registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeError {
    /// The connection queue had no room for the full-state frame.
    QueueFull,
    /// The connection is closing.
    Closed,
}

struct Subscriber {
    out: OutboundSender,
    /// The `n` of the last frame assigned to this subscriber, delivered or not.
    n: u64,
    /// A resync marker is waiting for room in the queue.
    resync_pending: Arc<AtomicBool>,
    /// Cancelled when this subscription is replaced or released: ends a
    /// pending resync marker.
    retired: CancellationToken,
    /// The runtime of the task that registered the subscription: publishers
    /// run on driver threads that may have none.
    runtime: tokio::runtime::Handle,
}

struct HubInner {
    host_epoch: String,
    subscribers: HashMap<(WatchKind, String), Vec<Subscriber>>,
}

/// Subscriptions of every connection of one host. One lock covers the state
/// read, the subscriber registration and the delta fan-out, so a subscriber
/// sees a state and then every later delta, in order, with no gap between.
pub struct WatchHub {
    inner: Mutex<HubInner>,
}

impl Default for WatchHub {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchHub {
    /// A hub with a fresh random host epoch.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HubInner {
                host_epoch: Uuid::new_v4().to_string(),
                subscribers: HashMap::new(),
            }),
        }
    }

    /// The current host epoch.
    #[must_use]
    pub fn host_epoch(&self) -> String {
        self.inner.lock().host_epoch.clone()
    }

    /// Start a new host epoch (a serve start). The next frame of an existing
    /// subscription carries the new epoch, and the client resubscribes on the
    /// change.
    pub fn renew_epoch(&self) -> String {
        let mut inner = self.inner.lock();
        inner.host_epoch = Uuid::new_v4().to_string();
        inner.host_epoch.clone()
    }

    /// Subscribe `out` to `(kind, scope)`: read the state, queue the
    /// full-state frame (`n = 1`) and register the subscriber. A second
    /// subscribe from the same connection replaces the first and restarts at
    /// `n = 1`. `state` runs under the hub lock, so it must be short and must
    /// not call back into the hub.
    ///
    /// # Errors
    /// [`SubscribeError`] when the frame cannot be queued; nothing is
    /// registered then, and an earlier subscription of the connection is
    /// released too (the client asks again).
    pub(crate) fn subscribe(
        &self,
        kind: WatchKind,
        scope: &str,
        out: &OutboundSender,
        state: impl FnOnce() -> Value,
    ) -> Result<WatchRevision, SubscribeError> {
        // Subscriptions are made by request handlers, which run on a runtime;
        // without one no resync marker could ever be queued.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return Err(SubscribeError::Closed);
        };
        let mut inner = self.inner.lock();
        let revision = WatchRevision {
            host_epoch: inner.host_epoch.clone(),
            n: 1,
        };
        let frame = WatchFrame::state(kind, scope, revision.clone(), state());
        let key = (kind, scope.to_string());
        // The replaced subscription (if any) is released first: its pending
        // resync marker is cancelled before the fresh state frame is queued, so
        // the marker cannot land behind it.
        if let Some(list) = inner.subscribers.get_mut(&key) {
            retain_not_on(list, out);
        }
        match out.try_enqueue(Outbound::Watch(frame)) {
            EnqueueOutcome::Enqueued => {}
            EnqueueOutcome::Full => {
                warn!(
                    target: "termul::web::watch",
                    watch = kind.as_str(),
                    "watch subscribe refused: connection queue full"
                );
                drop_empty(&mut inner, &key);
                return Err(SubscribeError::QueueFull);
            }
            EnqueueOutcome::Closed => {
                drop_empty(&mut inner, &key);
                return Err(SubscribeError::Closed);
            }
        }
        let list = inner.subscribers.entry(key).or_default();
        list.push(Subscriber {
            out: out.clone(),
            n: 1,
            resync_pending: Arc::new(AtomicBool::new(false)),
            retired: CancellationToken::new(),
            runtime,
        });
        info!(
            target: "termul::web::watch",
            watch = kind.as_str(),
            subscribers = list.len(),
            "watch subscribed"
        );
        Ok(revision)
    }

    /// Release this connection's subscription; `true` when it had one.
    pub(crate) fn unsubscribe(&self, kind: WatchKind, scope: &str, out: &OutboundSender) -> bool {
        let mut inner = self.inner.lock();
        let key = (kind, scope.to_string());
        let Some(list) = inner.subscribers.get_mut(&key) else {
            return false;
        };
        let before = list.len();
        retain_not_on(list, out);
        let removed = list.len() != before;
        if list.is_empty() {
            inner.subscribers.remove(&key);
        }
        removed
    }

    /// Release every subscription of a closed connection.
    pub(crate) fn unsubscribe_all(&self, out: &OutboundSender) {
        let mut inner = self.inner.lock();
        inner.subscribers.retain(|_, list| {
            retain_not_on(list, out);
            !list.is_empty()
        });
    }

    /// Number of connections subscribed to `(kind, scope)`.
    #[must_use]
    pub fn subscriber_count(&self, kind: WatchKind, scope: &str) -> usize {
        self.inner
            .lock()
            .subscribers
            .get(&(kind, scope.to_string()))
            .map_or(0, Vec::len)
    }

    /// Send a delta to every subscriber of `(kind, scope)`, each with its own
    /// next `n`. `delta` runs once, under the hub lock, and only when someone
    /// is subscribed; a source that must read shared state builds its delta
    /// there so deltas follow the order of the publishes.
    pub fn publish(&self, kind: WatchKind, scope: &str, delta: impl FnOnce() -> Value) {
        let mut inner = self.inner.lock();
        let host_epoch = inner.host_epoch.clone();
        let key = (kind, scope.to_string());
        let Some(list) = inner.subscribers.get_mut(&key) else {
            return;
        };
        if list.is_empty() {
            return;
        }
        let delta = delta();
        list.retain_mut(|subscriber| {
            subscriber.n += 1;
            let revision = WatchRevision {
                host_epoch: host_epoch.clone(),
                n: subscriber.n,
            };
            let frame = WatchFrame::delta(kind, scope, revision, delta.clone());
            match subscriber.out.try_enqueue(Outbound::Watch(frame)) {
                EnqueueOutcome::Enqueued => true,
                EnqueueOutcome::Closed => {
                    subscriber.retired.cancel();
                    debug!(
                        target: "termul::web::watch",
                        watch = kind.as_str(),
                        "dropping a subscriber whose connection is closing"
                    );
                    false
                }
                EnqueueOutcome::Full => {
                    schedule_resync(kind, scope, &host_epoch, subscriber);
                    true
                }
            }
        });
        if list.is_empty() {
            inner.subscribers.remove(&key);
        }
    }
}

impl WatchHub {
    /// End every subscription of `(kind, scope)`: each subscriber gets `delta`
    /// as its last frame (it waits for room in a full queue, so the notice is
    /// delayed, never lost), and the subscription is released. The client
    /// asks again for the watch when it wants it back.
    pub fn end(&self, kind: WatchKind, scope: &str, delta: &Value) {
        let mut inner = self.inner.lock();
        let host_epoch = inner.host_epoch.clone();
        let Some(list) = inner.subscribers.remove(&(kind, scope.to_string())) else {
            return;
        };
        for mut subscriber in list {
            subscriber.retired.cancel();
            subscriber.n += 1;
            let revision = WatchRevision {
                host_epoch: host_epoch.clone(),
                n: subscriber.n,
            };
            let frame = || Outbound::Watch(WatchFrame::delta(kind, scope, revision.clone(), delta.clone()));
            if subscriber.out.try_enqueue(frame()) == EnqueueOutcome::Full {
                let out = subscriber.out.clone();
                let frame = frame();
                subscriber.runtime.spawn(async move {
                    out.enqueue(frame).await;
                });
            }
        }
        info!(
            target: "termul::web::watch",
            watch = kind.as_str(),
            "watch ended by the host"
        );
    }
}

/// The delta could not be queued: its `n` is a hole. Queue a resync marker
/// under the next `n` so the hole shows even if no later delta comes; the
/// marker waits for room (the queue's overflow tolerance closes a peer that
/// never makes any).
fn schedule_resync(kind: WatchKind, scope: &str, host_epoch: &str, subscriber: &mut Subscriber) {
    warn!(
        target: "termul::web::watch",
        watch = kind.as_str(),
        "watch delta dropped: connection queue full; the client resubscribes on the revision gap"
    );
    if subscriber.resync_pending.swap(true, Ordering::AcqRel) {
        return;
    }
    subscriber.n += 1;
    let frame = WatchFrame::delta(
        kind,
        scope,
        WatchRevision {
            host_epoch: host_epoch.to_string(),
            n: subscriber.n,
        },
        json!({ "resync": true }),
    );
    let out = subscriber.out.clone();
    let pending = Arc::clone(&subscriber.resync_pending);
    let retired = subscriber.retired.clone();
    subscriber.runtime.spawn(async move {
        tokio::select! {
            biased;
            () = retired.cancelled() => {}
            _ = out.enqueue(Outbound::Watch(frame)) => {}
        }
        pending.store(false, Ordering::Release);
    });
}

/// Remove the `key` entry when no subscriber is left on it.
fn drop_empty(inner: &mut HubInner, key: &(WatchKind, String)) {
    if inner.subscribers.get(key).is_some_and(Vec::is_empty) {
        inner.subscribers.remove(key);
    }
}

/// Drop `out`'s subscription from `list`, ending its pending resync marker.
fn retain_not_on(list: &mut Vec<Subscriber>, out: &OutboundSender) {
    list.retain(|existing| {
        let same = existing.out.same_channel(out);
        if same {
            existing.retired.cancel();
        }
        !same
    });
}
