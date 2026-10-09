use super::*;

// Idle timeout for an agent turn: if the agent produces NO activity (no
// `session/update`/`tool_call` notification) for this long, the turn is
// considered wedged and is cancelled. The default is **unlimited** (`None` —
// see `turn_idle_timeout`): a silent/wedged turn is NOT killed by default;
// only an explicit `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS` env var or an App
// Preferences value imposes an idle bound. Reset on every inbound notification
// via `DriverState::signal_idle`.
//
// The historical 900s (15min) default was retired in favour of unlimited — a
// legitimate long-running silent sub-tool (a ~600s shell command) no longer
// races an arbitrary idle deadline, and a truly wedged turn is left to the
// operator/user to cancel (or to bound explicitly via the env var).
// The default hard wall-clock cap for a single agent turn is **unlimited**
// (`None` — see `resolved_turn_timeout`): no last-resort backstop is imposed
// unless the operator sets `TERMUL_ACP_TURN_TIMEOUT_SECS` or the user picks a
// bounded value in App Preferences. The per-turn *idle* timeout
// (`turn_idle_timeout`) is also unlimited by default, so neither a chatty
// nor a silent agent is killed by default — the hard cap is an opt-in
// diagnostic backstop. On either idle or hard timeout → cancel +
// `CANCEL_GRACE` → `status: 'error'`. Distinct from 1.7's 60s permission
// sub-timeout (`permissions.rs:47`).

/// `session/new` timeout. Precedence: `TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS`
/// (env, operator/diagnostic; seconds, must be > 0) → in-process UI override
/// ([`set_session_new_timeout_override`]) → [`SESSION_NEW_TIMEOUT`]. Useful
/// when an agent needs longer to fetch its model list on a cold start; the
/// default stays strict so a wedged agent still fails fast in normal use.
pub(super) fn session_new_timeout() -> Duration {
    std::env::var("TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .or_else(|| {
            session_new_timeout_override()
                .filter(|secs| *secs > 0)
                .map(Duration::from_secs)
        })
        .unwrap_or(SESSION_NEW_TIMEOUT)
}

/// `session/load` / `session/resume` timeout. Precedence:
/// `TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` (env, operator/diagnostic;
/// seconds, must be > 0) → in-process UI override
/// ([`set_session_reopen_timeout_override`]) → [`SESSION_REOPEN_TIMEOUT`]. A
/// load replays the full conversation before responding, so very large
/// histories may need a longer budget.
pub(super) fn session_reopen_timeout() -> Duration {
    std::env::var("TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .or_else(|| {
            session_reopen_timeout_override()
                .filter(|secs| *secs > 0)
                .map(Duration::from_secs)
        })
        .unwrap_or(SESSION_REOPEN_TIMEOUT)
}

/// Per-turn idle timeout. Precedence: `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`
/// (env, operator/diagnostic; seconds, must be > 0) → in-process UI override
/// ([`set_turn_idle_timeout_override`]) → `None` (**unlimited** default). `None`
/// means a silent/wedged turn is NOT killed by the idle timer — only completion,
/// cancel, or an explicitly configured idle/hard bound ends it. The window, when
/// set, is the duration with no agent activity after which a turn is considered
/// wedged.
pub fn turn_idle_timeout() -> Option<Duration> {
    std::env::var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .or_else(|| {
            turn_idle_timeout_override()
                .filter(|secs| *secs > 0)
                .map(Duration::from_secs)
        })
}

/// In-process override for the hard wall-clock cap, set by the
/// `acp_set_turn_timeout` Tauri command from the App Preferences UI. `None` =
/// use the env var / default. Consulted by [`resolved_turn_timeout`] so a UI
/// change takes effect on the next turn without a restart. Desktop-only: the
/// standalone server has no settings surface and configures via
/// `TERMUL_ACP_TURN_TIMEOUT_SECS` (the operator env var still wins — see the
/// precedence in [`resolved_turn_timeout`]).
pub(super) static TURN_TIMEOUT_OVERRIDE: LazyLock<parking_lot::Mutex<Option<u64>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));

