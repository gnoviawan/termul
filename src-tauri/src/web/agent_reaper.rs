//! The one idle ACP-agent reaper per host process (issue #837).
//!
//! Reload-heavy usage leaks agent processes: every page load can spawn a fresh
//! agent, and nothing stops them once the client that created them is gone.
//! The host owns that lifecycle: the standalone `termul-server` (`serve`) and
//! the desktop app (`lib.rs` setup) each start exactly one reaper over their
//! `AcpManager`. The live window is [`resolved_agent_idle_window`]: the server
//! locks the value from its flag, env var, or the 30-minute default; the
//! desktop reads `$TERMUL_AGENT_IDLE_REAP_SECS` and, when that variable is
//! unset, accepts the App Preferences override on the next sweep.
//!
//! An agent is reaped only when the host itself saw no sign of life:
//!
//! - no running prompt turn,
//! - no unanswered permission, question or elicitation,
//! - no running agent-owned ACP terminal ("reported background work"),
//! - no session reopen in flight, and
//! - `last_active_at` (turn start/end, session updates, ticket
//!   register/resolve, prompt send) is at least one whole window old.
//!
//! Connections, subscriptions, presence, tabs and renderer references never
//! feed the decision: a disconnect never reaps, and an open viewer never pins.
//! Ephemeral sessions (warm-pool seeds) are disposed first, then the agent is
//! re-probed immediately before the stop and left alone if anything happened
//! meanwhile. The stop is announced to every sink as `session_closed` per live
//! session then `agent_disconnected{reason: reaped}`.
//!
//! Deliberately NOT started from `serve_router` / `remote/host.rs`: the
//! desktop's shared-live toggle calls that function with the desktop's own
//! live agents in the same manager, so the desktop host starts its reaper once
//! at startup instead.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::acp::{AcpManager, AgentId, SessionId};
use crate::web::config::DEFAULT_AGENT_IDLE_WINDOW_SECS;

const LOG_TARGET: &str = "termul::web::agent_reaper";

/// Default sweep cadence: each sweep re-probes every live agent.
pub(crate) const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Shutdown signal for the reaper loop (`serve` resolves it on SIGINT/SIGTERM).
pub type ShutdownSignal = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Whether the agent is quiet right now: probe it and apply the reap rule.
/// `false` when the agent is gone (nothing left to stop) or the probe fails.
async fn is_quiet(
    acp: &Arc<AcpManager>,
    agent_id: &AgentId,
    now: Instant,
    window: Duration,
) -> bool {
    match acp.agent_activity(agent_id).await {
        Ok(activity) => activity.is_reapable(now, window),
        Err(error) => {
            log::debug!(target: LOG_TARGET, "idle reaper: probe of agent {} failed: {error}", agent_id.0);
            false
        }
    }
}

/// Dispose the agent's ephemeral sessions (durable ones need nothing; the
/// process stop releases them). `false` when any disposal could not be
/// confirmed — the agent is then left for the next sweep, since a failure
/// means its state changed (a prompt arrived, or it was promoted).
async fn dispose_ephemeral_sessions(acp: &Arc<AcpManager>, agent_id: &AgentId) -> bool {
    let session_ids = match acp.agent_session_ids(agent_id).await {
        Ok(ids) => ids,
        Err(error) => {
            log::warn!(
                target: LOG_TARGET,
                "idle reaper: session listing of agent {} failed ({error}); deferring to the next sweep",
                agent_id.0
            );
            return false;
        }
    };
    for session_id in session_ids {
        match acp
            .is_ephemeral_session(agent_id, SessionId(session_id.clone()))
            .await
        {
            Ok(false) => continue,
            Ok(true) => {}
            Err(error) => {
                log::warn!(
                    target: LOG_TARGET,
                    "idle reaper: ephemeral check on agent {} failed ({error}); deferring to the next sweep",
                    agent_id.0
                );
                return false;
            }
        }
        if let Err(error) = acp
            .dispose_ephemeral_session(agent_id, SessionId(session_id))
            .await
        {
            log::warn!(
                target: LOG_TARGET,
                "idle reaper: ephemeral disposal on agent {} failed ({error}); deferring to the next sweep",
                agent_id.0
            );
            return false;
        }
    }
    true
}

