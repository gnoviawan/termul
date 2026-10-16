use super::*;

/// A running terminal instance
pub struct TerminalInstance {
    pub id: String,
    pub project_id: Option<String>,
    /// The `commandId` of the spawn command that created this PTY, set once
    /// at construction. A spawn resend resolves to this instance by it.
    pub command_id: Option<String>,
    pub child: Arc<AsyncMutex<Option<Box<dyn Child + Send>>>>,
    pub master: Arc<AsyncMutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>,
    pub reader_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub flusher_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
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
    /// Identity of this spawn's output log. Chunk seqs restart at 1 with every
    /// spawn, so a cursor `lastSeq` is only meaningful with the epoch it was
    /// issued under.
    pub log_epoch: String,
    pub live_attachments: Arc<AtomicUsize>,
    /// Told when this terminal gains its first or loses its last web
    /// attachment (the `attached` flag of the `terminals` watch).
    pub set_observer: TerminalSetObserver,
    /// Connection id of the web client that last wrote input or resized
    /// (#851 "single size owner" — last-writer-wins; logged on change so
    /// resize conflicts between devices are observable). `None` until a
    /// web client acts on the terminal.
    pub web_size_owner: Arc<RwLock<Option<String>>>,
    /// Resize hook for terminals whose I/O is not a local PTY (an SSH shell
    /// channel). `None` for every locally spawned terminal.
    pub resizer: Option<ExternalResizer>,
    /// Set once the PTY's process has exited. An exited PTY that is still
    /// tracked holds no process, so it counts toward no terminal cap.
    pub exited: AtomicBool,
    /// When the process exited; `None` while it is alive. The exit sweeper
    /// removes the instance once this is older than the exit TTL.
    pub exited_at: parking_lot::Mutex<Option<Instant>>,
    #[cfg(target_os = "windows")]
    pub conpty_handles: Option<Arc<ParkingMutex<Option<ConPtyHandles>>>>,
}

impl TerminalInstance {
    /// Whether the PTY's process has exited.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    /// Record that the PTY's process exited. The first call wins, so the TTL
    /// counts from the moment of exit.
    pub fn mark_exited(&self) {
        {
            let mut exited_at = self.exited_at.lock();
            if exited_at.is_none() {
                *exited_at = Some(Instant::now());
            }
        }
        self.exited.store(true, Ordering::Release);
    }

    /// How long ago the process exited, or `None` while it is alive.
    pub fn exited_for(&self) -> Option<Duration> {
        self.exited_at.lock().map(|at| at.elapsed())
    }

    /// Whether a web WS connection or a desktop `terminal_attach` forwarder
    /// currently streams this terminal's output.
    pub fn has_live_attachment(&self) -> bool {
        self.live_attachments.load(Ordering::Acquire) > 0
    }

    /// Record a live attachment (web attach handler or desktop forwarder).
    pub fn add_live_attachment(&self) {
        if self.live_attachments.fetch_add(1, Ordering::AcqRel) == 0 {
            self.set_observer.notify(self.project_id.as_deref());
        }
    }

    /// Release a live attachment (teardown / detach). Only the
    /// attachment count drops: the PTY keeps running.
    pub fn remove_live_attachment(&self) {
        // fetch_update always returns Ok (closure never fails); the result
        // value carries the previous count, which is not needed here.
        // Deprecated in Rust 1.99 for `try_update`, but try_update requires
        // Rust 1.95 while our MSRV is 1.88 — keep fetch_update + allow until
        // the MSRV catches up.
        #[allow(deprecated)]
        let previous = self
            .live_attachments
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(1))
            });
        if previous == Ok(1) {
            self.set_observer.notify(self.project_id.as_deref());
        }
    }

    /// #851 "single size owner": record that connection `client_id` just
    /// wrote input or resized. Last writer wins; a CHANGED owner logs the
    /// reconciliation (tracing on the server surface) so resize conflicts
    /// between devices are observable. Returns the previous owner.
    pub fn note_web_size_owner(&self, client_id: &str) -> Option<String> {
        let mut owner = self.web_size_owner.write();
        let previous = owner.clone();
        if previous.as_deref() != Some(client_id) {
            tracing::info!(
                "[terminal-ws] size owner changed terminal_id={} client={} previous={:?}",
                self.id,
                client_id,
                previous.as_deref().unwrap_or("<none>")
            );
        }
        *owner = Some(client_id.to_string());
        previous
    }

    pub fn project_matches(&self, project_id: &str) -> bool {
        self.project_id.as_deref() == Some(project_id)
    }

    /// Atomically snapshot unseen sequenced chunks and subscribe to live output.
    ///
    /// `log_epoch` is the epoch `last_seq` was issued under. A cursor from a
    /// different epoch, or one ahead of the log's head, cannot be trusted
    /// (the old stream is gone or the client is confused): the whole retained
    /// log is replayed and `reset` is set so the client discards what it
    /// rendered instead of silently skipping output.
    pub fn subscribe_from(&self, last_seq: u64, log_epoch: Option<&str>) -> TerminalReplay {
        let guard = self.output_log.write();
        let receiver = self.broadcast_tx.subscribe();
        let earliest = guard.front().map(|chunk| chunk.seq);
        // The last allocated seq. A log emptied by eviction still has a head:
        // reading 0 there would reset a valid cursor and rewind `latest_seq`.
        let head_seq = guard.back().map_or_else(
            || self.next_output_seq.load(Ordering::Relaxed),
            |chunk| chunk.seq,
        );
        // A nonzero cursor with no epoch cannot be verified either: only an
        // initial (zero) cursor may come without one.
        let reset = log_epoch.map_or(last_seq > 0, |epoch| epoch != self.log_epoch)
            || last_seq > head_seq;
        let cursor = if reset { 0 } else { last_seq };
        // Gap if the client's cursor is behind the earliest retained chunk.
        // An empty log (eviction removed every chunk) has lost the output after
        // a cursor that is behind the head too; a cursor AT the head is valid.
        let gap = earliest.map_or(cursor < head_seq, |first| cursor.saturating_add(1) < first);
        let chunks = guard
            .iter()
            .filter(|chunk| chunk.seq > cursor)
            .cloned()
            .collect();
        TerminalReplay {
            chunks,
            gap,
            reset,
            latest_seq: head_seq,
            log_epoch: self.log_epoch.clone(),
            receiver,
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
