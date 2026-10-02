use super::*;

impl PtyManager {
    /// Spawn a new terminal (with binary channel IPC).
    ///
    /// CAP-3: the claim credential is issued BEFORE PTY creation, bound to the
    /// same `project_id` that is co-derived onto the [`TerminalInstance`]
    /// (write-once; the verify side reads the instance binding, so issuance and
    /// verification can never diverge). Any failure path rolls the issuance
    /// back via the RAII guard, so a credential never outlives its terminal.
    /// Returns the shared [`SpawnedTerminal`] shape feeding both transports.
    pub async fn spawn(
        &self,
        options: SpawnOptions,
        on_data: Option<Channel<Response>>,
    ) -> Result<SpawnedTerminal, String> {
        // Start orphan detection on first spawn (lazy initialization)
        self.start_orphan_detection();

        let mut slot_reservation = self
            .try_reserve_terminal_slot()
            .ok_or_else(|| "Global terminal limit reached".to_string())?;

        let id = self.generate_id();

        let claim = self.claims.issue(&id, options.project_id.as_deref());
        let mut claim_guard = ClaimRollbackGuard {
            claims: &self.claims,
            terminal_id: id.clone(),
            active: true,
        };

        let info = match self.spawn_pty(id.clone(), options, on_data).await {
            Ok(info) => info,
            Err(e) => {
                // claim_guard drops here and removes the dangling record.
                return Err(e);
            }
        };

        claim_guard.commit();
        slot_reservation.commit();
        Ok(SpawnedTerminal { info, claim })
    }