/// One reaper sweep over every live agent. `now` is the sweep's clock reading;
/// an agent is reaped only if it is quiet for the whole `window` as of `now`
/// both at the first probe and again right before the stop. Returns the agent
/// ids reaped (logged by the caller).
pub(crate) async fn reap_idle_agents(
    acp: &Arc<AcpManager>,
    now: Instant,
    window: Duration,
) -> Vec<AgentId> {
    let mut reaped = Vec::new();
    for agent_id in acp.list_agents() {
        if !is_quiet(acp, &agent_id, now, window).await {
            continue;
        }
        if !dispose_ephemeral_sessions(acp, &agent_id).await {
            continue;
        }
        // The probe above and the disposals awaited since give a prompt, an
        // approval request or a reopen time to land; killing on the stale
        // snapshot would stop a now-active agent mid-turn.
        if !is_quiet(acp, &agent_id, now, window).await {
            log::debug!(
                target: LOG_TARGET,
                "idle reaper: agent {} became active before the stop; keeping it",
                agent_id.0
            );
            continue;
        }
        match acp.reap_agent(&agent_id).await {
            Ok(()) => {
                log::info!(
                    target: LOG_TARGET,
                    "idle reaper stopped agent {} (no activity for {}s)",
                    agent_id.0,
                    window.as_secs()
                );
                reaped.push(agent_id);
            }
            Err(error) => {
                log::warn!(
                    target: LOG_TARGET,
                    "idle reaper failed to stop agent {}: {error}; retrying next sweep",
                    agent_id.0
                );
            }
        }
    }
    reaped
}

/// Run the reaper loop until `shutdown` resolves. Exported for the hosts (and
/// directly testable with an injected window + tiny sweep interval). `window`
/// is read on every sweep, so a settings change applies on the next tick.
pub async fn run_agent_idle_reaper(
    acp: Arc<AcpManager>,
    window: impl Fn() -> Duration + Send + 'static,
    sweep_interval: Duration,
    mut shutdown: ShutdownSignal,
) {
    let mut tick = tokio::time::interval(sweep_interval.max(Duration::from_millis(1)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = shutdown.as_mut() => {
                log::info!(target: LOG_TARGET, "idle agent reaper shutting down");
                return;
            }
            _ = tick.tick() => {
                let reaped = reap_idle_agents(&acp, Instant::now(), window()).await;
                if !reaped.is_empty() {
                    log::info!(
                        target: LOG_TARGET,
                        "idle agent reaper sweep stopped {} agent(s)",
                        reaped.len()
                    );
                }
            }
        }
    }
}

/// Spawn the reaper on the current runtime. `window` is read on every sweep.
pub fn spawn_agent_idle_reaper(
    acp: Arc<AcpManager>,
    window: impl Fn() -> Duration + Send + 'static,
    shutdown: ShutdownSignal,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run_agent_idle_reaper(
        acp,
        window,
        DEFAULT_SWEEP_INTERVAL,
        shutdown,
    ))
}

/// A running reaper plus its stop signal, for hosts that must stop it at exit
/// (the desktop keeps one as managed state). Stopping before `kill_all` keeps a
/// late sweep from racing the process-shutdown teardown.
pub struct AgentReaperHandle {
    running: parking_lot::Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::task::JoinHandle<()>,
        )>,
    >,
}

impl AgentReaperHandle {
    /// Start the reaper on `runtime` (the desktop `setup` hook is not inside a
    /// Tokio context, so the runtime is passed explicitly).
    #[must_use]
    pub fn start(
        acp: Arc<AcpManager>,
        window: impl Fn() -> Duration + Send + 'static,
        runtime: &tokio::runtime::Handle,
    ) -> Self {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let join = runtime.spawn(run_agent_idle_reaper(
            acp,
            window,
            DEFAULT_SWEEP_INTERVAL,
            Box::pin(async move {
                let _ = stop_rx.await;
            }),
        ));
        Self {
            running: parking_lot::Mutex::new(Some((stop_tx, join))),
        }
    }

    /// Stop the reaper and wait for its loop to end. Idempotent.
    pub async fn stop(&self) {
        let running = self.running.lock().take();
        if let Some((stop_tx, join)) = running {
            let _ = stop_tx.send(());
            let _ = join.await;
        }
    }
}

