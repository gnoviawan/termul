//! Read-through caches of per-session values folded from the log
//! (`last_commands`, `last_controls`), and the guard that stops a scan of a
//! log that has since been rewritten from seeding one.
//!
//! The writer updates an entry in place as it writes each append, so an
//! entry follows the durable order of the log. The first payload read of a
//! session the cache lacks scans the log on the blocking pool, without a
//! lock, and merges the result. A seq-intruder salvage rewrites the log and
//! a delete removes it; both forget the session, but a scan that read the
//! old log can still finish afterwards. So every forget bumps the session's
//! generation, a scan carries the generation it started at, and a seed from
//! an older one is rejected: the read scans again, against the current log.
//! Generations are per session, so a forget never rejects another
//! session's scan. A read that keeps losing to rewrites scans one last time
//! under the session's catalog entry lock, which a salvage holds across its
//! rewrite and forget.

use std::collections::hash_map::Entry;

use super::*;

/// Lock-free scans a read tries before it scans under the session lock.
const UNLOCKED_SCAN_ATTEMPTS: usize = 3;

/// A per-session value folded from the log.
pub(super) trait LogDerived: Default + Send + 'static {
    /// The cache name in logs.
    const NAME: &'static str;
    /// What one log scan yields.
    type Scan: Send + 'static;
    /// What a payload read returns.
    type Value: Send + 'static;

    /// The store's cache of this value.
    fn cache(inner: &Inner) -> &SessionCache<Self>;
    /// Scan the log at `path` for `session_id`.
    fn scan(path: &Path, session_id: &str) -> io::Result<Self::Scan>;
    /// The value, when the entry already reflects the log.
    fn known(&self) -> Option<Self::Value>;
    /// Merge a scan of the log into the session's entry, keeping anything
    /// newer an append already put there.
    fn seed(entry: Entry<'_, String, Self>, scanned: Self::Scan) -> Self::Value;
}

/// The session generation a scan started at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ScanTicket(u64);

pub(super) struct SessionCache<V> {
    state: Mutex<CacheState<V>>,
}

struct CacheState<V> {
    entries: HashMap<String, V>,
    /// Bumped by each forget of the session. A generation outlives its
    /// entry, so a scan started before the forget stays rejected; the map
    /// keeps one integer per session forgotten in this process.
    generations: HashMap<String, u64>,
}

impl<V> CacheState<V> {
    fn ticket(&self, session_id: &str) -> ScanTicket {
        ScanTicket(self.generations.get(session_id).copied().unwrap_or(0))
    }
}