/// Set the in-process turn-timeout override (secs, or `None` to clear). Called
/// by the `acp_set_turn_timeout` Tauri command (desktop renderer settings).
pub fn set_turn_timeout_override(secs: Option<u64>) {
    *TURN_TIMEOUT_OVERRIDE.lock() = secs;
}

/// Read the in-process turn-timeout override, if set.
pub fn turn_timeout_override() -> Option<u64> {
    *TURN_TIMEOUT_OVERRIDE.lock()
}

/// In-process override for the per-turn idle timeout, set by the
/// `acp_set_turn_idle_timeout` Tauri command from the App Preferences UI.
/// `None` = use the env var / default. Same desktop-only contract and
/// precedence shape as [`TURN_TIMEOUT_OVERRIDE`] (the operator env var still
/// wins — see [`turn_idle_timeout`]).
pub(super) static TURN_IDLE_TIMEOUT_OVERRIDE: LazyLock<parking_lot::Mutex<Option<u64>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));
/// In-process override for the `session/new` timeout, set by the
/// `acp_set_session_new_timeout` Tauri command. Same contract as
/// [`TURN_TIMEOUT_OVERRIDE`] (see [`session_new_timeout`]).
pub(super) static SESSION_NEW_TIMEOUT_OVERRIDE: LazyLock<parking_lot::Mutex<Option<u64>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));
/// In-process override for the `session/load` / `session/resume` timeout, set
/// by the `acp_set_session_reopen_timeout` Tauri command. Same contract as
/// [`TURN_TIMEOUT_OVERRIDE`] (see [`session_reopen_timeout`]).
pub(super) static SESSION_REOPEN_TIMEOUT_OVERRIDE: LazyLock<parking_lot::Mutex<Option<u64>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));
/// Set the in-process turn-idle-timeout override (secs > 0, or `None` to
/// clear). Called by the `acp_set_turn_idle_timeout` Tauri command.
pub fn set_turn_idle_timeout_override(secs: Option<u64>) {
    *TURN_IDLE_TIMEOUT_OVERRIDE.lock() = secs;
}

/// Read the in-process turn-idle-timeout override, if set.
pub(super) fn turn_idle_timeout_override() -> Option<u64> {
    *TURN_IDLE_TIMEOUT_OVERRIDE.lock()
}

/// Set the in-process `session/new` timeout override (secs > 0, or `None` to
/// clear). Called by the `acp_set_session_new_timeout` Tauri command.
pub fn set_session_new_timeout_override(secs: Option<u64>) {
    *SESSION_NEW_TIMEOUT_OVERRIDE.lock() = secs;
}

/// Read the in-process `session/new` timeout override, if set.
pub(super) fn session_new_timeout_override() -> Option<u64> {
    *SESSION_NEW_TIMEOUT_OVERRIDE.lock()
}

/// Set the in-process session-reopen timeout override (secs > 0, or `None` to
/// clear). Called by the `acp_set_session_reopen_timeout` Tauri command.
pub fn set_session_reopen_timeout_override(secs: Option<u64>) {
    *SESSION_REOPEN_TIMEOUT_OVERRIDE.lock() = secs;
}

/// Read the in-process session-reopen timeout override, if set.
pub(super) fn session_reopen_timeout_override() -> Option<u64> {
    *SESSION_REOPEN_TIMEOUT_OVERRIDE.lock()
}

/// Hard wall-clock cap per turn. Precedence: `TERMUL_ACP_TURN_TIMEOUT_SECS`
/// (env, operator/diagnostic; seconds, must be > 0) → in-process UI override
/// ([`set_turn_timeout_override`]) → `None` (**unlimited** default). `None`
/// means no hard backstop is imposed — the per-turn *idle* timeout
/// ([`turn_idle_timeout`]) still bounds silent/wedged turns, so a chatty agent
/// that stays active is not killed by default. An operator who wants a bounded
/// hard cap sets the env var, or the user picks a value in App Preferences.
pub fn resolved_turn_timeout() -> Option<Duration> {
    std::env::var("TERMUL_ACP_TURN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .or_else(|| {
            turn_timeout_override()
                .filter(|secs| *secs > 0)
                .map(Duration::from_secs)
        })
}

