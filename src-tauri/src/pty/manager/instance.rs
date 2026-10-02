use super::*;

/// A running terminal instance
pub struct TerminalInstance {
    pub id: String,
    pub project_id: Option<String>,
    pub child: Arc<AsyncMutex<Option<Box<dyn Child + Send>>>>,
    pub master: Arc<AsyncMutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>,
    pub reader_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub flusher_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub last_activity: Arc<RwLock<Instant>>,
    pub orphan_since: Arc<RwLock<Option<Instant>>>,
    pub renderer_refs: Arc<RwLock<HashSet<String>>>,
    /// When true, this terminal is still owned by an open project/tab and must
    /// NOT be reaped by orphan detection — even if it currently has zero
    /// renderer refs (e.g. its project is switched to the background, so the
    /// `ConnectedTerminal` component unmounted). It is set true at spawn and
    /// cleared only when the terminal is explicitly released (project closed or
    /// terminal tab closed). This prevents busy background-project terminals
    /// from being killed mid-task — the cause of the "Terminal not found"/hang.
    pub protected: Arc<AtomicBool>,
    pub cols: Arc<RwLock<u16>>,
    pub rows: Arc<RwLock<u16>>,
    /// Broadcast channel for fan-out of raw PTY output to remote WebSocket clients.
    /// Each flusher batch is sent as a `Vec<u8>` message. Tauri frontend keeps using
    /// its dedicated Channel — this field is only consumed by the remote module.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<TerminalOutputChunk>>,
    /// Bounded sequence-aware output log. Oldest chunks are evicted first while
    /// keeping whole chunks, so reconnect cursors can detect replay gaps.
    pub output_log: Arc<RwLock<std::collections::VecDeque<TerminalOutputChunk>>>,
    pub output_log_bytes: Arc<AtomicUsize>,
    pub next_output_seq: Arc<AtomicU64>,
    /// Count of live web WS attachments (terminal_ws attach handlers
    /// increment; connection teardown decrements). `list_preserved`
    /// reattachment skips terminals with a live attachment so a second
    /// browser connection cannot invalidate the first one's claim
    /// (CodeRabbit: preserve existing live attachments when reissuing).
    pub web_attachments: Arc<AtomicUsize>,
    #[cfg(target_os = "windows")]
    pub conpty_handles: Option<Arc<ParkingMutex<Option<ConPtyHandles>>>>,
}

impl TerminalInstance {
    /// Whether any web WS connection currently holds a live attachment for
    /// this terminal (forwarder task active).
    pub fn has_web_attachment(&self) -> bool {
        self.web_attachments.load(Ordering::Acquire) > 0
    }

    /// Record a live web attachment (attach handler).
    pub fn add_web_attachment(&self) {
        self.web_attachments.fetch_add(1, Ordering::AcqRel);
    }

    /// Release a web attachment (connection teardown / detach).
    pub fn remove_web_attachment(&self) {
        // fetch_update always returns Ok (closure never fails); the result
        // value carries the previous count, which is not needed here.
        // Deprecated in Rust 1.99 for `try_update`, but try_update requires
        // Rust 1.95 while our MSRV is 1.88 — keep fetch_update + allow until
        // the MSRV catches up.
        #[allow(deprecated)]
        let _ = self
            .web_attachments
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(1))
            });
    }
}

impl TerminalInstance {
    /// Update the last activity timestamp
    pub fn update_activity(&self) {
        *self.last_activity.write() = Instant::now();
    }

    /// Get elapsed time since last activity
    pub fn inactive_duration(&self) -> Duration {
        self.last_activity.read().elapsed()
    }

    /// Add a renderer reference
    pub fn add_renderer_ref(&self, renderer_id: String) {
        self.renderer_refs.write().insert(renderer_id);
        *self.orphan_since.write() = None;
    }

    /// Remove a renderer reference
    pub fn remove_renderer_ref(&self, renderer_id: &str) {
        let mut refs = self.renderer_refs.write();
        let removed = refs.remove(renderer_id);
        if removed && refs.is_empty() {
            *self.orphan_since.write() = Some(Instant::now());
        }
    }

    /// Get count of renderer references
    pub fn renderer_ref_count(&self) -> usize {
        self.renderer_refs.read().len()
    }

    /// Check if terminal has no renderer references
    pub fn is_orphan(&self) -> bool {
        self.renderer_refs.read().is_empty()
    }

