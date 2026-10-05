//! Idle ACP-agent reaper for the standalone `termul-server` (issue #837).
//!
//! Reload-heavy web usage leaks agent processes: every page load can spawn a
//! fresh agent, and nothing on the server side ever stops them once the client
//! that created them is gone (the QA run measured 10 opencode + 7 codex trees,
//! ~7 GB RSS, for 2 chats). The desktop reaps its own agents in the renderer
//! (`use-agent-idle-shutdown`); the standalone server has no renderer, so this
//! task owns the equivalent lifecycle server-side.
//!
//! An agent is reapable when nothing pins it for the whole idle window:
//!
//! - a session with an in-flight prompt turn always pins the agent,
//! - a session with a live WS subscriber always pins the agent,
//! - a durable (non-ephemeral) session with NEITHER is not pinned: the
//!   renderer reloads durable history on a fresh agent, so an idle durable
//!   owner is reaped with its process after the window,
//! - an ephemeral session (warm-pool seed) with none of the above pins nothing
//!   once the idle window lapses — it is disposed, then the agent is stopped.
//!
//! An agent with zero owned sessions (process-only prewarm) is the direct leak
//! shape and reaps after the window.
//!
//! Deliberately NOT wired into `serve_router`: the desktop shared-live host
//! calls that function with the desktop's own live agents in the same manager,
//! and its renderer does not subscribe through the WS relay — a relay-based
//! subscriber check there could stop agents the desktop still uses. The
//! desktop keeps its renderer-driven reaper; only `serve` (standalone binary)
//! spawns this one.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{info, warn};

use crate::acp::{AgentId, AcpManager, SessionId};
use crate::web::sink::WsRelaySink;

/// Default idle window before an agent with no pinning session is reaped
/// (issue #837: "reap after 15 min idle; configurable later").
pub const DEFAULT_IDLE_REAP_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Default sweep cadence: each sweep re-evaluates every live agent's pins.
pub(crate) const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Shutdown signal for the reaper loop (`serve` resolves it on SIGINT/SIGTERM).
pub type ShutdownSignal = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Read the idle reap window from `TERMUL_AGENT_IDLE_REAP_SECS` (operator
/// override + test hook). Falls back to [`DEFAULT_IDLE_REAP_WINDOW`] when
/// unset or unparsable.
#[must_use]
pub fn idle_reap_window_from_env() -> Duration {
    match std::env::var("TERMUL_AGENT_IDLE_REAP_SECS") {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(secs) => Duration::from_secs(secs),
            Err(_) => DEFAULT_IDLE_REAP_WINDOW,
        },
        Err(_) => DEFAULT_IDLE_REAP_WINDOW,
    }
}

/// True when the agent may be reaped now: no owned session pins it. `pins`
/// carries one entry per owned session with its pinned flag (durable,
/// mid-turn, or subscribed). Pure over the observed state so the policy is
/// unit-testable without a real agent process.
#[must_use]
pub fn agent_is_reapable(pins: &[(String, bool)]) -> bool {
    pins.iter().all(|(_, pinned)| !pinned)
}

/// Per-session pin check for one owned session: pinned when the session is
/// mid-turn or carrying a live WS subscriber. A durable (non-ephemeral)
/// session pins only while someone is actually using it — a durable session
/// with no subscriber and no turn must not pin forever (CodeRabbit: the
/// renderer can reload durable history on a fresh agent, so the old owner
/// becomes pure dead weight).
async fn session_pins_agent(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    agent_id: &AgentId,
    session_id: &str,
) -> bool {
    if relay.session_subscriber_count(session_id) > 0 {
        return true;
    }
    let sid = SessionId(session_id.to_string());
    // In-flight turn pins both durable and ephemeral sessions alike.
    // A driver that vanished mid-query or an unknown session cannot pin
    // (the agent is on its way out anyway).
    acp.is_turn_active(agent_id, sid)
        .await
        .unwrap_or(true) // unknown turn state: assume busy, never kill mid-turn
}