/// Race an in-flight ACP prompt turn against completion, a cancel signal, an
/// optional idle deadline (reset on agent activity via `idle_rx`), and an
/// optional hard wall-clock cap. On idle/hard timeout, invoke `on_timeout_cancel`
/// (the caller's cancel hook — updates DriverState cancel/timeout state so the
/// in-flight turn winds down), await `CANCEL_GRACE`, then return a typed timeout
/// error. Extracted so the deadline loop is unit-testable with mock futures. A
/// pre-iteration deadline check bounds a continuously-ready activity arm (under
/// `biased`) so a streaming-but-non-completing agent can't slip past a cap. When
/// a deadline is `None` (the unlimited default for idle and/or hard), it imposes
/// no bound — a fully-unlimited turn (both `None`) is ended only by completion or
/// cancel, so a wedged agent is NOT killed by default.
pub(super) async fn race_turn<P, E>(
    prompt: P,
    mut cancel_rx: oneshot::Receiver<()>,
    idle_rx: &mut watch::Receiver<()>,
    on_timeout_cancel: impl Fn(),
    idle: Option<Duration>,
    hard: Option<Duration>,
) -> Result<StopReason, E>
where
    P: Future<Output = Result<StopReason, E>>,
    E: From<String>,
{
    tokio::pin!(prompt);
    let hard_deadline = hard.map(|d| tokio::time::Instant::now() + d);
    let mut idle_deadline = idle.map(|d| tokio::time::Instant::now() + d);
    loop {
        // Next deadline: the earliest of the configured (Some) deadlines; `None`
        // when neither idle nor hard is configured (fully unlimited).
        let next_deadline = match (idle_deadline, hard_deadline) {
            (Some(i), Some(h)) => Some(i.min(h)),
            (Some(i), None) => Some(i),
            (None, Some(h)) => Some(h),
            (None, None) => None,
        };
        // Pre-select check: under `biased`, a continuously-ready activity arm
        // would win every poll and `sleep_until` would never fire — silently
        // defeating the cap(s) for a streaming-but-non-completing agent.
        if let Some(nd) = next_deadline {
            if tokio::time::Instant::now() >= nd {
                on_timeout_cancel();
                return match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                    Ok(result) => result,
                    Err(_) if idle_deadline == Some(nd) => {
                        let idle_dur = idle.unwrap_or(Duration::ZERO);
                        Err(E::from(format!(
                            "turn idle timeout: no agent activity for {idle_dur:?}"
                        )))
                    }
                    Err(_) => {
                        let hard_dur = hard.unwrap_or(Duration::ZERO);
                        Err(E::from(format!("turn hard timeout: exceeded {hard_dur:?}")))
                    }
                };
            }
        }
        match next_deadline {
            Some(nd) => {
                tokio::select! {
                    biased;
                    result = &mut prompt => return result,
                    _ = &mut cancel_rx => {
                        return match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                            Ok(result) => result,
                            Err(_) => Ok(StopReason::Cancelled),
                        };
                    }
                    _ = idle_rx.changed() => {
                        if let Some(d) = idle {
                            idle_deadline = Some(tokio::time::Instant::now() + d);
                        }
                    }
                    _ = tokio::time::sleep_until(nd) => {}
                }
            }
            None => {
                // No deadlines (fully unlimited): only completion or cancel can
                // end the turn. The `idle_rx` arm is intentionally absent —
                // there is no deadline to reset, and a closed watch channel
                // would otherwise return `Err` ready on every poll and busy-loop
                // (starving the runtime). If a deadline is later configured it
                // routes through the `Some` branch above, where the idle arm
                // resets the idle deadline.
                tokio::select! {
                    biased;
                    result = &mut prompt => return result,
                    _ = &mut cancel_rx => {
                        return match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                            Ok(result) => result,
                            Err(_) => Ok(StopReason::Cancelled),
                        };
                    }
                }
            }
        }
    }
}