/// The idle window the host is using right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdleWindowStatus {
    pub secs: u64,
    /// `env` when `$TERMUL_AGENT_IDLE_REAP_SECS` is set, `operator` when the
    /// server locked its startup value, `setting` when App Preferences applies,
    /// `default` for the 30-minute default.
    pub source: &'static str,
}

struct IdleWindowState {
    baseline_secs: u64,
    /// `Some("env" | "operator")` keeps [`IdleWindowState::baseline_secs`] as
    /// the live window. `None` lets the App Preferences override apply.
    lock: Option<&'static str>,
    ui_override_secs: Option<u64>,
}

impl Default for IdleWindowState {
    fn default() -> Self {
        Self {
            baseline_secs: DEFAULT_AGENT_IDLE_WINDOW_SECS,
            lock: None,
            ui_override_secs: None,
        }
    }
}

/// A log label chosen here, never the caller's string.
fn idle_window_log_source(source: &str) -> &'static str {
    match source {
        "env" => "env",
        "operator" => "operator",
        "setting" => "setting",
        _ => "default",
    }
}

fn resolve_idle_window(state: &IdleWindowState) -> AgentIdleWindowStatus {
    let baseline = if state.baseline_secs == 0 {
        DEFAULT_AGENT_IDLE_WINDOW_SECS
    } else {
        state.baseline_secs
    };
    if let Some(source) = state.lock {
        return AgentIdleWindowStatus {
            secs: baseline,
            source,
        };
    }
    if let Some(secs) = state.ui_override_secs.filter(|secs| *secs > 0) {
        return AgentIdleWindowStatus {
            secs,
            source: "setting",
        };
    }
    AgentIdleWindowStatus {
        secs: baseline,
        source: "default",
    }
}

static IDLE_WINDOW: std::sync::LazyLock<parking_lot::Mutex<IdleWindowState>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(IdleWindowState::default()));

/// Serializes tests that mutate [`IDLE_WINDOW`]. Cargo runs test threads in
/// parallel, and the router test and the precedence test share this static.
/// A Tokio mutex so the router test can keep it across `.await` (Clippy
/// rejects a blocking guard there).
#[cfg(test)]
pub(crate) static IDLE_WINDOW_TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Install the process baseline. `lock` is `"env"` or `"operator"` when a
/// later settings override must not change the live window. `None` leaves the
/// window open for App Preferences.
pub fn install_agent_idle_baseline(secs: u64, lock: Option<&'static str>) {
    let baseline = if secs == 0 {
        DEFAULT_AGENT_IDLE_WINDOW_SECS
    } else {
        secs
    };
    {
        let mut state = IDLE_WINDOW.lock();
        state.baseline_secs = baseline;
        state.lock = lock;
    }
    let live = resolved_agent_idle_window();
    // Log only a fixed label. The window length is caller-supplied (flag, env,
    // or Settings) and must not be copied into the log line.
    log::info!(
        target: LOG_TARGET,
        "agent idle window baseline installed: locked={} source={}",
        lock.is_some(),
        idle_window_log_source(live.source)
    );
}

/// Store the App Preferences override (`None` clears it). A locked baseline
/// (env var or server operator config) keeps the live window unchanged.
pub fn set_agent_idle_window_override(secs: Option<u64>) {
    {
        let mut state = IDLE_WINDOW.lock();
        state.ui_override_secs = secs.filter(|value| *value > 0);
    }
    let live = resolved_agent_idle_window();
    // `secs` comes from Settings. Log a fixed label, not that value.
    log::info!(
        target: LOG_TARGET,
        "agent idle window override updated: source={}",
        idle_window_log_source(live.source)
    );
}

/// The window the reaper and the settings probe use.
#[must_use]
pub fn resolved_agent_idle_window() -> AgentIdleWindowStatus {
    resolve_idle_window(&IDLE_WINDOW.lock())
}

/// Closure the desktop and `termul-server` reapers pass so each sweep sees a
/// settings change.
#[must_use]
pub fn live_agent_idle_window() -> Duration {
    Duration::from_secs(resolved_agent_idle_window().secs)
}

#[cfg(test)]
pub(crate) fn reset_agent_idle_window_for_tests() {
    *IDLE_WINDOW.lock() = IdleWindowState::default();
}
