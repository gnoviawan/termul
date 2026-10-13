//! The command receipt ledger (AD-5): an in-memory map from a client-minted
//! `commandId` to what the host did with it, shared by `/ws`, the HTTP routes
//! and the Tauri domain commands through [`crate::web::sink::WsRelaySink::ledger`].
//!
//! * A command is recorded as in progress BEFORE it executes ([`CommandLedger::begin`]).
//! * A same-id resend gets the original outcome class ([`Settled`]) and never
//!   re-executes; a request that differs from the original is a `command_conflict`.
//! * Outcomes are kept for the retention window, bare ids for a longer
//!   horizon; both stores are bounded. A resend that finds only a bare id (or
//!   whose guard was dropped without completing) is `Unknown`, never re-run.
//! * Nothing here holds a credential, request body, env value, token, claim,
//!   `authUrl` or prompt content: receipt-only kinds store no payload at all
//!   and fingerprints skip secret-bearing fields.
//!
//! The ledger is deliberately not durable: a host restart empties it, and the
//! entities stamped with their `commandId` answer a create resend instead.

mod admission;
mod class;
mod http;
pub mod terminal;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::watch;
use tracing::warn;

use crate::web::config::MAX_RECEIPT_RETENTION_SECS;

pub use admission::{
    lookup_created, run_command, run_command_released, run_command_with, Command, CommandResult, Ran,
};
pub use class::{class_of, ClassKind, CommandClass, Fingerprint, Replay, WS_COMMAND_CLASSES};
pub use http::{
    command_id_from_headers, domain_class, fingerprint_of, found_entity, no_entity, run_domain,
    run_domain_released, run_http, run_http_released, DomainRan, HttpRan,
    COMMAND_CONFLICT_CODE, COMMAND_ID_HEADER, INVALID_COMMAND_ID_CODE, IN_PROGRESS_RECEIPT,
    OUTCOME_UNKNOWN_CODE, PRECONDITION_FAILED_CODE, PRECONDITION_FAILED_PREFIX,
};

/// Longest accepted `commandId`, in bytes.
pub const MAX_COMMAND_ID_LEN: usize = 128;
/// Bare ids outlive outcomes by this factor.
pub const BARE_HORIZON_FACTOR: u32 = 6;
/// Outcomes kept at most; the oldest are downgraded to bare ids beyond this.
pub const DEFAULT_MAX_OUTCOMES: usize = 4096;
/// Bare ids kept at most; the oldest are forgotten beyond this.
pub const DEFAULT_MAX_BARE_IDS: usize = 65_536;
/// Longest a resend of an in-flight create/command waits for the first run
/// before answering `{receipt:"in_progress"}`.
pub const DEFAULT_IN_FLIGHT_WAIT: Duration = Duration::from_secs(25);
/// Reply payloads larger than this are not stored (a replay answers with the
/// plain `accepted` receipt).
pub const MAX_STORED_PAYLOAD_BYTES: usize = 32 * 1024;
/// Rejection messages are cut to this many characters before storing.
const MAX_STORED_MESSAGE_CHARS: usize = 512;
/// What a replayed rejection of a receipt-only kind says (its code is kept).
pub const RECEIPT_ONLY_REJECTION_MESSAGE: &str =
    "the command was rejected; its error text is not retained";

/// Whether `id` is a well-formed `commandId`: 1..=128 bytes of `[A-Za-z0-9_-]`.
#[must_use]
pub fn is_valid_command_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_COMMAND_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Time source for retention (injectable so tests never sleep).
pub trait LedgerClock: Send + Sync {
    /// Monotonic time since an arbitrary fixed origin.
    fn now(&self) -> Duration;
}

struct MonotonicClock(Instant);

impl LedgerClock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// A command's recorded outcome class: accepted, or the original rejection.
#[derive(Debug, Clone, PartialEq)]
pub enum Settled {
    Accepted {
        /// The reply payload (sanitized: `None` for receipt-only kinds).
        payload: Option<Value>,
        /// The session seq the effect is visible at (session-scoped commands).
        visible_at: Option<u64>,
    },
    Rejected {
        /// The stable error code of the original rejection.
        code: String,
        message: String,
    },
}

impl Settled {
    /// The copy the ledger stores: bounded and, for receipt-only classes,
    /// free of payload and error text.
    fn sanitized(&self, class: CommandClass) -> Self {
        match self {
            Self::Accepted { payload, visible_at } => Self::Accepted {
                payload: payload
                    .as_ref()
                    .filter(|_| class.stores_payload())
                    .filter(|value| {
                        serde_json::to_vec(value)
                            .is_ok_and(|bytes| bytes.len() <= MAX_STORED_PAYLOAD_BYTES)
                    })
                    .cloned(),
                visible_at: *visible_at,
            },
            Self::Rejected { code, message } => Self::Rejected {
                code: code.clone(),
                // A receipt-only kind's error text can echo agent- or
                // credential-derived content: keep the code, drop the text.
                message: if class.stores_payload() {
                    message.chars().take(MAX_STORED_MESSAGE_CHARS).collect()
                } else {
                    RECEIPT_ONLY_REJECTION_MESSAGE.to_string()
                },
            },
        }
    }
}