    /// Whether this terminal is eligible for orphan reaping right now.
    ///
    /// A terminal is reapable only when it is NOT protected (its project/tab is
    /// genuinely closed), has no renderer refs, and has exceeded the timeout —
    /// measured from when it became orphaned, or by inactivity if it never had
    /// a renderer ref. Protected terminals (e.g. a backgrounded project's live
    /// terminals) are never reaped, even with zero renderer refs.
    pub fn is_orphan_reapable(&self, timeout: Duration) -> bool {
        should_reap_orphan(
            self.is_protected(),
            self.is_orphan(),
            self.orphan_since().map(|since| since.elapsed()),
            self.inactive_duration(),
            timeout,
        )
    }

    /// Returns when the terminal became orphaned, if ever.
    pub fn orphan_since(&self) -> Option<Instant> {
        *self.orphan_since.read()
    }

    /// Whether this terminal is protected from orphan reaping (still owned by an
    /// open project/tab). See the `protected` field docs.
    pub fn is_protected(&self) -> bool {
        self.protected.load(Ordering::Relaxed)
    }

    /// Update the protection flag. Set false only when the terminal is genuinely
    /// released (project closed / terminal tab closed), making it eligible for
    /// orphan reaping once it also has no renderer refs.
    pub fn set_protected(&self, protected: bool) {
        self.protected.store(protected, Ordering::Relaxed);
    }

    pub fn project_matches(&self, project_id: &str) -> bool {
        self.project_id.as_deref() == Some(project_id)
    }

    /// Atomically snapshot unseen sequenced chunks and subscribe to live output.
    pub fn subscribe_from(&self, last_seq: u64) -> TerminalReplay {
        let guard = self.output_log.write();
        let receiver = self.broadcast_tx.subscribe();
        let earliest = guard.front().map(|chunk| chunk.seq);
        let latest_seq = guard.back().map(|chunk| chunk.seq).unwrap_or(last_seq);
        // Gap if the client's cursor is behind the earliest retained chunk,
        // OR if the log is empty but the client expected prior output.
        let gap = earliest
            .map(|first| last_seq.saturating_add(1) < first)
            .unwrap_or(last_seq > 0);
        let chunks = guard
            .iter()
            .filter(|chunk| chunk.seq > last_seq)
            .cloned()
            .collect();
        TerminalReplay {
            chunks,
            gap,
            latest_seq,
            receiver,
        }
    }
}

/// Pure decision for whether an orphaned terminal should be reaped.
///
/// Kept free-standing (no PTY handles) so it can be unit-tested in isolation.
///
/// * `protected` — terminal is still owned by an open project/tab; never reap.
/// * `is_orphan` — terminal currently has zero renderer refs.
/// * `orphaned_for` — elapsed time since it became orphaned, if it ever was.
/// * `inactive_for` — elapsed time since last PTY activity.
/// * `timeout` — configured orphan timeout.
pub(super) fn should_reap_orphan(
    protected: bool,
    is_orphan: bool,
    orphaned_for: Option<Duration>,
    inactive_for: Duration,
    timeout: Duration,
) -> bool {
    if protected || !is_orphan {
        return false;
    }
    match orphaned_for {
        Some(elapsed) => elapsed > timeout,
        None => inactive_for > timeout,
    }
}

pub(super) struct TerminalSlotReservation {
    active_slots: Arc<AtomicUsize>,
    committed: bool,
}

impl TerminalSlotReservation {
    pub(super) fn try_acquire(active_slots: Arc<AtomicUsize>) -> Option<Self> {
        loop {
            let current = active_slots.load(Ordering::SeqCst);
            if current >= GLOBAL_TERMINAL_LIMIT {
                return None;
            }

            if active_slots
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Some(Self {
                    active_slots,
                    committed: false,
                });
            }
        }
    }

    pub(super) fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TerminalSlotReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.active_slots.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// RAII rollback for a claim issued before PTY creation: if any spawn step
/// fails, the guard's drop removes the dangling claim record so no terminal
/// exists with a live credential but no PTY (and vice versa).
pub(super) struct ClaimRollbackGuard<'a> {
    pub(super) claims: &'a crate::pty::claims::TerminalClaimRegistry,
    pub(super) terminal_id: String,
    pub(super) active: bool,
}

impl ClaimRollbackGuard<'_> {
    pub(super) fn commit(&mut self) {
        self.active = false;
    }
}

impl Drop for ClaimRollbackGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            self.claims.remove(&self.terminal_id);
        }
    }
}
