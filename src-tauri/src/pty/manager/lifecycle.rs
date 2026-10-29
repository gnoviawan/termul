use super::*;

impl PtyManager {
    /// Write data to a terminal
    pub async fn write(&self, id: &str, data: &str) -> Result<(), String> {
        self.write_authorized(id, data, None).await
    }

    /// Write to a terminal, refusing the bytes when `authorization` no longer
    /// matches. Generation is checked under the claims lock that rotate/revoke
    /// use to bump it, after this method holds the writer lock.
    pub async fn write_authorized(
        &self,
        id: &str,
        data: &str,
        authorization: Option<&crate::pty::claims::ClaimWriteLease<'_>>,
    ) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        let mut writer_guard = instance.writer.lock().await;

        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "PTY writer unavailable".to_string())?;

        let mut write = || {
            writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write to PTY: {}", e))?;
            writer
                .flush()
                .map_err(|e| format!("Failed to flush PTY: {}", e))?;
            Ok(())
        };
        match authorization {
            None => write(),
            Some(lease) => lease
                .if_current(write)
                .unwrap_or_else(|| Err("Unauthorized".to_string())),
        }
    }

    /// Resize a terminal
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        if let Some(resizer) = &instance.resizer {
            resizer(cols, rows)?;
            *instance.cols.write() = cols;
            *instance.rows.write() = rows;
            return Ok(());
        }

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
        Ok(())
    }

    /// Kill a terminal.
    ///
    /// The terminal is removed from the registry and its child signalled to
    /// exit (best-effort, synchronously), so the caller (a user closing a tab)
    /// returns at once and the terminal is immediately unlisted and
    /// unattachable. The slow part of the teardown — the child-exit poll and
    /// the reader/flusher thread joins — plus the per-terminal tracker cleanup
    /// run on a detached background task (#1300). Kept `async` only to preserve
    /// the caller's `.await`; the body no longer awaits (see
    /// [`detach_and_teardown`](Self::detach_and_teardown)).
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

        // Taken BEFORE the terminal leaves the registry: once it is gone, a
        // concurrent `kill_all` sees neither it nor (yet) its teardown task, so
        // the token is what keeps `kill_all`'s wait open until the teardown
        // that follows has been spawned and finished.
        let token = self.teardown_tasks.token();
        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.detach_and_teardown(id.to_string(), instance, token);
        Ok(())
    }

    /// Force-kill bypassing the desktop `is_hidden` deferral. Used by the web
    /// handler so that closing a terminal from a browser actually terminates
    /// the process even when the desktop window is minimized. Desktop callers
    /// continue to use [`kill`](Self::kill) which preserves the hide behavior.
    ///
    /// Like [`kill`](Self::kill), the slow teardown runs in the background so
    /// the caller returns promptly (#1300). The terminal is removed from the
    /// registry before this returns, so project remove/archive and spawn
    /// rollback callers observe it gone immediately.
    pub async fn force_kill(&self, id: &str) -> Result<(), String> {
        // Taken BEFORE the terminal leaves the registry: once it is gone, a
        // concurrent `kill_all` sees neither it nor (yet) its teardown task, so
        // the token is what keeps `kill_all`'s wait open until the teardown
        // that follows has been spawned and finished.
        let token = self.teardown_tasks.token();
        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.detach_and_teardown(id.to_string(), instance, token);
        Ok(())
    }

    /// Signal a removed terminal's child to exit now, then finish its teardown
    /// off the caller's path (#1300).
    ///
    /// The child is signalled best-effort before the caller returns — in the
    /// common (uncontended) case the kill syscall runs here synchronously.
    /// Everything slow — the child-exit poll and reap, the reader/flusher
    /// thread joins, and the per-terminal tracker cleanup — happens on the
    /// detached task spawned here, matching the sweeper's teardown
    /// (`ExitSweep::remove_expired`) so the ordering and semantics are
    /// identical apart from the removed `await`.
    ///
    /// This is deliberately NOT `async`: once the terminal has left the
    /// registry, there must be no `.await` before the teardown token is moved
    /// into the owned task below. An awaited `child.lock().await` here was a
    /// cancellation point — if the close future was dropped while that lock was
    /// contended, the token (and the whole teardown) was dropped before the
    /// child was signalled or the cleanup spawned, and a concurrent `kill_all`
    /// — seeing neither the removed terminal nor a spawned teardown — missed it
    /// entirely (#1515). With no `.await`, the body runs to completion in a
    /// single poll, so the caller's cancellation can never strand the teardown.
    ///
    /// `instance` must already be removed from `terminals` so the terminal is
    /// unlisted and unattachable the moment this is reached.
    fn detach_and_teardown(
        &self,
        id: String,
        instance: Arc<TerminalInstance>,
        token: tokio_util::task::task_tracker::TaskTrackerToken,
    ) {
        // Best-effort quick kill syscall: `try_lock` keeps this off any
        // `.await`, so the process is signalled before we return without
        // reintroducing the cancellation point above. On the rare lock
        // contention the kill is deferred to the background task below, whose
        // cleanup_terminal_resources_sync kills the child unconditionally — and
        // that kill is idempotent (a second kill of a dead child is a no-op).
        if let Ok(mut guard) = instance.child.try_lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }

        // The terminal is already out of the registry, so announce the set
        // change NOW — the project's listing update must not wait on the
        // background teardown. The remaining per-terminal cleanup stays in the
        // teardown so the exit event the reader emits on EOF is still delivered
        // before the event hub entry is removed.
        self.set_observer.notify(instance.project_id.as_deref());

        self.spawn_background_teardown(id, instance, token);
    }

    /// Run the blocking PTY teardown and the per-terminal tracker cleanup on a
    /// detached task. See [`detach_and_teardown`](Self::detach_and_teardown).
    /// The set-observer notification already fired synchronously there, so it
    /// is deliberately not repeated here.
    fn spawn_background_teardown(
        &self,
        id: String,
        instance: Arc<TerminalInstance>,
        token: tokio_util::task::task_tracker::TaskTrackerToken,
    ) {
        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let terminal_events = self.terminal_events.clone();
        let claims = self.claims.clone();

        self.teardown_tasks.spawn(async move {
            // Held until the teardown finishes (see `kill`).
            let _token = token;
            let cleanup = instance.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                Self::cleanup_terminal_resources_sync(cleanup, true);
            })
            .await
            {
                log::warn!(
                    "[PtyManager] background teardown failed for terminal {}: {}",
                    id,
                    e
                );
            }

            // Mirror the foreground tail the awaited kill used to run (minus the
            // already-fired notify): clear the per-terminal trackers, drop the
            // event hub entry once the exit event has been emitted, and remove
            // the claim record.
            cwd_tracker.stop_tracking(&id);
            git_tracker.remove_terminal(&id);
            exit_code_tracker.remove_terminal(&id);
            terminal_events.remove(&id);
            claims.remove(&id);
        });
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

    /// Lease that re-checks `captured` under the claims lock around a PTY write.
    pub fn claim_write_lease<'a>(
        &'a self,
        terminal_id: &'a str,
        captured: Option<u64>,
    ) -> crate::pty::claims::ClaimWriteLease<'a> {
        crate::pty::claims::ClaimWriteLease::new(&self.claims, terminal_id, captured)
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
            reset: replay.reset,
            log_epoch: replay.log_epoch.clone(),
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

    /// Ids of the live terminals bound to `project_id` (the write-once project
    /// stamped at spawn), sorted for a stable listing. The project registry
    /// refuses to remove or archive a project while this is non-empty.
    pub fn terminal_ids_for_project(&self, project_id: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .terminals
            .read()
            .values()
            .filter(|instance| instance.project_matches(project_id))
            .map(|instance| instance.id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Get terminal count
    pub fn get_count(&self) -> usize {
        self.terminals.read().len()
    }

    /// Check if terminal limit is reached
    pub fn is_limit_reached(&self) -> bool {
        self.live_terminal_count() >= GLOBAL_TERMINAL_LIMIT
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

            let project_id = instance.project_id.clone();

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
            self.set_observer.notify(project_id.as_deref());
        }

        // Also wait for teardowns already detached by `kill`/`force_kill`, so
        // exit does not cut one off mid-join. Bounded so a stuck teardown can
        // never hang app exit; reopened so the manager stays usable.
        self.teardown_tasks.close();
        if tokio::time::timeout(Duration::from_secs(5), self.teardown_tasks.wait())
            .await
            .is_err()
        {
            log::warn!("[PtyManager] detached teardowns still running at kill_all timeout");
        }
        self.teardown_tasks.reopen();
    }

    /// The live terminal whose spawn carried `command_id` (AD-5 entity
    /// lookup: a spawn resend whose ledger outcome is gone finds its PTY by the
    /// id stamped at construction). `None` when it was never spawned, was
    /// killed, or was reaped.
    pub fn find_by_command_id(&self, command_id: &str) -> Option<Arc<TerminalInstance>> {
        self.terminals
            .read()
            .values()
            .find(|instance| instance.command_id.as_deref() == Some(command_id))
            .cloned()
    }

    /// The reply for a RESENT spawn whose PTY already exists: its metadata and
    /// a FRESH claim for the resender. The claim of the first reply is never
    /// stored anywhere (the reply was lost), but the first reply may still be
    /// in flight or its client about to attach, so the resender's claim is
    /// always SHARED (`issue_shared` appends a credential and invalidates no
    /// existing holder). `None` when no live terminal of `project_id` carries
    /// `command_id`, or no credential can be issued — a revoked (or missing)
    /// claim record is never resurrected by a resend — and the caller then
    /// answers `outcome_unknown` instead of respawning.
    pub fn replay_spawn(
        &self,
        command_id: &str,
        project_id: Option<&str>,
    ) -> Option<SpawnedTerminal> {
        let instance = self.find_by_command_id(command_id)?;
        if instance.project_id.as_deref() != project_id {
            return None;
        }
        let claim = self
            .claims
            .issue_shared(&instance.id, instance.project_id.as_deref())
            .ok()?;
        let cols = *instance.cols.read();
        let rows = *instance.rows.read();
        Some(SpawnedTerminal {
            info: TerminalInfo {
                id: instance.id.clone(),
                shell: instance.shell.clone(),
                cwd: instance.cwd.clone(),
                pid: instance.pid,
                cols,
                rows,
            },
            claim,
        })
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
    /// #851 (second device): terminals with a LIVE attachment on another
    /// connection now get a SHARED claim (`issue_shared` appends a digest
    /// WITHOUT invalidating the existing holder, generation unchanged) plus
    /// `live_attachment: true` ownership info — so a second device's
    /// `list_preserved` → `attach` flow joins the SAME PTY read/write
    /// instead of the previous behavior (empty claim → the renderer silently
    /// spawns a duplicate shell per device). Terminals with no live
    /// attachment keep the replace-and-reissue semantics below.
    ///
    /// `terminal_id` narrows the listing (and so the re-issue) to one
    /// terminal: recovering one terminal's lost rotation must not invalidate
    /// the claims its siblings' holders still present.
    pub fn list_preserved(
        &self,
        project_id: &str,
        terminal_id: Option<&str>,
    ) -> Vec<PreservedTerminal> {
        let instances: Vec<Arc<TerminalInstance>> = self
            .terminals
            .read()
            .values()
            .filter(|instance| instance.project_matches(project_id))
            .filter(|instance| terminal_id.is_none_or(|id| instance.id == id))
            .cloned()
            .collect();
        instances
            .into_iter()
            .map(|instance| {
                let cols = *instance.cols.read();
                let rows = *instance.rows.read();
                let live_attachment = instance.has_live_attachment();
                let claim = if live_attachment {
                    // #851: another connection holds a live forwarder —
                    // APPEND a shared credential rather than replacing the
                    // record. The existing holder's lease keeps verifying
                    // and its forwarder stays attached (no generation bump);
                    // the listing connection may now attach read/write too.
                    // A shared issuance failure (revoked/unknown) offers no
                    // claim: the caller falls back to spawn.
                    self.claims
                        .issue_shared(&instance.id, instance.project_id.as_deref())
                        .ok()
                } else {
                    Some(
                        self.claims
                            .issue(&instance.id, instance.project_id.as_deref()),
                    )
                };
                let info = TerminalInfo {
                    id: instance.id.clone(),
                    shell: instance.shell.clone(),
                    cwd: instance.cwd.clone(),
                    pid: instance.pid,
                    cols,
                    rows,
                };
                PreservedTerminal {
                    info,
                    claim,
                    live_attachment,
                }
            })
            .collect()
    }

    /// Set the app window hidden state.
    /// When hidden=true, kill() operations and the exited-PTY sweep are
    /// deferred. Prevents ConPTY lifecycle issues
    /// on Windows where window minimize can cause PTY processes to die.
    pub fn set_hidden(&self, hidden: bool) {
        self.is_hidden.store(hidden, Ordering::Relaxed);
        if hidden {
            log::info!(
                "[PtyManager] App window hidden — killing and exited-terminal cleanup deferred"
            );
        } else {
            log::info!(
                "[PtyManager] App window visible — killing and exited-terminal cleanup resumed"
            );
        }
    }

    /// Check if the app window is currently hidden
    pub fn is_hidden(&self) -> bool {
        self.is_hidden.load(Ordering::Relaxed)
    }
}
