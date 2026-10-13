use super::*;

/// A terminal whose I/O comes from the caller instead of a local PTY (an SSH
/// shell channel). Adopted terminals get the same reader/flusher threads,
/// replay log, claim and kill path as spawned ones; only resize goes through
/// the supplied hook.
pub struct ExternalTerminal {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send>,
    pub resizer: ExternalResizer,
    /// Shown where a local terminal shows its shell path.
    pub shell: String,
    /// Shown where a local terminal shows its working directory.
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

impl PtyManager {
    /// Register an external terminal and start streaming its output. No
    /// output channel is bound here: the renderer attaches with the returned
    /// claim (`terminal_attach`), which replays from the first byte.
    pub async fn adopt_external(
        &self,
        terminal: ExternalTerminal,
    ) -> Result<SpawnedTerminal, String> {
        self.start_exit_sweeper();
        let id = self.generate_id();
        // Adopted terminals have no project, so only the global cap applies.
        let _slot_reservation = self
            .try_reserve_terminal_slot(&id, None)
            .map_err(|limit| limit.to_string())?;
        let claim = self.claims.issue(&id, None);
        let ExternalTerminal {
            reader,
            writer,
            child,
            resizer,
            shell,
            cwd,
            cols,
            rows,
        } = terminal;

        let instance = Arc::new(TerminalInstance {
            id: id.clone(),
            project_id: None,
            command_id: None,
            child: Arc::new(AsyncMutex::new(Some(child))),
            master: Arc::new(AsyncMutex::new(None)),
            writer: Arc::new(AsyncMutex::new(Some(writer))),
            reader_handle: Arc::new(AsyncMutex::new(None)),
            flusher_handle: Arc::new(AsyncMutex::new(None)),
            shell: shell.clone(),
            cwd: cwd.clone(),
            pid: 0,
            cols: Arc::new(RwLock::new(cols)),
            rows: Arc::new(RwLock::new(rows)),
            broadcast_tx: Arc::new(tokio::sync::broadcast::channel(TERM_BROADCAST_CAPACITY).0),
            output_log: Arc::new(RwLock::new(std::collections::VecDeque::new())),
            output_log_bytes: Arc::new(AtomicUsize::new(0)),
            next_output_seq: Arc::new(AtomicU64::new(0)),
            log_epoch: uuid::Uuid::new_v4().to_string(),
            web_attachments: Arc::new(AtomicUsize::new(0)),
            web_size_owner: Arc::new(RwLock::new(None)),
            resizer: Some(resizer),
            exited: AtomicBool::new(false),
            exited_at: parking_lot::Mutex::new(None),
            set_observer: self.set_observer.clone(),
            #[cfg(target_os = "windows")]
            conpty_handles: None,
        });

        let pending_buf = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
        let done_flag = Arc::new(AtomicBool::new(false));

        let flusher_pending = pending_buf.clone();
        let flusher_done = done_flag.clone();
        let flusher_id = id.clone();
        let flusher_broadcast = instance.broadcast_tx.clone();
        let flusher_output_log = instance.output_log.clone();
        let flusher_output_log_bytes = instance.output_log_bytes.clone();
        let flusher_next_seq = instance.next_output_seq.clone();
        let flusher_task = std::thread::spawn(move || {
            Self::flusher_loop(
                flusher_pending,
                flusher_done,
                flusher_broadcast,
                flusher_output_log,
                flusher_output_log_bytes,
                flusher_next_seq,
                None,
                flusher_id,
            );
        });

        let reader_instance = instance.clone();
        let terminal_events = self.terminal_events.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let reader_id = id.clone();
        let reader_task = std::thread::spawn(move || {
            Self::reader_loop(
                reader_instance,
                reader,
                terminal_events,
                exit_code_tracker,
                reader_id,
                pending_buf,
                done_flag,
            );
        });

        *instance.reader_handle.lock().await = Some(reader_task);
        *instance.flusher_handle.lock().await = Some(flusher_task);

        self.terminals.write().insert(id.clone(), instance);
        self.exit_code_tracker.initialize_terminal(&id);
        log::info!("[PtyManager] Adopted external terminal {}", id);

        Ok(SpawnedTerminal {
            info: TerminalInfo {
                id,
                shell,
                cwd,
                pid: 0,
                cols,
                rows,
            },
            claim,
        })
    }

    /// Issue a fresh claim for a live terminal that has no project binding
    /// (adopted terminals), invalidating the previous credential. Used when a
    /// reloaded renderer re-attaches to sessions it lost track of.
    pub fn reissue_unbound_claim(&self, id: &str) -> Option<String> {
        let instance = self.get(id)?;
        if instance.project_id.is_some() {
            return None;
        }
        Some(self.claims.issue(id, None))
    }
}
