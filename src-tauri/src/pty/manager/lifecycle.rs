use super::*;

impl PtyManager {
    /// Write data to a terminal
    pub async fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        instance.update_activity();

        let mut writer_guard = instance.writer.lock().await;

        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "PTY writer unavailable".to_string())?;

        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;

        Ok(())
    }

    /// Resize a terminal
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        #[cfg(target_os = "windows")]
        {
            if let Some(conpty_handles) = &instance.conpty_handles {
                let guard = conpty_handles.lock();
                let handles = guard
                    .as_ref()
                    .ok_or_else(|| "ConPTY handles unavailable".to_string())?;
                resize_conpty(handles, cols, rows)
                    .map_err(|e| format!("Failed to resize ConPTY: {}", e))?;

                *instance.cols.write() = cols;
                *instance.rows.write() = rows;
                instance.update_activity();

                return Ok(());
            }
        }

        let master_guard = instance.master.lock().await;

        let master = master_guard
            .as_ref()
            .ok_or_else(|| "PTY master already consumed".to_string())?;

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        master
            .resize(size)
            .map_err(|e| format!("Failed to resize terminal: {}", e))?;

        *instance.cols.write() = cols;
        *instance.rows.write() = rows;
        instance.update_activity();

        Ok(())
    }

    /// Kill a terminal
    /// This is async because cleanup_terminal_resources_sync uses blocking_lock()
    /// on AsyncMutex fields, which is forbidden inside tokio async runtime.
    ///
    /// When app window is hidden, kill is deferred to prevent ConPTY lifecycle
    /// issues on Windows where minimize can cause terminal processes to die.
    /// The terminal remains tracked and will be cleaned up on next visible cycle
    /// or when explicitly killed from the visible state.
    pub async fn kill(&self, id: &str) -> Result<(), String> {
        // When app is hidden, defer the kill — the PTY process should survive hide.
        // ConPTY on Windows can kill processes when the window is minimized.
        if self.is_hidden.load(Ordering::Relaxed) {
            log::info!(
                "[PtyManager] Deferring kill of terminal {} (app window hidden)",
                id
            );
            return Ok(());
        }

        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.release_terminal_slot();

        // Wrap blocking cleanup in spawn_blocking to avoid panic
        let instance_clone = instance.clone();
        tokio::task::spawn_blocking(move || {
            Self::cleanup_terminal_resources_sync(instance_clone, true);
        })
        .await
        .map_err(|e| format!("spawn_blocking failed for terminal {}: {}", id, e))?;

        // Stop tracking (sync operations, safe to run after spawn_blocking)
        self.cwd_tracker.stop_tracking(id);
        self.git_tracker.remove_terminal(id);
        self.exit_code_tracker.remove_terminal(id);
        self.terminal_events.remove(id);
        self.claims.remove(id);

        Ok(())
    }

    /// Force-kill bypassing the desktop `is_hidden` deferral. Used by the web
    /// handler so that closing a terminal from a browser actually terminates
    /// the process even when the desktop window is minimized. Desktop callers
    /// continue to use [`kill`](Self::kill) which preserves the hide behavior.
    pub async fn force_kill(&self, id: &str) -> Result<(), String> {
        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.release_terminal_slot();

        let instance_clone = instance.clone();
        tokio::task::spawn_blocking(move || {
            Self::cleanup_terminal_resources_sync(instance_clone, true);
        })
        .await
        .map_err(|e| format!("spawn_blocking failed for terminal {}: {}", id, e))?;

        self.cwd_tracker.stop_tracking(id);
        self.git_tracker.remove_terminal(id);
        self.exit_code_tracker.remove_terminal(id);
        self.terminal_events.remove(id);
        self.claims.remove(id);

        Ok(())
    }

    /// Add a renderer reference to a terminal
    pub fn add_renderer_ref(&self, id: &str, renderer_id: &str) -> Result<(), String> {
        self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))
            .map(|instance| instance.add_renderer_ref(renderer_id.to_string()))
    }

    /// Remove a renderer reference from a terminal
    pub fn remove_renderer_ref(&self, id: &str, renderer_id: &str) -> Result<(), String> {
        self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))
            .map(|instance| instance.remove_renderer_ref(renderer_id))
    }

    /// Update a terminal's orphan-reaping protection.
    ///
    /// Protection is enabled at spawn and should be disabled only when the
    /// terminal is genuinely released by the renderer (its project is closed or
    /// the terminal tab is closed). Once unprotected AND lacking renderer refs,
    /// the terminal becomes eligible for orphan reaping again. This is a no-op
    /// (rather than an error) when the terminal is already gone, so callers can
    /// release idempotently.
    pub fn set_protected(&self, id: &str, protected: bool) {
        if let Some(instance) = self.terminals.read().get(id) {
            instance.set_protected(protected);
        }
    }

    pub fn terminal_events(&self) -> TerminalEventHub {
        self.terminal_events.clone()
    }

    pub fn cwd_tracker(&self) -> Arc<CwdTracker> {
        Arc::clone(&self.cwd_tracker)
    }

    pub fn git_tracker(&self) -> Arc<GitTracker> {
        Arc::clone(&self.git_tracker)
    }

    pub fn exit_code_tracker(&self) -> Arc<ExitCodeTracker> {
        Arc::clone(&self.exit_code_tracker)
    }

    /// Verify a claim credential for a terminal.
    ///
    /// The project binding checked is the terminal's OWN write-once
    /// `project_id` (co-derived with the issuance binding at spawn), so
    /// issuance and verification can never diverge. Every failure mode —
    /// unknown terminal, oversized probe, wrong/revoked credential, binding
    /// mismatch — collapses to the same [`crate::pty::claims::ClaimError`].
    pub fn verify_claim(&self, terminal_id: &str, claim: &str) -> Result<(), ClaimError> {
        let binding = self
            .get(terminal_id)
            .and_then(|instance| instance.project_id.clone());
        self.claims.verify(terminal_id, claim, binding.as_deref())
    }

    /// Rotate a claim: possession of the current credential yields a fresh
    /// credential and atomically invalidates the old one. The generation bump
    /// is the signal for credential-derived access (desktop attach forwarders)
    /// to terminate.
    pub fn rotate_claim(&self, terminal_id: &str, claim: &str) -> Result<String, ClaimError> {
        let binding = self
            .get(terminal_id)
            .and_then(|instance| instance.project_id.clone());
        self.claims.rotate(terminal_id, claim, binding.as_deref())
    }

    /// Revoke a claim credential. The PTY itself is untouched — revocation
    /// only severs credential-derived access (never-clause).
    pub fn revoke_claim(&self, terminal_id: &str, claim: &str) -> Result<(), ClaimError> {
        let binding = self
            .get(terminal_id)
            .and_then(|instance| instance.project_id.clone());
        self.claims.revoke(terminal_id, claim, binding.as_deref())
    }

    /// Current claim generation for a terminal, if a claim record exists.
    /// Desktop attach forwarders capture this at attach time and terminate
    /// when it changes (rotate/revoke) or disappears (kill/reap).
    pub fn claim_generation(&self, terminal_id: &str) -> Option<u64> {
        self.claims.generation(terminal_id)
    }

    /// Build the shared attach result (byte-identical camelCase shape on both
    /// transports). Resolves the terminal's LIVE cwd from the `CwdTracker`,
    /// falling back to the spawn-time cwd when no tracked value exists.
    pub fn build_attach_result(
        &self,
        instance: &TerminalInstance,
        replay: &TerminalReplay,
    ) -> TerminalAttachResult {
        let cwd = self
            .cwd_tracker
            .get_cwd(&instance.id)
            .unwrap_or_else(|| instance.cwd.clone());
        TerminalAttachResult {
            id: instance.id.clone(),
            shell: instance.shell.clone(),
            cwd,
            pid: instance.pid,
            cols: *instance.cols.read(),
            rows: *instance.rows.read(),
            latest_seq: replay.latest_seq,
            gap: replay.gap,
            snapshot: self.terminal_events.snapshot(&instance.id),
        }
    }

    /// Get terminal by ID
    pub fn get(&self, id: &str) -> Option<Arc<TerminalInstance>> {
        self.terminals.read().get(id).cloned()
    }

    /// Get all terminals
    pub fn get_all(&self) -> Vec<Arc<TerminalInstance>> {
        self.terminals.read().values().cloned().collect()
    }

    /// Get terminal count
    pub fn get_count(&self) -> usize {
        self.terminals.read().len()
    }

    /// Check if terminal limit is reached
    pub fn is_limit_reached(&self) -> bool {
        self.active_terminal_slots.load(Ordering::SeqCst) >= GLOBAL_TERMINAL_LIMIT
    }

    /// Kill all terminals (best-effort), used as app-exit safety net.
    /// This is async because cleanup_terminal_resources_sync uses blocking_lock()
    /// on AsyncMutex fields, which is forbidden inside tokio async runtime.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.terminals.read().keys().cloned().collect();

        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();

        for id in ids {
            let instance = match self.terminals.write().remove(&id) {
                Some(i) => i,
                None => continue,
            };

            self.release_terminal_slot();

            // Wrap blocking cleanup in spawn_blocking to avoid panic
            let instance_clone = instance.clone();
            let id_clone = id.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                Self::cleanup_terminal_resources_sync(instance_clone, true);
            })
            .await
            {
                log::warn!("spawn_blocking failed for terminal {}: {}", id_clone, e);
            }

            // Stop tracking (sync operations)
            cwd_tracker.stop_tracking(&id);
            git_tracker.remove_terminal(&id);
            exit_code_tracker.remove_terminal(&id);
            self.terminal_events.remove(&id);
            self.claims.remove(&id);
        }
    }

    /// Update orphan detection settings (timeout in milliseconds)
    pub fn update_orphan_detection(&self, enabled: bool, timeout_ms: Option<u64>) {
        self.orphan_detection_enabled
            .store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_ms {
            self.orphan_timeout_ms.store(timeout, Ordering::Relaxed);
        }
    }

    /// Update orphan detection settings (timeout in minutes, for async API compatibility)
    pub async fn update_orphan_detection_settings(
        &self,
        enabled: bool,
        timeout_minutes: Option<u64>,
    ) {
        self.orphan_detection_enabled
            .store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_minutes {
            self.orphan_timeout_ms
                .store(timeout * 60 * 1000, Ordering::Relaxed);
        }
    }

    /// Enumerate the terminals still preserved for a project, re-issuing a
    /// claim credential for each attachable one (QA round 2 / spec story 5).
    ///
    /// Scoping uses each terminal's OWN write-once `project_id` — the same
    /// binding the claim registry enforces — never any per-connection
    /// authorization set, so the result is a pure function of the project.
    /// Terminals without a project binding (desktop-spawned, `None`) are
    /// never listed here: the web reattach path is project-scoped by design.
    ///
    /// Re-issue semantics: `issue()` replaces the registry record (new
    /// digest, generation reset, revoked cleared), which invalidates any
    /// credential issued before the reload — exactly the intent, since the
    /// only party expected to hold the old credential (the reloaded page)
    /// is gone. The generation reset is safe: the sole consumer
    /// (`forwarder_should_terminate`) compares by inequality, and every
    /// attachment task alive at re-issue time is stale by definition, so
    /// `old != 0` still severs it.
    ///
    /// Terminals with a LIVE web attachment are skipped entirely (returned
    /// without a fresh claim — the entry carries no credential): another
    /// connection still holds a valid claim and an active output forwarder;
    /// reissuing would invalidate their credential and sever their stream
    /// (CodeRabbit: preserve existing live attachments when reissuing
    /// claims). The reloaded caller falls back to spawning for skipped
    /// terminals, exactly as it would for a terminal whose PTY is gone.
    pub fn list_preserved(&self, project_id: &str) -> Vec<PreservedTerminal> {
        let instances: Vec<Arc<TerminalInstance>> = self
            .terminals
            .read()
            .values()
            .filter(|instance| instance.project_matches(project_id))
            .cloned()
            .collect();
        instances
            .into_iter()
            .map(|instance| {
                let cols = *instance.cols.read();
                let rows = *instance.rows.read();
                let live_attachment = instance.has_web_attachment();
                let claim = if live_attachment {
                    // A live attachment owns the current credential — do not
                    // replace it. Empty string = "no claim offered"; the WS
                    // layer omits the field so the renderer treats this
                    // terminal as non-attachable and falls back to spawn.
                    String::new()
                } else {
                    self.claims
                        .issue(&instance.id, instance.project_id.as_deref())
                };
                let info = TerminalInfo {
                    id: instance.id.clone(),
                    shell: instance.shell.clone(),
                    cwd: instance.cwd.clone(),
                    pid: instance.pid,
                    cols,
                    rows,
                };
                PreservedTerminal { info, claim }
            })
            .collect()
    }

    /// Set the app window hidden state.
    /// When hidden=true, orphan detection will not kill orphaned terminals
    /// and kill() operations are deferred. Prevents ConPTY lifecycle issues
    /// on Windows where window minimize can cause PTY processes to die.
    pub fn set_hidden(&self, hidden: bool) {
        self.is_hidden.store(hidden, Ordering::Relaxed);
        if hidden {
            log::info!("[PtyManager] App window hidden — killing and orphan cleanup deferred");
        } else {
            log::info!("[PtyManager] App window visible — killing and orphan cleanup resumed");
        }
    }

    /// Check if the app window is currently hidden
    pub fn is_hidden(&self) -> bool {
        self.is_hidden.load(Ordering::Relaxed)
    }
}