impl<V> Default for SessionCache<V> {
    fn default() -> Self {
        Self {
            state: Mutex::new(CacheState {
                entries: HashMap::new(),
                generations: HashMap::new(),
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
            .ok_or_else(|| state.ticket(session_id))
    }

    /// Merge a scan into the session's entry. `None`: a forget of the
    /// session ran since the scan started, so it may have read a log that no
    /// longer exists.
    pub(super) fn seed(
        &self,
        session_id: &str,
        ticket: ScanTicket,
        scanned: V::Scan,
    ) -> Option<V::Value> {
        let mut state = self.state.lock();
        if ticket != state.ticket(session_id) {
            return None;
        }
        Some(V::seed(
            state.entries.entry(session_id.to_string()),
            scanned,
        ))
    }

    /// Drop the session's entry and reject its scans already in flight.
    pub(super) fn forget(&self, session_id: &str) {
        let mut state = self.state.lock();
        *state.generations.entry(session_id.to_string()).or_default() += 1;
        state.entries.remove(session_id);
    }
}

/// What one appended record changes in the log-derived caches.
pub(super) struct AppendedLogDerived {
    session_id: String,
    commands: Option<Option<CommandList>>,
    controls: ControlsFold,
}

impl AppendedLogDerived {
    /// `None` when the record changes neither cache.
    pub(super) fn of(record: &PersistedEventRecord) -> Option<Self> {
        let commands = (record.type_ == "commands_update").then(|| CommandList::of_record(record));
        let controls = ControlsFold::of_records([record]);
        (commands.is_some() || controls != ControlsFold::default()).then(|| Self {
            session_id: record.session_id.clone(),
            commands,
            controls,
        })
    }

    /// Called by the writer once the record is on disk, never before: a
    /// salvage that runs between the enqueue and the write forgets the
    /// session, and a scan after that forget reads a log without the record.
    /// Applied after the write, the record always lands on top of that scan.
    pub(super) fn apply(self, inner: &Inner) {
        inner.last_controls.note(&self.session_id, self.controls);
        if let Some(commands) = self.commands {
            inner
                .last_commands
                .update(&self.session_id, |entry| *entry = commands);
        }
    }
}

impl SessionPersistence {
    /// The session's cached value, scanning the log on the blocking pool on
    /// a miss. A scan a forget overtook is rescanned.
    pub(super) async fn read_through<V: LogDerived>(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<V::Value> {
        let cache = V::cache(&self.inner);
        for attempt in 1..=UNLOCKED_SCAN_ATTEMPTS {
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
                    hook();
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
            "[acp-history] {} scan kept losing to log rewrites; scanning under the session \
             lock session_id={} attempts={}",
            V::NAME,
            crate::logging::redact_session_id(session_id),
            UNLOCKED_SCAN_ATTEMPTS
        );
        self.read_through_locked::<V>(session_id).await
    }

    /// The last resort of [`Self::read_through`]: scan and seed under the
    /// session's catalog entry lock. A salvage rewrites the log and forgets
    /// the session while holding that lock, so it cannot overtake this scan.
    /// Only `delete_session` forgets without it, and then the session is
    /// gone. The scan holds up the session's writer and `persist_index`, which
    /// is why it is not the first resort.
    async fn read_through_locked<V: LogDerived>(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<V::Value> {
        let entry = self
            .inner
            .catalog
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)?;
        let persistence = Arc::clone(self);
        let id = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            let metadata = entry.lock();
            let cache = V::cache(&persistence.inner);
            let ticket = match cache.lookup(&id) {
                Ok(known) => return Ok(known),
                Err(ticket) => ticket,
            };
            let path = persistence
                .session_dir(&metadata.storage_key)?
                .join(MESSAGES_FILE);
            let scanned = V::scan(&path, &id)?;
            cache.seed(&id, ticket, scanned).ok_or_else(|| {
                log::warn!(
                    "[acp-history] {} locked scan overtaken by a delete session_id={}",
                    V::NAME,
                    crate::logging::redact_session_id(&id)
                );
                SessionPersistenceError::SessionNotFound
            })
        })
        .await
        .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))?
    }

    /// Forget every cached value folded from the session's log, after the
    /// log was rewritten or removed.
    pub(super) fn forget_log_derived(&self, session_id: &str) {
        self.inner.last_commands.forget(session_id);
        self.inner.last_controls.forget(session_id);
    }

    /// Test seam: every lock-free read-through scan pauses after reading the
    /// log and before seeding, until the hook is released. The locked last
    /// resort never runs the hook.
    #[cfg(test)]
    pub(crate) fn set_cache_scan_test_hook(&self, hook: Arc<ReplayTestHook>) {
        self.set_cache_scan_test_callback(Arc::new(move || hook.wait()));
    }

    /// Test seam: `callback` runs after every lock-free read-through scan,
    /// before it seeds.
    #[cfg(test)]
    pub(crate) fn set_cache_scan_test_callback(&self, callback: CacheScanTestCallback) {
        *self.cache_scan_hook.lock() = Some(callback);
    }
}

#[cfg(test)]
pub(crate) type CacheScanTestCallback = Arc<dyn Fn() + Send + Sync>;

/// `last_commands` entries: an entry present is the newest list (`None`:
/// the log holds none). Writes replace it in log order; a seed never
/// replaces one, so a scan racing an append cannot restore the older list.
impl LogDerived for Option<CommandList> {
    const NAME: &'static str = "last_commands";
    type Scan = Option<CommandList>;
    type Value = Option<CommandList>;

    fn cache(inner: &Inner) -> &SessionCache<Self> {
        &inner.last_commands
    }

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