/// One reaper sweep: evaluate every live agent, stop the ones whose owned
/// sessions have all been unpinned for the window. `unpinned_since` carries
/// the first instant each agent was seen unpinned (survives across sweeps).
/// Returns the agent ids reaped this sweep (logged by the caller).
pub(crate) async fn reap_idle_agents(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    unpinned_since: &mut std::collections::HashMap<AgentId, Instant>,
    now: Instant,
    window: Duration,
) -> Vec<AgentId> {
    let summaries = acp.list_agent_summaries_with_ownership().await;
    let mut reaped = Vec::new();
    for summary in &summaries {
        let agent_id = summary.id.clone();
        let mut pins = Vec::with_capacity(summary.owns_session.len());
        for session_id in &summary.owns_session {
            let pinned = session_pins_agent(acp, relay, &agent_id, session_id).await;
            pins.push((session_id.clone(), pinned));
        }
        if !agent_is_reapable(&pins) {
            unpinned_since.remove(&agent_id);
            continue;
        }
        let first_unpinned = *unpinned_since.entry(agent_id.clone()).or_insert(now);
        if now.duration_since(first_unpinned) < window {
            continue;
        }
        // Reap: dispose every owned ephemeral session, then stop the agent.
        // A disposal failure means the session's state changed after the pin
        // check (a prompt arrived, or an ephemeral session was promoted to
        // durable) — do NOT kill the agent in that case; the next sweep
        // re-evaluates it with fresh pin state (CodeRabbit: kill on
        // disposal failure can stop a newly active agent).
        let mut disposal_failed = false;
        for session_id in &summary.owns_session {
            if let Err(error) = acp
                .dispose_ephemeral_session(&agent_id, SessionId(session_id.clone()))
                .await
            {
                disposal_failed = true;
                warn!(
                    target: "termul::web::agent_reaper",
                    agent_id = %agent_id.0,
                    session_id = %session_id,
                    error = %error,
                    "idle reaper: ephemeral session disposal failed; deferring the agent stop to the next sweep"
                );
            }
        }
        if disposal_failed {
            unpinned_since.remove(&agent_id);
            continue;
        }
        match acp.kill(&agent_id).await {
            Ok(()) => {
                info!(
                    target: "termul::web::agent_reaper",
                    agent_id = %agent_id.0,
                    window_secs = window.as_secs(),
                    "idle reaper stopped agent (no sessions/subscribers for the idle window)"
                );
                reaped.push(agent_id.clone());
            }
            Err(error) => {
                warn!(
                    target: "termul::web::agent_reaper",
                    agent_id = %agent_id.0,
                    error = %error,
                    "idle reaper failed to stop agent"
                );
            }
        }
        unpinned_since.remove(&agent_id);
    }
    // Agents that vanished between listing and the pin checks leave stale
    // entries; prune anything not seen this sweep.
    unpinned_since.retain(|id, _| {
        summaries
            .iter()
            .any(|summary| summary.id == *id)
    });
    reaped
}

/// Run the reaper loop until `shutdown` resolves. Exported for `serve` (and
/// directly testable with an injected window + tiny sweep interval).
pub async fn run_agent_idle_reaper(
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    window: Duration,
    sweep_interval: Duration,
    mut shutdown: ShutdownSignal,
) {
    let mut unpinned_since = std::collections::HashMap::new();
    let mut tick = tokio::time::interval(sweep_interval.max(Duration::from_millis(1)));
    // First sweep immediately so a short test window can fire on the first
    // elapsed tick without waiting a full interval.
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = shutdown.as_mut() => {
                info!(
                    target: "termul::web::agent_reaper",
                    "idle agent reaper shutting down"
                );
                return;
            }
            _ = tick.tick() => {
                let now = Instant::now();
                let reaped = reap_idle_agents(&acp, &relay, &mut unpinned_since, now, window).await;
                if !reaped.is_empty() {
                    info!(
                        target: "termul::web::agent_reaper",
                        count = reaped.len(),
                        "idle agent reaper sweep stopped agents"
                    );
                }
            }
        }
    }
}

/// Spawn the reaper on the current runtime (standalone `serve` only).
/// `window` comes from [`idle_reap_window_from_env`] unless a test injects
/// one explicitly.
pub fn spawn_agent_idle_reaper(
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    window: Duration,
    shutdown: ShutdownSignal,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run_agent_idle_reaper(
        acp,
        relay,
        window,
        DEFAULT_SWEEP_INTERVAL,
        shutdown,
    ))
}