enum State {
    /// Executing. Replacing the state drops the sender, which wakes waiters.
    InProgress(watch::Sender<()>),
    Done(Settled),
    /// The guard was dropped without completing: the effect is unknown.
    Unknown,
    /// The outcome aged out; only the id (and its fingerprint) remain.
    Bare,
}

struct Entry {
    fingerprint: Fingerprint,
    state: State,
}

#[derive(Default)]
struct Store {
    entries: HashMap<String, Entry>,
    /// `(settled at, id)` of entries holding an outcome (`Done`/`Unknown`),
    /// oldest first.
    outcomes: VecDeque<(Duration, String)>,
    /// `(downgraded at, id)` of `Bare` entries, oldest first.
    bare: VecDeque<(Duration, String)>,
}

/// What [`CommandLedger::begin`] found for a `commandId`.
pub enum Begin {
    /// First sight: the caller executes and settles through the guard.
    Fresh(CommandGuard),
    /// Another run is in flight; wait on the receiver (it resolves when that
    /// run settles or its guard drops) and `begin` again.
    InFlight(watch::Receiver<()>),
    /// Settled earlier: answer with this outcome.
    Settled(Settled),
    /// The outcome is gone or was never recorded (evicted outcome, dropped
    /// guard): the command is not re-executed.
    Unknown,
    /// The id was used for a different request.
    Conflict,
}

/// The shared receipt ledger.
pub struct CommandLedger {
    store: Mutex<Store>,
    clock: Arc<dyn LedgerClock>,
    retention: Duration,
    max_outcomes: usize,
    max_bare: usize,
    in_flight_wait: Duration,
}

impl CommandLedger {
    /// A ledger keeping outcomes for `retention` (at most
    /// [`MAX_RECEIPT_RETENTION_SECS`]; bare ids six times as
    /// long) on the system monotonic clock.
    #[must_use]
    pub fn new(retention: Duration) -> Self {
        Self::with_clock(retention, Arc::new(MonotonicClock(Instant::now())))
    }

    #[must_use]
    pub fn with_clock(retention: Duration, clock: Arc<dyn LedgerClock>) -> Self {
        // `--receipt-retention-secs` is an unbounded u64: clamp it so the
        // bare-id horizon arithmetic can never overflow.
        let retention = retention.min(Duration::from_secs(MAX_RECEIPT_RETENTION_SECS));
        Self {
            store: Mutex::new(Store::default()),
            clock,
            retention,
            max_outcomes: DEFAULT_MAX_OUTCOMES,
            max_bare: DEFAULT_MAX_BARE_IDS,
            in_flight_wait: DEFAULT_IN_FLIGHT_WAIT,
        }
    }

    /// Replace the bounds (tests; production uses the defaults).
    #[must_use]
    pub fn with_limits(mut self, max_outcomes: usize, max_bare: usize) -> Self {
        self.max_outcomes = max_outcomes;
        self.max_bare = max_bare;
        self
    }

    /// Replace the in-flight resend wait (tests; production uses the default).
    #[must_use]
    pub fn with_in_flight_wait(mut self, wait: Duration) -> Self {
        self.in_flight_wait = wait;
        self
    }

    /// How long an outcome is kept.
    #[must_use]
    pub fn retention(&self) -> Duration {
        self.retention
    }

    /// How long a resend of an in-flight command waits before `in_progress`.
    #[must_use]
    pub fn in_flight_wait(&self) -> Duration {
        self.in_flight_wait
    }

    /// Record `id` as in progress, or report what is already known. Atomic: of
    /// two concurrent first sights exactly one gets [`Begin::Fresh`].
    #[must_use]
    pub fn begin(self: &Arc<Self>, id: &str, fingerprint: Fingerprint) -> Begin {
        let mut store = self.store.lock();
        self.age(&mut store);
        if let Some(entry) = store.entries.get(id) {
            if entry.fingerprint != fingerprint {
                return Begin::Conflict;
            }
            return match &entry.state {
                State::InProgress(sender) => Begin::InFlight(sender.subscribe()),
                State::Done(settled) => Begin::Settled(settled.clone()),
                State::Unknown | State::Bare => Begin::Unknown,
            };
        }
        let (sender, _) = watch::channel(());
        store.entries.insert(
            id.to_string(),
            Entry {
                fingerprint,
                state: State::InProgress(sender),
            },
        );
        Begin::Fresh(CommandGuard {
            ledger: Arc::clone(self),
            id: id.to_string(),
            settled: false,
        })
    }

