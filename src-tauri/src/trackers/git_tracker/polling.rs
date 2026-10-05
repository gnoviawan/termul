use super::*;

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WindowsPollTarget {
    cwd: String,
    terminal_ids: Vec<String>,
}

/// Guard that resets is_polling flag when dropped (RAII pattern)
pub(super) struct PollingGuard {
    is_polling: Arc<AtomicBool>,
}

impl PollingGuard {
    pub(super) fn new(is_polling: Arc<AtomicBool>) -> Option<Self> {
        // Try to acquire the lock - return None if already polling
        if !is_polling.swap(true, Ordering::SeqCst) {
            Some(Self { is_polling })
        } else {
            None
        }
    }
}

impl Drop for PollingGuard {
    fn drop(&mut self) {
        self.is_polling.store(false, Ordering::SeqCst);
    }
}

impl GitTracker {
    /// Start the polling task
    ///
    /// Windows optimizations:
    /// - Uses CWD deduplication: polls once per unique CWD, fans out results
    /// - Implements cooldown when status hasn't changed
    /// - Uses RAII guard to ensure is_polling flag is always reset
    pub(super) fn start_polling(&self) {
        let states = self.terminal_states.clone();
        let is_visible = self.is_visible.clone();
        #[cfg(target_os = "windows")]
        let cwd_poll_states = self.cwd_poll_states.clone();
        let app_handle = self.app_handle.clone();
        let cwd_tracker = self.cwd_tracker.clone();
        let events = self.events.clone();
        let poll_handle = self.poll_handle.clone();

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));

            // Create is_polling flag for guard mechanism
            let is_polling = Arc::new(AtomicBool::new(false));

            #[cfg(target_os = "windows")]
            let mut tick_count = 0u32;

            loop {
                interval.tick().await;

                #[cfg(target_os = "windows")]
                {
                    tick_count += 1;
                    log::trace!(
                        "[GitTracker] Tick: {}, visible: {}",
                        tick_count,
                        is_visible.load(Ordering::SeqCst)
                    );
                }

                // Skip when not visible
                if !is_visible.load(Ordering::SeqCst) {
                    log::debug!("[GitTracker] Skipping poll - window not visible");
                    continue;
                }

                #[cfg(target_os = "windows")]
                {
                    // On Windows, only poll every Nth tick (throttling)
                    if !tick_count.is_multiple_of(WINDOWS_POLL_MULTIPLIER) {
                        log::trace!(
                            "[GitTracker] Skipping poll - throttling (tick {})",
                            tick_count
                        );
                        continue;
                    }
                    log::debug!("[GitTracker] Polling tick: {}", tick_count);
                }

                // Use RAII guard - automatically resets is_polling when dropped
                let guard_opt = PollingGuard::new(is_polling.clone());
                let _guard = match guard_opt {
                    Some(g) => g,
                    None => continue, // Already polling
                };

                if let Some(cwd_tracker) = &cwd_tracker {
                    Self::sync_terminal_cwds_from_tracker_direct(cwd_tracker, &states);
                } else if let Some(app_handle) = &app_handle {
                    Self::sync_terminal_cwds_from_tracker(app_handle, &states);
                }
                #[cfg(target_os = "windows")]
                Self::prune_unused_cwd_poll_states(&states, &cwd_poll_states);

                #[cfg(target_os = "windows")]
                {
                    // Windows: CWD deduplication strategy
                    // Group terminals by CWD, poll once per unique CWD, then fan out results
                    let cwd_states: HashMap<String, Vec<String>> = {
                        let states_read = states.read();
                        let mut map: HashMap<String, Vec<String>> = HashMap::new();
                        for (id, state) in states_read.iter() {
                            map.entry(state.last_known_cwd.clone())
                                .or_default()
                                .push(id.clone());
                        }
                        map
                    };

                    let now = Instant::now();
                    let poll_targets: Vec<WindowsPollTarget> = {
                        let mut cwd_poll_states_write = cwd_poll_states.write();
                        let mut targets = Vec::new();

                        for (cwd, terminal_ids) in cwd_states {
                            let poll_state = cwd_poll_states_write.entry(cwd.clone()).or_default();

                            let cooldown_ms = if poll_state.last_snapshot_unchanged {
                                STATUS_UNCHANGED_COOLDOWN_MS
                            } else {
                                POLL_INTERVAL_MS
                            };

                            let elapsed = now.duration_since(poll_state.last_checked);
                            if elapsed < Duration::from_millis(cooldown_ms) {
                                log::trace!(
                                    "[GitTracker] CWD '{}' on cooldown: {:?} remaining",
                                    cwd,
                                    Duration::from_millis(cooldown_ms) - elapsed
                                );
                                continue;
                            }

                            log::debug!(
                                "[GitTracker] Polling CWD: {} ({} terminals)",
                                cwd,
                                terminal_ids.len()
                            );
                            poll_state.last_checked = now;
                            targets.push(WindowsPollTarget { cwd, terminal_ids });
                        }

                        targets
                    };

                    for target in poll_targets {
                        let (new_status, new_branch) =
                            Self::poll_git_snapshot(target.cwd.clone()).await;

                        {
                            let mut cwd_poll_states_write = cwd_poll_states.write();
                            if let Some(poll_state) = cwd_poll_states_write.get_mut(&target.cwd) {
                                poll_state.last_snapshot_unchanged =
                                    poll_state.last_status.as_ref() == new_status.as_ref()
                                        && poll_state.last_branch.as_ref() == new_branch.as_ref();
                                poll_state.last_branch = new_branch.clone();
                                poll_state.last_status = new_status.clone();
                            }
                        }

                        let (branch_emits, status_emits) = Self::apply_git_results(
                            &states,
                            &target.terminal_ids,
                            new_branch,
                            new_status,
                        );

                        for (terminal_id, branch) in branch_emits {
                            Self::emit_branch_changed_static(&events, &terminal_id, &branch);
                        }

                        for (terminal_id, status) in status_emits {
                            Self::emit_status_changed_static(&events, &terminal_id, &status);
                        }
                    }
                }

                #[cfg(not(target_os = "windows"))]
                {
                    let terminals: Vec<(String, String)> = states
                        .read()
                        .iter()
                        .map(|(id, state)| (id.clone(), state.last_known_cwd.clone()))
                        .collect();

                    for (terminal_id, cwd) in terminals {
                        let (new_status, new_branch) = Self::poll_git_snapshot(cwd).await;
                        let terminal_ids = vec![terminal_id.clone()];
                        let (branch_emits, status_emits) =
                            Self::apply_git_results(&states, &terminal_ids, new_branch, new_status);

                        for (_, branch) in branch_emits {
                            Self::emit_branch_changed_static(&events, &terminal_id, &branch);
                        }

                        for (_, status) in status_emits {
                            Self::emit_status_changed_static(&events, &terminal_id, &status);
                        }
                    }
                }
            }
        });

        // Store the handle using RwLock write lock
        let mut poll_handle_guard = poll_handle.write();
        *poll_handle_guard = Some(handle);
    }

    /// Check the git branch for a directory
    ///
    /// Runs `git rev-parse --abbrev-ref HEAD` and returns the branch name.
    /// Returns None if not in a git repository or in detached HEAD state.
    pub(super) fn check_branch_internal(cwd: &str) -> Option<String> {
        let output = Self::run_git_command(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;

        if !output.status.success() {
            return None;
        }

        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // HEAD indicates detached HEAD state - treat as no branch
        if branch == "HEAD" {
            None
        } else {
            Some(branch)
        }
    }

    /// Check the git status for a directory
    ///
    /// Runs `git status --porcelain` and `git rev-list --left-right --count HEAD...@{u}`
    /// and returns parsed status.
    /// Returns None if not in a git repository.
    pub(super) fn check_status_internal(cwd: &str) -> Option<GitStatus> {
        log::debug!("[GitTracker] Polling git status for cwd: {}", cwd);
        let output = Self::run_git_command(cwd, &["status", "--porcelain"])?;

        if !output.status.success() {
            return None;
        }

        let mut status = Self::parse_git_status(&String::from_utf8_lossy(&output.stdout));

        log::debug!("[GitTracker] Fetching ahead/behind for cwd: {}", cwd);
        // Get ahead/behind count
        if let Some(rev_output) =
            Self::run_git_command(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        {
            if rev_output.status.success() {
                let counts = String::from_utf8_lossy(&rev_output.stdout);
                let parts: Vec<&str> = counts.split_whitespace().collect();
                if parts.len() == 2 {
                    status.ahead = parts[0].parse().unwrap_or(0);
                    status.behind = parts[1].parse().unwrap_or(0);
                    log::debug!(
                        "[GitTracker] CWD: {}, ahead: {}, behind: {}",
                        cwd,
                        status.ahead,
                        status.behind
                    );
                }
            } else {
                log::debug!(
                    "[GitTracker] rev-list failed (possibly no upstream): {}",
                    String::from_utf8_lossy(&rev_output.stderr)
                );
            }
        }

        Some(status)
    }

    /// Parse git status --porcelain output
    ///
    /// Format: XY filename
    /// - X = index status
    /// - Y = work tree status
    ///
    /// ?? = untracked
    /// M/D in workTreeStatus = modified
    /// indexStatus not space/? = staged
    pub(super) fn parse_git_status(output: &str) -> GitStatus {
        let mut status = GitStatus::new();

        for line in output.lines() {
            if line.len() < 2 {
                continue;
            }

            let chars: Vec<char> = line.chars().collect();
            let index_status = chars[0];
            let work_tree_status = chars[1];

            if line.starts_with("??") {
                // Untracked files
                status.untracked += 1;
            } else {
                // Working tree modifications (M = modified, D = deleted)
                if work_tree_status == 'M' || work_tree_status == 'D' {
                    status.modified += 1;
                }

                // Staged changes (anything in index that's not space or ?)
                if index_status != ' ' && index_status != '?' {
                    status.staged += 1;
                }
            }
        }

        status.has_changes = status.modified + status.staged + status.untracked > 0;

        status
    }

    /// Static version of emit_branch_changed for use in async context
    pub(super) fn emit_branch_changed_static(
        events: &TerminalEventHub,
        terminal_id: &str,
        branch: &Option<String>,
    ) {
        events.emit(TerminalEvent::GitBranchChanged {
            terminal_id: terminal_id.to_string(),
            branch: branch.clone(),
        });
    }

    /// Static version of emit_status_changed for use in async context
    pub(super) fn emit_status_changed_static(
        events: &TerminalEventHub,
        terminal_id: &str,
        status: &Option<GitStatus>,
    ) {
        events.emit(TerminalEvent::GitStatusChanged {
            terminal_id: terminal_id.to_string(),
            status: status.clone(),
        });
    }
}
