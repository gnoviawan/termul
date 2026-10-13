//! The one idle ACP-agent reaper per host process (issue #837).
//!
//! Reload-heavy usage leaks agent processes: every page load can spawn a fresh
//! agent, and nothing stops them once the client that created them is gone.
//! The host owns that lifecycle: the standalone `termul-server` (`serve`) and
//! the desktop app (`lib.rs` setup) each start exactly one reaper over their
//! `AcpManager`, with one idle window (`ServerConfig.agent_idle_window_secs`).
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

use crate::acp::{AcpManager, AgentId, SessionId};

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
/// directly testable with an injected window + tiny sweep interval).
pub async fn run_agent_idle_reaper(
    acp: Arc<AcpManager>,
    window: Duration,
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
                let reaped = reap_idle_agents(&acp, Instant::now(), window).await;
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

/// Spawn the reaper on the current runtime. `window` is
/// `ServerConfig.agent_idle_window_secs` (flag → env → default).
pub fn spawn_agent_idle_reaper(
    acp: Arc<AcpManager>,
    window: Duration,
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
    pub fn start(acp: Arc<AcpManager>, window: Duration, runtime: &tokio::runtime::Handle) -> Self {
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