    /// Entries held, by state: `(in progress, outcomes, bare ids)`.
    #[must_use]
    pub fn counts(&self) -> (usize, usize, usize) {
        let store = self.store.lock();
        let bare = store.bare.len();
        let outcomes = store.outcomes.len();
        (store.entries.len() - bare - outcomes, outcomes, bare)
    }

    /// Resends currently waiting on the in-flight run of `id` (tests only:
    /// lets a test release the first run once the waiter is really parked).
    #[cfg(test)]
    pub(crate) fn waiting_resends(&self, id: &str) -> usize {
        match self.store.lock().entries.get(id).map(|entry| &entry.state) {
            Some(State::InProgress(sender)) => sender.receiver_count(),
            _ => 0,
        }
    }

    /// Remove an entry that is still in progress (dropping its sender wakes
    /// waiters).
    fn forget_in_progress(&self, id: &str) {
        let mut store = self.store.lock();
        if store
            .entries
            .get(id)
            .is_some_and(|entry| matches!(entry.state, State::InProgress(_)))
        {
            store.entries.remove(id);
        }
    }

    fn settle(&self, id: &str, state: State) {
        let mut store = self.store.lock();
        let Some(entry) = store.entries.get_mut(id) else {
            return;
        };
        if !matches!(entry.state, State::InProgress(_)) {
            return;
        }
        // Dropping the old state drops its sender, waking every waiter.
        entry.state = state;
        let now = self.clock.now();
        store.outcomes.push_back((now, id.to_string()));
        self.age(&mut store);
    }

    /// Move aged-out outcomes to bare ids, forget aged-out bare ids and apply
    /// the capacity bounds.
    fn age(&self, store: &mut Store) {
        let now = self.clock.now();
        // How long a bare id outlives its outcome (retention is clamped at
        // construction, so this cannot overflow).
        let bare_ttl = self.retention * (BARE_HORIZON_FACTOR - 1);
        while let Some((at, _)) = store.outcomes.front() {
            if now.saturating_sub(*at) < self.retention {
                break;
            }
            self.downgrade_oldest(store, now);
        }
        while store.outcomes.len() > self.max_outcomes {
            self.downgrade_oldest(store, now);
        }
        while let Some((at, _)) = store.bare.front() {
            if now.saturating_sub(*at) < bare_ttl {
                break;
            }
            Self::forget_oldest_bare(store);
        }
        while store.bare.len() > self.max_bare {
            Self::forget_oldest_bare(store);
        }
    }

    fn downgrade_oldest(&self, store: &mut Store, now: Duration) {
        if let Some((_, id)) = store.outcomes.pop_front() {
            if let Some(entry) = store.entries.get_mut(&id) {
                entry.state = State::Bare;
                store.bare.push_back((now, id));
            }
        }
    }

    fn forget_oldest_bare(store: &mut Store) {
        if let Some((_, id)) = store.bare.pop_front() {
            store.entries.remove(&id);
        }
    }
}

/// Proof that the holder is the one run of a command. Settle it with
/// [`CommandGuard::complete`]; a guard dropped without completing (panic,
/// cancelled handler, host shutdown) records `Unknown`, so a resend is never
/// re-executed.
pub struct CommandGuard {
    ledger: Arc<CommandLedger>,
    id: String,
    settled: bool,
}

impl CommandGuard {
    /// Record the outcome (sanitized for `class`) and wake waiting resends.
    pub fn complete(mut self, settled: &Settled, class: CommandClass) {
        self.settled = true;
        self.ledger
            .settle(&self.id, State::Done(settled.sanitized(class)));
    }

    /// Give the id back instead of recording an outcome: the command had no
    /// effect (a spawn that failed before any PTY existed), so a same-id
    /// resend is free to execute again. Waiting resends wake and `begin`
    /// anew; exactly one of them becomes the next run.
    pub fn release(mut self) {
        self.settled = true;
        self.ledger.forget_in_progress(&self.id);
    }
}

impl Drop for CommandGuard {
    fn drop(&mut self) {
        if !self.settled {
            warn!(
                target: "termul::web::command_ledger",
                "command guard dropped without an outcome; recording unknown"
            );
            self.ledger.settle(&self.id, State::Unknown);
        }
    }
}

#[cfg(test)]
mod class_tests;
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod terminal_tests;
#[cfg(test)]
pub(crate) mod test_clock;
#[cfg(test)]
mod tests;
