//! Read-through caches of per-session values folded from the log
//! (`last_commands`, `last_controls`), and the guard that stops a scan of a
//! log that has since been rewritten from seeding one.
//!
//! Appends of this process update an entry in place. The first payload read
//! of a session the cache lacks scans the log on the blocking pool, without
//! a lock, and merges the result. A seq-intruder salvage rewrites the log and
//! a delete removes it; both forget the session, but a scan that read the old
//! log can still finish afterwards. So every forget bumps the cache epoch, a
//! scan carries the epoch it started at, and a seed from an older epoch is
//! rejected: the read scans again, against the current log. The epoch is
//! cache-wide, so a forget also makes unrelated in-flight scans rescan once;
//! in exchange no per-session state outlives its entry.

use std::collections::hash_map::Entry;

use super::*;

/// A read that keeps losing its seed to concurrent forgets gives up after
/// this many scans rather than spin.
const MAX_SCAN_ATTEMPTS: usize = 4;

/// A per-session value folded from the log.
pub(super) trait LogDerived: Default + Send + 'static {
    /// The cache name in logs.
    const NAME: &'static str;
    /// What one log scan yields.
    type Scan: Send + 'static;
    /// What a payload read returns.
    type Value;

    /// Scan the log at `path` for `session_id`.
    fn scan(path: &Path, session_id: &str) -> io::Result<Self::Scan>;
    /// The value, when the entry already reflects the log.
    fn known(&self) -> Option<Self::Value>;
    /// Merge a scan of the log into the session's entry, keeping anything
    /// newer an append already put there.
    fn seed(entry: Entry<'_, String, Self>, scanned: Self::Scan) -> Self::Value;
}

/// The cache epoch a scan started at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ScanTicket(u64);

pub(super) struct SessionCache<V> {
    state: Mutex<CacheState<V>>,
}

struct CacheState<V> {
    entries: HashMap<String, V>,
    /// Bumped by every forget.
    epoch: u64,
}

impl<V> Default for SessionCache<V> {
    fn default() -> Self {
        Self {
            state: Mutex::new(CacheState {
                entries: HashMap::new(),
                epoch: 0,
            }),
        }
    }
}

impl<V: LogDerived> SessionCache<V> {
    /// Apply an append to the session's entry, creating it if missing.
    pub(super) fn update(&self, session_id: &str, apply: impl FnOnce(&mut V)) {
        apply(
            self.state
                .lock()
                .entries
                .entry(session_id.to_string())
                .or_default(),
        );
    }

    /// The session's value, or the ticket a scan for it must seed with.
    pub(super) fn lookup(&self, session_id: &str) -> std::result::Result<V::Value, ScanTicket> {
        let state = self.state.lock();
        state
            .entries
            .get(session_id)
            .and_then(V::known)
            .ok_or(ScanTicket(state.epoch))
    }

    /// Merge a scan into the session's entry. `None`: a forget ran since the
    /// scan started, so it may have read a log that no longer exists.
    pub(super) fn seed(
        &self,
        session_id: &str,
        ticket: ScanTicket,
        scanned: V::Scan,
    ) -> Option<V::Value> {
        let mut state = self.state.lock();
        if ticket != ScanTicket(state.epoch) {
            return None;
        }
        Some(V::seed(
            state.entries.entry(session_id.to_string()),
            scanned,
        ))
    }

    /// Drop the session's entry and reject every scan already in flight.
    pub(super) fn forget(&self, session_id: &str) {
        let mut state = self.state.lock();
        state.epoch += 1;
        state.entries.remove(session_id);
    }
}

impl SessionPersistence {
    /// The session's cached value, scanning the log on the blocking pool on
    /// a miss. A scan a forget overtook is rescanned.
    pub(super) async fn read_through<V: LogDerived>(
        self: &Arc<Self>,
        cache: &SessionCache<V>,
        session_id: &str,
    ) -> Result<V::Value> {
        for attempt in 1..=MAX_SCAN_ATTEMPTS {
            let ticket = match cache.lookup(session_id) {
                Ok(known) => return Ok(known),
                Err(ticket) => ticket,
            };
            let metadata = self.metadata(session_id)?;
            let path = self.session_dir(&metadata.storage_key)?.join(MESSAGES_FILE);
            let id = session_id.to_string();
            #[cfg(test)]
            let hook = self.cache_scan_hook.lock().clone();
            let scanned = tokio::task::spawn_blocking(move || {
                let scanned = V::scan(&path, &id);
                #[cfg(test)]
                if let Some(hook) = hook {
                    hook.wait();
                }
                scanned
            })
            .await
            .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))??;
            if let Some(value) = cache.seed(session_id, ticket, scanned) {
                return Ok(value);
            }
            log::info!(
                "[acp-history] {} scan overtaken by a log rewrite; rescanning session_id={} \
                 attempt={attempt}",
                V::NAME,
                crate::logging::redact_session_id(session_id)
            );
        }
        log::warn!(
            "[acp-history] {} scan kept losing to log rewrites session_id={} attempts={}",
            V::NAME,
            crate::logging::redact_session_id(session_id),
            MAX_SCAN_ATTEMPTS
        );
        Err(SessionPersistenceError::PersistenceUnhealthy(format!(
            "{} scan kept losing to log rewrites",
            V::NAME
        )))
    }

    /// Forget every cached value folded from the session's log, after the
    /// log was rewritten or removed.
    pub(super) fn forget_log_derived(&self, session_id: &str) {
        self.inner.last_commands.forget(session_id);
        self.inner.last_controls.forget(session_id);
    }

    /// Test seam: every read-through scan pauses after reading the log and
    /// before seeding, until the hook is released.
    #[cfg(test)]
    pub(crate) fn set_cache_scan_test_hook(&self, hook: Arc<ReplayTestHook>) {
        *self.cache_scan_hook.lock() = Some(hook);
    }
}

/// `last_commands` entries: an entry present is the newest list (`None`:
/// the log holds none). Appends replace it in append order; a seed never
/// replaces one, so a scan racing an append cannot restore the older list.
impl LogDerived for Option<CommandList> {
    const NAME: &'static str = "last_commands";
    type Scan = Option<CommandList>;
    type Value = Option<CommandList>;

    fn scan(path: &Path, session_id: &str) -> io::Result<Self::Scan> {
        newest_command_list(path, session_id)
    }

    fn known(&self) -> Option<Self::Value> {
        Some(self.clone())
    }

    fn seed(entry: Entry<'_, String, Self>, scanned: Self::Scan) -> Self::Value {
        entry.or_insert(scanned).clone()
    }
}

#[cfg(test)]
#[path = "session_cache_tests.rs"]
mod tests;
