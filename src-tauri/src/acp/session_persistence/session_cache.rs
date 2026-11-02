//! Read-through caches of per-session values folded from the log
//! (`last_commands`, `last_controls`), and the guard that stops a scan of a
//! log that has since been rewritten from seeding one.
//!
//! The writer updates an entry in place as it writes each append, so an
//! entry follows the durable order of the log. The first payload read of a
//! session the cache lacks scans the log on the blocking pool, without a
//! lock, and merges the result. A seq-intruder salvage rewrites the log and
//! forgets the session, but a scan that read the old log can still finish
//! afterwards. So every forget bumps the session's
//! generation, a scan carries the generation it started at, and a seed from
//! an older one is rejected: the read scans again, against the current log.
//! Generations are per session, so a forget never rejects another
//! session's scan. A read that keeps losing to rewrites scans one last time
//! under the session's catalog entry lock, which a salvage holds across its
//! rewrite and forget.
//!
//! Entries also belong to one registration of a session id: a delete
//! removes the log, and the id can be registered again with a new one. Each
//! cache mirrors which catalog entry the id is registered under, updated
//! under the catalog lock by every catalog insert and remove, which also
//! drop the id's entry. A seed or an append names the catalog entry it read
//! or wrote through and lands only while that entry is still the registered
//! one, so a scan of a deleted (or replaced) session's log can never seed
//! values a new registration of the id would read, however its ticket was
//! taken.

use std::collections::hash_map::Entry;
use std::sync::Weak;

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

    /// The value a scan alone yields, for a read whose scan may not seed.
    fn unseeded(scanned: Self::Scan) -> Self::Value {
        let mut scratch = HashMap::new();
        Self::seed(scratch.entry(String::new()), scanned)
    }
}

/// A session's catalog entry. Its identity (the allocation, not the value)
/// is the registration a cache entry belongs to.
pub(super) type CatalogEntry = Arc<Mutex<SessionMetadata>>;

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
    /// The catalog entry each session id is registered under, kept in step
    /// with the catalog under its lock. Weak: the catalog owns the entries,
    /// and a weak reference keeps its allocation, so no other entry can
    /// reuse the address it compares by.
    registered: HashMap<String, Weak<Mutex<SessionMetadata>>>,
}

impl<V> CacheState<V> {
    fn ticket(&self, session_id: &str) -> ScanTicket {
        ScanTicket(self.generations.get(session_id).copied().unwrap_or(0))
    }

    /// `entry` is the catalog entry `session_id` is registered under.
    fn is_registered(&self, session_id: &str, entry: &CatalogEntry) -> bool {
        self.registered
            .get(session_id)
            .is_some_and(|current| std::ptr::eq(current.as_ptr(), Arc::as_ptr(entry)))
    }

    fn forget(&mut self, session_id: &str) {
        *self.generations.entry(session_id.to_string()).or_default() += 1;
        self.entries.remove(session_id);
    }
}

impl<V> Default for SessionCache<V> {
    fn default() -> Self {
        Self {
            state: Mutex::new(CacheState {
                entries: HashMap::new(),
                generations: HashMap::new(),
                registered: HashMap::new(),
            }),
        }
    }
}

impl<V: LogDerived> SessionCache<V> {
    /// Record that `session_id` is now registered under the catalog `entry`,
    /// dropping whatever was cached for an earlier registration. Called under
    /// the catalog lock, with the catalog insert.
    pub(super) fn register(&self, session_id: &str, entry: &CatalogEntry) {
        let mut state = self.state.lock();
        state
            .registered
            .insert(session_id.to_string(), Arc::downgrade(entry));
        state.entries.remove(session_id);
    }

    /// Record that `session_id` has no catalog entry, dropping its cached
    /// value. Called under the catalog lock, with the catalog remove.
    pub(super) fn unregister(&self, session_id: &str) {
        let mut state = self.state.lock();
        state.registered.remove(session_id);
        state.entries.remove(session_id);
    }