    /// Platform-specific PTY creation (the former `spawn` body). `id` and the
    /// claim lifecycle are owned by [`spawn`](Self::spawn); slot reservation
    /// commits there too, so a failure on any branch rolls everything back.
    async fn spawn_pty(
        &self,
        id: String,
        options: SpawnOptions,
        on_data: Option<Channel<Response>>,
    ) -> Result<TerminalInfo, String> {
        // ADR-004.2: Resolve the program to run. When `program` is set we run
        // that executable directly (terminal-native agent launch); otherwise we
        // resolve a login shell exactly as before. `program == None` keeps the
        // shell path byte-for-byte identical to prior behavior.
        let resolved = if let Some(program) = &options.program {
            self.resolve_program_path(program)?
        } else if let Some(shell) = &options.shell {
            ResolvedProgram::new(self.resolve_shell_path(shell)?)
        } else {
            ResolvedProgram::new(self.get_default_shell()?)
        };
        // Merge prepend_args (from npm .cmd shim rewriting) with user args.
        // User args apply only for agent/program spawns, not shell spawns.
        let user_args = if options.program.is_some() {
            options.args.clone().unwrap_or_default()
        } else {
            Vec::new()
        };
        let program_args: Vec<String> =
            resolved.prepend_args.into_iter().chain(user_args).collect();
        let shell_path = resolved.program;

        // Resolve working directory
        let cwd = if let Some(cwd) = &options.cwd {
            cwd.clone()
        } else {
            self.get_home_directory()
        };

        // Verify CWD exists and canonicalize to resolve symlinks and path traversal.
        // On Windows, canonicalize returns a verbatim device-namespace path (the
        // extended-length prefix) that cmd.exe/ConPTY and other external tools reject
        // as "UNC paths are not supported", making the shell fall back to the Windows
        // directory. Normalize it to a tool-friendly form (no-op off Windows),
        // mirroring the #347 fix for git worktree paths. See `strip_verbatim_prefix`.
        let cwd = std::fs::canonicalize(&cwd)
            .map_err(|e| format!("Invalid working directory '{}': {}", cwd, e))?;
        let cwd =
            crate::path_validation::strip_verbatim_prefix(&cwd.to_string_lossy()).into_owned();

        // Get terminal size
        let cols = options.cols.unwrap_or(80);
        let rows = options.rows.unwrap_or(24);
        let env = self.merge_environment(options.env.clone());

        // On Windows, use our custom ConPTY implementation to avoid console window
        #[cfg(target_os = "windows")]
        {
            // ADR-004.2: In agent mode, build the command line from a discrete
            // argv array via the audited quoting helper — the prompt is passed as
            // a single argument and is never shell-interpolated. In shell mode,
            // preserve the existing shell-escaping behavior verbatim.
            let shell_escaped = if options.program.is_some() {
                crate::pty::windows::build_windows_command_line(&shell_path, &program_args)
            } else if shell_path.contains(' ') {
                format!(
                    "\"{}\" {}",
                    shell_path,
                    if cfg!(windows)
                        && (shell_path.contains("powershell") || shell_path.contains("pwsh"))
                    {
                        "-NoLogo" // Skip PowerShell banner only (profile still loads)
                    } else {
                        ""
                    }
                )
            } else if shell_path.contains("powershell") || shell_path.contains("pwsh") {
                format!("{} -NoLogo", shell_path) // Skip PowerShell banner only (profile still loads)
            } else {
                shell_path.clone()
            };

            let (reader, writer, pid, process_handle, job_handle, conpty_handles) =
                spawn_conpty(&shell_escaped, Some(&cwd), cols, rows, &env)
                    .map_err(|e| format!("Failed to spawn ConPTY: {}", e))?;

            let child = WindowsConPtyChild {
                pid,
                process_handle,
                job_handle,
            };

            // Create terminal instance
            let instance = Arc::new(TerminalInstance {
                id: id.clone(),
                project_id: options.project_id.clone(),
                child: Arc::new(AsyncMutex::new(Some(Box::new(child)))),
                master: Arc::new(AsyncMutex::new(None)), // No master for ConPTY
                writer: Arc::new(AsyncMutex::new(Some(writer))),
                reader_handle: Arc::new(AsyncMutex::new(None)),
                flusher_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                orphan_since: Arc::new(RwLock::new(None)),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                protected: Arc::new(AtomicBool::new(true)),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                broadcast_tx: Arc::new(tokio::sync::broadcast::channel(TERM_BROADCAST_CAPACITY).0),
                output_log: Arc::new(RwLock::new(std::collections::VecDeque::new())),
                output_log_bytes: Arc::new(AtomicUsize::new(0)),
                next_output_seq: Arc::new(AtomicU64::new(0)),
                web_attachments: Arc::new(AtomicUsize::new(0)),
                conpty_handles: Some(Arc::new(ParkingMutex::new(Some(conpty_handles)))),
            });

            // Start reader + flusher threads
            let pending_buf = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
            let done_flag = Arc::new(AtomicBool::new(false));

            let reader_instance = instance.clone();
            let terminal_events = self.terminal_events.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            // Spawn flusher thread first (it references pending_buf and done_flag)
            let flusher_pending = pending_buf.clone();
            let flusher_done = done_flag.clone();
            let flusher_channel = on_data.clone();
            let flusher_id = id.clone();
            let flusher_broadcast = instance.broadcast_tx.clone();
            let flusher_output_log = instance.output_log.clone();
            let flusher_output_log_bytes = instance.output_log_bytes.clone();
            let flusher_next_seq = instance.next_output_seq.clone();

            let flusher_task = std::thread::spawn(move || {
                log::info!("[PTY {}] Flusher thread starting", flusher_id);
                Self::flusher_loop(
                    flusher_pending,
                    flusher_done,
                    flusher_broadcast,
                    flusher_output_log,
                    flusher_output_log_bytes,
                    flusher_next_seq,
                    flusher_channel,
                    flusher_id,
                );
            });

            // Spawn reader thread
            let reader_task = std::thread::spawn(move || {
                log::info!(
                    "[PTY {}] Windows ConPTY reader thread starting",
                    terminal_id
                );
                Self::reader_loop(
                    reader_instance,
                    reader,
                    terminal_events,
                    exit_code_tracker,
                    terminal_id,
                    pending_buf,
                    done_flag,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);
            *instance.flusher_handle.lock().await = Some(flusher_task);

            // Store the terminal
            self.terminals.write().insert(id.clone(), instance.clone());

            // Initialize tracking
            self.cwd_tracker.start_tracking(&id, pid, &cwd);
            self.git_tracker.initialize_terminal(&id, &cwd);
            self.exit_code_tracker.initialize_terminal(&id);
            // CAP-11: seed the hub snapshot with the spawn-time cwd so a
            // client attaching before the first cwd-tracking event sees it
            // instead of `null` (a tracked cwd still overrides the seed).
            self.terminal_events.seed_cwd(&id, &cwd);

            Ok(TerminalInfo {
                id,
                shell: shell_path,
                cwd,
                pid,
                cols,
                rows,
            })
        }

        // On non-Windows, use portable-pty as before
        #[cfg(not(target_os = "windows"))]
        {
            use portable_pty::{native_pty_system, CommandBuilder};

            let pty_system = native_pty_system();
            let pty_size = PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            };

            let pty_pair = pty_system
                .openpty(pty_size)
                .map_err(|e| format!("Failed to open PTY: {}", e))?;

            let mut cmd = CommandBuilder::new(&shell_path);
            // Interactive shells: login flag so profile-sourced PATH is applied (GH-275).
            if options.program.is_none() {
                if let Some(login_arg) = crate::pty::env_refresh::shell_wants_login_arg(&shell_path)
                {
                    cmd.arg(login_arg);
                }
            }
            // ADR-004.2: In agent mode, append the argv tail as discrete
            // arguments. portable-pty passes argv without a shell, so the prompt
            // is delivered verbatim with no shell interpolation. In shell mode
            // `program_args` is empty and this loop is a no-op.
            for arg in &program_args {
                cmd.arg(arg);
            }
            for (key, value) in &env {
                cmd.env(key, value);
            }
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            cmd.cwd(&cwd);

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("Failed to spawn shell: {}", e))?;

            let pid = child.process_id().unwrap_or(0);

            let reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
            let writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

            let instance = Arc::new(TerminalInstance {
                id: id.clone(),
                project_id: options.project_id.clone(),
                child: Arc::new(AsyncMutex::new(Some(child))),
                master: Arc::new(AsyncMutex::new(Some(pty_pair.master))),
                writer: Arc::new(AsyncMutex::new(Some(writer))),
                reader_handle: Arc::new(AsyncMutex::new(None)),
                flusher_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                orphan_since: Arc::new(RwLock::new(None)),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                protected: Arc::new(AtomicBool::new(true)),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                broadcast_tx: Arc::new(tokio::sync::broadcast::channel(TERM_BROADCAST_CAPACITY).0),
                output_log: Arc::new(RwLock::new(std::collections::VecDeque::new())),
                output_log_bytes: Arc::new(AtomicUsize::new(0)),
                next_output_seq: Arc::new(AtomicU64::new(0)),
                web_attachments: Arc::new(AtomicUsize::new(0)),
                #[cfg(target_os = "windows")]
                conpty_handles: None,
            });

            // Start reader + flusher threads
            let pending_buf = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
            let done_flag = Arc::new(AtomicBool::new(false));

            // Spawn flusher thread first
            let flusher_pending = pending_buf.clone();
            let flusher_done = done_flag.clone();
            let flusher_channel = on_data.clone();
            let flusher_id = id.clone();
            let flusher_broadcast = instance.broadcast_tx.clone();
            let flusher_output_log = instance.output_log.clone();
            let flusher_output_log_bytes = instance.output_log_bytes.clone();
            let flusher_next_seq = instance.next_output_seq.clone();

            let flusher_task = std::thread::spawn(move || {
                log::info!("[PTY {}] Flusher thread starting", flusher_id);
                Self::flusher_loop(
                    flusher_pending,
                    flusher_done,
                    flusher_broadcast,
                    flusher_output_log,
                    flusher_output_log_bytes,
                    flusher_next_seq,
                    flusher_channel,
                    flusher_id,
                );
            });

            // Spawn reader thread
            let reader_instance = instance.clone();
            let terminal_events = self.terminal_events.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            let reader_task = std::thread::spawn(move || {
                Self::reader_loop(
                    reader_instance,
                    reader,
                    terminal_events,
                    exit_code_tracker,
                    terminal_id,
                    pending_buf,
                    done_flag,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);
            *instance.flusher_handle.lock().await = Some(flusher_task);

            self.terminals.write().insert(id.clone(), instance.clone());

            self.cwd_tracker.start_tracking(&id, pid, &cwd);
            self.git_tracker.initialize_terminal(&id, &cwd);
            self.exit_code_tracker.initialize_terminal(&id);
            // CAP-11: seed the hub snapshot with the spawn-time cwd so a
            // client attaching before the first cwd-tracking event sees it
            // instead of `null` (a tracked cwd still overrides the seed).
            self.terminal_events.seed_cwd(&id, &cwd);

            Ok(TerminalInfo {
                id,
                shell: shell_path,
                cwd,
                pid,
                cols,
                rows,
            })
        }
    }

    /// ADR-002.3: Reader thread — reads PTY data into pending buffer, no direct IPC.
    /// Pushes raw bytes to pending_buf, handles overflow protection.
    /// Sets done_flag to true on EOF or error so flusher can finalize.
    /// ADR-002.5: Intercepts DA queries via DaFilter and responds directly to PTY writer.
    fn reader_loop(
        instance: Arc<TerminalInstance>,
        mut reader: Box<dyn Read + Send>,
        terminal_events: TerminalEventHub,
        exit_code_tracker: Arc<ExitCodeTracker>,
        terminal_id: String,
        pending_buf: Arc<Mutex<Vec<u8>>>,
        done_flag: Arc<AtomicBool>,
    ) {
        let mut buffer = [0u8; READ_BUF];
        let id = terminal_id.clone();
        // ADR-002.5: DA filter — intercepts DA queries and responds to PTY writer
        let mut da_filter = crate::pty::DaFilter::new();
        // Clone writer Arc for the DA filter respond closure
        let da_writer = instance.writer.clone();

        log::info!("[PTY {}] Reader thread starting", id);

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    log::info!("[PTY {}] EOF reached, reader thread exiting", id);
                    break;
                }
                Ok(n) => {
                    instance.update_activity();

                    // Parse exit codes from output
                    let data_str = String::from_utf8_lossy(&buffer[..n]);
                    exit_code_tracker.process_data(&id, &data_str);

                    log::trace!("[PTY {}] Read {} bytes", id, n);

                    // ADR-002.5: Run DA filter to intercept DA queries.
                    // Responds directly to PTY writer so the shell gets immediate feedback
                    // without waiting for xterm.js to initialize.
                    let mut filtered = Vec::with_capacity(n);
                    let w = da_writer.clone();
                    da_filter.process(&buffer[..n], &mut filtered, move |reply| {
                        let mut writer_guard = w.blocking_lock();
                        if let Some(writer) = writer_guard.as_mut() {
                            let _ = writer.write_all(reply);
                            let _ = writer.flush();
                        }
                    });

                    // Push filtered (DA-processed) bytes to pending buffer
                    let mut guard = match pending_buf.lock() {
                        Ok(g) => g,
                        Err(e) => {
                            log::error!("[PTY {}] Pending buffer mutex poisoned: {}", id, e);
                            break;
                        }
                    };

                    if guard.len() + filtered.len() > MAX_PENDING {
                        // Overflow: clear buffer and insert notice
                        guard.clear();
                        guard.extend_from_slice(OVERFLOW_NOTICE);
                        log::warn!("[PTY {}] Output buffer overflow — dropped data", id);
                    } else {
                        guard.extend_from_slice(&filtered);
                    }
                }
                Err(e) => {
                    log::error!("[PTY {}] Error reading from PTY: {}", id, e);
                    break;
                }
            }
        }