    /// Apply an append the writer of the catalog `entry` wrote to the
    /// session's entry, creating it if missing. A writer whose entry is no
    /// longer the registered one (a straggler of a replaced registration)
    /// cannot tell whether its record is in a log the current registration
    /// reads, so it forgets the session instead.
    pub(super) fn update(
        &self,
        session_id: &str,
        entry: &CatalogEntry,
        apply: impl FnOnce(&mut V),
    ) {
        let mut state = self.state.lock();
        if state.is_registered(session_id, entry) {
            apply(state.entries.entry(session_id.to_string()).or_default());
            return;
        }
        state.forget(session_id);
        drop(state);
        log::warn!(
            "[acp-history] {} append from a writer whose catalog entry is gone; forgot the \
             session session_id={}",
            V::NAME,
            crate::logging::redact_session_id(session_id)
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

    /// Merge a scan of the log of the catalog `entry` into the session's
    /// entry. `Err` hands the scan back when it may not seed: a forget of
    /// the session ran since the scan started, so it may have read a log
    /// that no longer exists, or `entry` is no longer the session's catalog
    /// entry (deleted, or replaced by a new registration of the id).
    pub(super) fn seed(
        &self,
        session_id: &str,
        entry: &CatalogEntry,
        ticket: ScanTicket,
        scanned: V::Scan,
    ) -> std::result::Result<V::Value, V::Scan> {
        let mut state = self.state.lock();
        if ticket != state.ticket(session_id) || !state.is_registered(session_id, entry) {
            return Err(scanned);
        }
        Ok(V::seed(
            state.entries.entry(session_id.to_string()),
            scanned,
        ))
    }

    /// Drop the session's entry and reject its scans already in flight.
    pub(super) fn forget(&self, session_id: &str) {
        self.state.lock().forget(session_id);
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

    /// Called by the writer once the record is on disk, never before, and
    /// while it still holds the session's entry lock. A salvage that runs
    /// between the enqueue and the write forgets the session, and a scan
    /// after that forget reads a log without the record; applied after the
    /// write, the record always lands on top of that scan. A salvage cannot
    /// run between the write and the apply, so its forget can never be
    /// followed by a record its rewrite dropped.
    pub(super) fn apply(self, inner: &Inner, writer_entry: &CatalogEntry) {
        #[cfg(test)]
        if let Some(hook) = inner.cache_apply_hook.lock().clone() {
            hook();
        }
        inner
            .last_controls
            .note(&self.session_id, writer_entry, self.controls);
        if let Some(commands) = self.commands {
            inner
                .last_commands
                .update(&self.session_id, writer_entry, |entry| *entry = commands);
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
            // The catalog entry is read after the ticket is taken, and the
            // seed is bound to it: see `SessionCache::seed`.
            let entry = self.catalog_entry(session_id)?;
            let storage_key = entry.lock().storage_key.clone();
            let path = self.session_dir(&storage_key)?.join(MESSAGES_FILE);
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
            if let Ok(value) = cache.seed(session_id, &entry, ticket, scanned) {
                return Ok(value);
            }
            log::info!(
                "[acp-history] {} scan overtaken by a log rewrite or a catalog change; \
                 rescanning session_id={} attempt={attempt}",
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
    /// The scan holds up the session's writer and `persist_index`, which
    /// is why it is not the first resort.
    ///
    /// A delete can remove the catalog entry after it is cloned here but
    /// before the ticket is taken under its lock; the ticket is then current
    /// but the scan reads the deleted log. The seed is bound to the cloned
    /// entry: it lands only while that entry is still registered, and the
    /// catalog remove or insert that unregisters it later drops it.
    async fn read_through_locked<V: LogDerived>(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<V::Value> {
        let entry = self.catalog_entry(session_id)?;
        let scanned = match self.scan_under_entry_lock::<V>(session_id, entry).await? {
            Ok(value) => return Ok(value),
            Err(scanned) => scanned,
        };
        let registered = self.inner.catalog.lock().contains_key(session_id);
        log::warn!(
            "[acp-history] {} locked scan raced a delete or re-registration; did not seed \
             session_id={} registered={registered}",
            V::NAME,
            crate::logging::redact_session_id(session_id)
        );
        if registered {
            // The entry was replaced (a writer reopen, or a delete and a new
            // registration of the id) while the read ran, or a straggling
            // writer of an older entry forgot the session. Returning the scan
            // is no worse than a read that finished just before; it is never
            // cached, so it cannot outlive the replacement.
            Ok(V::unseeded(scanned))
        } else {
            Err(SessionPersistenceError::SessionNotFound)
        }
    }

    /// Scan the log and seed the cache under the session's catalog `entry`.
    /// The inner `Err` is a scan that may not seed (see `SessionCache::seed`).
    async fn scan_under_entry_lock<V: LogDerived>(
        self: &Arc<Self>,
        session_id: &str,
        entry: CatalogEntry,
    ) -> Result<std::result::Result<V::Value, V::Scan>> {
        let persistence = Arc::clone(self);
        let id = session_id.to_string();
        #[cfg(test)]
        let hook = self.locked_scan_hook.lock().clone();
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(hook) = hook {
                hook();
            }
            let metadata = entry.lock();
            let cache = V::cache(&persistence.inner);
            let ticket = match cache.lookup(&id) {
                Ok(known) => return Ok(Ok(known)),
                Err(ticket) => ticket,
            };
            let path = persistence
                .session_dir(&metadata.storage_key)?
                .join(MESSAGES_FILE);
            let scanned = V::scan(&path, &id)?;
            Ok(cache.seed(&id, &entry, ticket, scanned))
        })
        .await
        .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))?
    }

    /// Forget every cached value folded from the session's log, after the
    /// log was rewritten.
    pub(super) fn forget_log_derived(&self, session_id: &str) {
        self.inner.last_commands.forget(session_id);
        self.inner.last_controls.forget(session_id);
    }

    /// Bind the log-derived caches of `session_id` to its new catalog
    /// `entry`. The caller holds the catalog lock and inserts `entry`.
    pub(super) fn register_log_derived(&self, session_id: &str, entry: &CatalogEntry) {
        self.inner.last_commands.register(session_id, entry);
        self.inner.last_controls.register(session_id, entry);
    }

    /// Unbind the log-derived caches of `session_id` from its removed
    /// catalog entry. The caller holds the catalog lock.
    pub(super) fn unregister_log_derived(&self, session_id: &str) {
        self.inner.last_commands.unregister(session_id);
        self.inner.last_controls.unregister(session_id);
    }

    /// The session's catalog entry.
    fn catalog_entry(&self, session_id: &str) -> Result<CatalogEntry> {
        self.inner
            .catalog
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)
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

    /// Test seam: `callback` runs in the locked last resort after it clones
    /// the catalog entry and before it takes the entry lock.
    #[cfg(test)]
    pub(crate) fn set_locked_scan_test_callback(&self, callback: CacheScanTestCallback) {
        *self.locked_scan_hook.lock() = Some(callback);
    }

    /// Test seam: `callback` runs as the writer applies an append to the
    /// caches.
    #[cfg(test)]
    pub(crate) fn set_cache_apply_test_callback(&self, callback: CacheScanTestCallback) {
        *self.inner.cache_apply_hook.lock() = Some(callback);
    }
}

/// A catalog entry for `session_id` that no catalog holds, for tests that
/// drive a [`SessionCache`] directly.
#[cfg(test)]
pub(super) fn test_catalog_entry(session_id: &str) -> CatalogEntry {
    let metadata = serde_json::from_value(serde_json::json!({
        "schemaVersion": SESSION_SCHEMA_VERSION,
        "storageKey": Uuid::new_v4().to_string(),
        "sessionId": session_id,
        "cwd": "/",
        "createdAt": 0,
        "lastActivityAt": 0,
        "status": "active",
        "messageCount": 0,
        "toolCount": 0,
        "lastSeq": 0,
    }))
    .expect("test catalog entry");
    Arc::new(Mutex::new(metadata))
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