        // Signal flusher that reader is done
        done_flag.store(true, Ordering::Release);

        // Get real child exit status where possible.
        let exit_code = match instance.child.try_lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        let code_u32 = status.exit_code();
                        i32::try_from(code_u32).ok()
                    }
                    Ok(None) => None,
                    Err(e) => {
                        log::warn!("[PTY {}] Failed to query child exit status: {}", id, e);
                        None
                    }
                },
                None => None,
            },
            Err(_) => None,
        };

        terminal_events.emit(TerminalEvent::Exit {
            terminal_id: id.clone(),
            exit_code,
            signal: None,
        });

        log::info!("[PTY {}] Reader thread ended", id);
    }

    /// ADR-002.3: Flusher thread — batched Channel output at FLUSH_INTERVAL.
    /// Takes pending buffer via std::mem::take every 4ms and sends via binary channel.
    /// If on_data is None, skips sending (just drains).
    ///
    /// broadcast_tx: per-terminal broadcast channel. When present, each flushed
    /// batch is also sent so remote WebSocket clients receive live output.
    /// Send failures are ignored (no active remote subscribers is normal).
    ///
    /// output_log: sequence-aware bounded history. Each batch is appended before
    /// broadcasting, so attach can snapshot and subscribe under the same lock.
    #[allow(clippy::too_many_arguments)]
    fn flusher_loop(
        pending_buf: Arc<Mutex<Vec<u8>>>,
        done_flag: Arc<AtomicBool>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<TerminalOutputChunk>>,
        output_log: Arc<RwLock<std::collections::VecDeque<TerminalOutputChunk>>>,
        output_log_bytes: Arc<AtomicUsize>,
        next_output_seq: Arc<AtomicU64>,
        on_data: Option<Channel<Response>>,
        terminal_id: String,
    ) {
        let id = terminal_id;
        log::info!("[PTY {}] Flusher thread starting", id);

        let channel_ref: Option<&Channel<Response>> = on_data.as_ref();

        fn publish(
            data: Vec<u8>,
            tx: &tokio::sync::broadcast::Sender<TerminalOutputChunk>,
            log: &Arc<RwLock<std::collections::VecDeque<TerminalOutputChunk>>>,
            bytes: &Arc<AtomicUsize>,
            next_seq: &Arc<AtomicU64>,
        ) {
            let chunk = TerminalOutputChunk {
                seq: next_seq.fetch_add(1, Ordering::Relaxed) + 1,
                data,
            };
            let mut guard = log.write();
            let mut total = bytes.load(Ordering::Relaxed) + chunk.data.len();
            guard.push_back(chunk.clone());
            while total > SCROLLBACK_CAP {
                let Some(evicted) = guard.pop_front() else {
                    break;
                };
                total = total.saturating_sub(evicted.data.len());
            }
            bytes.store(total, Ordering::Relaxed);
            let _ = tx.send(chunk);
        }

        loop {
            std::thread::sleep(FLUSH_INTERVAL);

            let chunk = match pending_buf.lock() {
                Ok(mut guard) if !guard.is_empty() => Some(std::mem::take(&mut *guard)),
                _ => None,
            };

            if let Some(data) = chunk {
                publish(
                    data.clone(),
                    &broadcast_tx,
                    &output_log,
                    &output_log_bytes,
                    &next_output_seq,
                );

                // Forward to Tauri frontend channel (may be None for detached terminals)
                if let Some(ch) = channel_ref {
                    if let Err(e) = ch.send(Response::new(data)) {
                        log::error!("[PTY {}] Failed to send data via channel: {}", id, e);
                    }
                }
            }

            if done_flag.load(Ordering::Acquire) {
                // One final broadcast of anything still buffered
                if let Ok(mut guard) = pending_buf.lock() {
                    if !guard.is_empty() {
                        let final_data = std::mem::take(&mut *guard);
                        publish(
                            final_data.clone(),
                            &broadcast_tx,
                            &output_log,
                            &output_log_bytes,
                            &next_output_seq,
                        );
                        if let Some(ch) = channel_ref {
                            if let Err(e) = ch.send(Response::new(final_data)) {
                                log::error!(
                                    "[PTY {}] Failed to send final data via channel: {}",
                                    id,
                                    e
                                );
                            }
                        }
                    }
                }
                break;
            }
        }

        log::info!("[PTY {}] Flusher thread ended", id);
    }
}
