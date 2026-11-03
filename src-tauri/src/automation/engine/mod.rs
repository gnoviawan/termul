//! The run engine, one per host. A 30 s tick claims due automations and
//! starts runs; each run walks its graph snapshot on its own task and settles
//! exactly once, or parks on a `wait` and resumes later (`park.rs`). Boot
//! settles runs a dead process left `running`, resumes parked ones and fires
//! one catch-up per past-due automation.

mod agent;
mod control;
mod executor;
mod http;
mod mcp;
mod nodes;
mod park;
mod workdir;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::agents::AgentRegistry;
use super::mcp::{McpClient, McpTools, OnListingChanged, ProjectMcpServers};
use super::model::{
    Automation, AutomationChanged, AutomationId, NodeSpec, Run, RunId, RunStatus, RunTrigger,
};
use super::secrets::Secrets;
use super::store::{AutomationStore, ClaimOutcome, StoreResult};
use executor::WalkResult;
use crate::acp::AcpManager;

pub const TICK: Duration = Duration::from_secs(30);
const PRUNE_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
const RUN_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
pub const OVERLAP_REASON: &str = "overlap";

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

/// Canonical root of a project id, `None` when the project is unknown,
/// archived or its directory is gone.
pub type ProjectRoots = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

#[derive(Debug, Clone)]
pub struct HttpConfig {
    /// Wall-clock budget of one request, body included.
    pub request_timeout: Duration,
    /// Response bytes kept in the step output; the rest is cut.
    pub body_cap: usize,
    /// DNS overrides, so tests can serve a real hostname locally.
    pub resolve: Vec<(String, SocketAddr)>,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            body_cap: 256 * 1024,
            resolve: Vec::new(),
        }
    }
}

pub struct EngineDeps {
    pub store: Arc<AutomationStore>,
    pub agents: Arc<AgentRegistry>,
    pub secrets: Arc<Secrets>,
    pub acp: Arc<AcpManager>,
    pub project_roots: ProjectRoots,
    pub clock: Arc<dyn Clock>,
    pub http: HttpConfig,
    pub mcp_servers: ProjectMcpServers,
    pub mcp_client: Arc<dyn McpClient>,
}

struct ActiveRun {
    run_id: RunId,
    cancel: CancellationToken,
}

pub struct Engine {
    store: Arc<AutomationStore>,
    agents: Arc<AgentRegistry>,
    secrets: Arc<Secrets>,
    acp: Arc<AcpManager>,
    project_roots: ProjectRoots,
    clock: Arc<dyn Clock>,
    http: http::HttpRunner,
    mcp: Arc<McpTools>,
    changes: broadcast::Sender<AutomationChanged>,
    /// One entry per automation with a run in flight: the overlap guard and
    /// the cancel handle.
    active: Mutex<HashMap<AutomationId, ActiveRun>>,
    tasks: TaskTracker,
    /// Cancelled at shutdown; park timers stop on it.
    shutdown: CancellationToken,
    last_prune_at: Mutex<Option<i64>>,
}

impl Engine {
    pub fn new(deps: EngineDeps) -> Result<Arc<Self>, String> {
        let EngineDeps {
            store,
            agents,
            secrets,
            acp,
            project_roots,
            clock,
            http,
            mcp_servers,
            mcp_client,
        } = deps;
        let changes = broadcast::channel(256).0;
        let mcp = McpTools::new(
            mcp_servers,
            mcp_client,
            clock.clone(),
            listing_changed(store.clone(), changes.clone()),
        );
        Ok(Arc::new(Self {
            store,
            agents,
            secrets,
            acp,
            project_roots,
            clock,
            http: http::HttpRunner::new(http)?,
            mcp,
            changes,
            active: Mutex::new(HashMap::new()),
            tasks: TaskTracker::new(),
            shutdown: CancellationToken::new(),
            last_prune_at: Mutex::new(None),
        }))
    }

    pub fn store(&self) -> &Arc<AutomationStore> {
        &self.store
    }

    pub fn agents(&self) -> &Arc<AgentRegistry> {
        &self.agents
    }

    pub fn secrets(&self) -> &Arc<Secrets> {
        &self.secrets
    }

    pub fn mcp(&self) -> &Arc<McpTools> {
        &self.mcp
    }

    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AutomationChanged> {
        self.changes.subscribe()
    }

    pub fn notify(&self, project_id: &str, automation_id: Option<&AutomationId>) {
        self.announce(AutomationChanged {
            project_id: project_id.to_string(),
            automation_id: automation_id.cloned(),
            proposed: false,
            proposed_by: None,
        });
    }

    pub fn announce(&self, change: AutomationChanged) {
        let _ = self.changes.send(change);
    }

    /// Settles runs a dead process left `running`, resumes or re-arms parked
    /// runs, prunes, and fires one catch-up run per automation whose slot
    /// passed while the host was down.
    pub fn boot(self: &Arc<Self>) {
        let now = self.now_ms();
        if let Err(error) = self.store.reconcile_stranded(now) {
            log::error!("[Automation] boot reconcile failed: {error}");
        }
        self.arm_parked();
        self.fire_due(RunTrigger::CatchUp);
        self.prune(now);
    }

    pub fn tick(self: &Arc<Self>) {
        self.resume_due();
        self.fire_due(RunTrigger::Scheduled);
        let now = self.now_ms();
        let due = self
            .last_prune_at
            .lock()
            .is_none_or(|last| now - last >= PRUNE_EVERY_MS);
        if due {
            self.prune(now);
        }
    }

    fn prune(&self, now: i64) {
        *self.last_prune_at.lock() = Some(now);
        if let Err(error) = self.store.prune_runs(now - RUN_RETENTION_MS) {
            log::warn!("[Automation] prune failed: {error}");
        }
    }

    fn fire_due(self: &Arc<Self>, trigger: RunTrigger) {
        let now = self.now_ms();
        let due = match self.store.list_due(now) {
            Ok(due) => due,
            Err(error) => {
                log::error!("[Automation] list due failed: {error}");
                return;
            }
        };
        for automation in due {
            let Some(slot) = automation.next_run_at else {
                continue;
            };
            match self.store.claim_due(&automation.id, slot, now) {
                Ok(ClaimOutcome::Claimed {
                    automation,
                    scheduled_for,
                }) => {
                    if let Err(error) = self.start_run(&automation, trigger, scheduled_for) {
                        log::error!(
                            "[Automation] could not start run of {}: {error}",
                            automation.id
                        );
                    }
                }
                Ok(ClaimOutcome::ScheduleBroken { .. }) => {
                    self.notify(&automation.project_id, Some(&automation.id));
                }
                Ok(ClaimOutcome::Lost) => {}
                Err(error) => {
                    log::error!("[Automation] claim of {} failed: {error}", automation.id)
                }
            }
        }
    }

    /// Inserts a run of `automation` as it is now and executes it in the
    /// background. While another run of the same automation is in flight the
    /// new run is recorded `skipped` instead.
    pub fn start_run(
        self: &Arc<Self>,
        automation: &Automation,
        trigger: RunTrigger,
        scheduled_for: i64,
    ) -> StoreResult<Run> {
        let now = self.now_ms();
        let mut active = self.active.lock();
        let overlapping =
            active.contains_key(&automation.id) || self.store.has_active_run(&automation.id)?;
        let id = RunId::generate();
        let mut run = Run {
            worktree_id: workdir::worktree_name(&id, automation.isolation),
            id,
            automation_id: automation.id.clone(),
            revision: automation.revision,
            graph: automation.graph.clone(),
            trigger,
            scheduled_for,
            status: RunStatus::Running,
            started_at: now,
            finished_at: None,
            stop_reason: None,
            summary: None,
            conversation_id: None,
        };
        if overlapping {
            run.status = RunStatus::Skipped;
            run.finished_at = Some(now);
            run.stop_reason = Some(OVERLAP_REASON.to_string());
            run.worktree_id = None;
            self.store.insert_run(&run)?;
            drop(active);
            log::info!(
                "[Automation] skipped run of {}: previous run still active",
                automation.id
            );
            self.notify(&automation.project_id, Some(&automation.id));
            return Ok(run);
        }
        self.store.insert_run(&run)?;
        let cancel = CancellationToken::new();
        active.insert(
            automation.id.clone(),
            ActiveRun {
                run_id: run.id.clone(),
                cancel: cancel.clone(),
            },
        );
        drop(active);
        log::info!(
            "[Automation] fired run {} of {} ({:?}, revision {})",
            run.id,
            automation.id,
            trigger,
            run.revision
        );
        self.notify(&automation.project_id, Some(&automation.id));
        self.spawn_execute(run.clone(), automation.project_id.clone(), cancel);
        Ok(run)
    }

    fn spawn_execute(self: &Arc<Self>, run: Run, project_id: String, cancel: CancellationToken) {
        let engine = Arc::clone(self);
        self.tasks.spawn(async move {
            engine.execute(run, project_id, cancel).await;
        });
    }

    /// Cancels an in-flight run, including its agent prompt or request, or
    /// a parked run. `false` when the run is neither.
    pub fn cancel_run(&self, run_id: &RunId) -> bool {
        // Held throughout, so a resume cannot claim the run in between.
        let active = self.active.lock();
        if let Some(entry) = active.values().find(|a| &a.run_id == run_id) {
            entry.cancel.cancel();
            log::info!("[Automation] cancel requested for run {run_id}");
            return true;
        }
        match self.store.get_run(run_id) {
            Ok(Some(run)) => self.cancel_parked(&run),
            Ok(None) => false,
            Err(error) => {
                log::error!("[Automation] cancel of run {run_id} failed: {error}");
                false
            }
        }
    }

    /// Cancels the in-flight or parked run of `automation_id`, if any.
    pub fn cancel_automation(&self, automation_id: &AutomationId) {
        let active = self.active.lock();
        if let Some(entry) = active.get(automation_id) {
            entry.cancel.cancel();
            return;
        }
        for parked in self.parked_runs() {
            if &parked.run.automation_id == automation_id {
                self.cancel_parked(&parked.run);
            }
        }
    }

    async fn execute(self: Arc<Self>, run: Run, project_id: String, cancel: CancellationToken) {
        let result = match workdir::Workdir::prepare(
            &self.project_roots,
            &project_id,
            run.worktree_id.as_deref(),
        )
        .await
        {
            Ok(dir) => {
                let scope = executor::RunScope {
                    engine: &self,
                    run: &run,
                    project_id: &project_id,
                    cwd: dir.path(),
                    cancel: &cancel,
                };
                let result = executor::walk(&scope).await;
                // A parked run keeps its worktree; the resume reuses it.
                if matches!(result, WalkResult::Settled(_)) {
                    dir.release().await;
                }
                result
            }
            Err(reason) => WalkResult::Settled(executor::Outcome::failed(reason)),
        };
        match result {
            WalkResult::Settled(outcome) => {
                if let Err(error) = self.store.settle_run(
                    &run.id,
                    outcome.status,
                    outcome.stop_reason.as_deref(),
                    None,
                    self.now_ms(),
                ) {
                    log::error!("[Automation] settle of run {} failed: {error}", run.id);
                }
                self.release_active(&run);
            }
            WalkResult::Parked { wait_until } => {
                // Decided under the lock `cancel_run` and `resume` take, so a
                // cancel that landed while the walk was parking is honoured
                // before any resume can claim the wait.
                let mut active = self.active.lock();
                let cancelled = cancel.is_cancelled();
                if cancelled {
                    self.cancel_parked(&run);
                }
                forget(&mut active, &run);
                drop(active);
                if !cancelled {
                    self.arm_timer(wait_until);
                }
            }
        }
        self.notify(&project_id, Some(&run.automation_id));
    }

    fn release_active(&self, run: &Run) {
        forget(&mut self.active.lock(), run);
    }

    /// Boots, then ticks every [`TICK`] on `runtime` until stopped.
    pub fn start(self: &Arc<Self>, runtime: &tokio::runtime::Handle) -> EngineHandle {
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        let engine = Arc::clone(self);
        let join = runtime.spawn(async move {
            engine.boot();
            let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + TICK, TICK);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    _ = interval.tick() => engine.tick(),
                }
            }
        });
        log::info!("[Automation] engine started");
        EngineHandle {
            engine: Arc::clone(self),
            running: Mutex::new(Some((stop_tx, join))),
        }
    }

    /// Cancels every in-flight run and waits (bounded) for them to settle.
    /// Parked runs stay parked and resume at the next boot.
    async fn shutdown(&self) {
        self.shutdown.cancel();
        for entry in self.active.lock().values() {
            entry.cancel.cancel();
        }
        self.tasks.close();
        if tokio::time::timeout(SHUTDOWN_GRACE, self.tasks.wait())
            .await
            .is_err()
        {
            log::warn!("[Automation] runs still settling after {SHUTDOWN_GRACE:?} at shutdown");
        }
        log::info!("[Automation] engine stopped");
    }
}

/// Drops `run`'s entry, leaving one a newer run of the automation holds.
fn forget(active: &mut HashMap<AutomationId, ActiveRun>, run: &Run) {
    if active
        .get(&run.automation_id)
        .is_some_and(|a| a.run_id == run.id)
    {
        active.remove(&run.automation_id);
    }
}

/// A server's tools changed: every automation of the project with an
/// `mcp_tool` node on it has new issues, so its open screens read it again.
fn listing_changed(
    store: Arc<AutomationStore>,
    changes: broadcast::Sender<AutomationChanged>,
) -> OnListingChanged {
    Arc::new(move |project_id, server_id| {
        let automations = match store.list(Some(project_id)) {
            Ok(automations) => automations,
            Err(error) => {
                log::warn!("[Automation] list for an MCP listing change failed: {error}");
                return;
            }
        };
        let uses_server = |a: &Automation| {
            a.graph.nodes.iter().any(|n| {
                matches!(&n.spec, NodeSpec::McpTool { server_id: id, .. } if id == server_id)
            })
        };
        for automation in automations.iter().filter(|a| uses_server(a)) {
            let _ = changes.send(AutomationChanged {
                project_id: project_id.to_string(),
                automation_id: Some(automation.id.clone()),
                proposed: false,
                proposed_by: None,
            });
        }
    })
}

pub struct EngineHandle {
    engine: Arc<Engine>,
    running: Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::task::JoinHandle<()>,
        )>,
    >,
}

impl EngineHandle {
    /// Stops the tick and cancels in-flight runs. Idempotent.
    pub async fn stop(&self) {
        let running = self.running.lock().take();
        if let Some((stop_tx, join)) = running {
            let _ = stop_tx.send(());
            let _ = join.await;
            self.engine.shutdown().await;
        }
    }
}

#[cfg(test)]
mod control_tests;
#[cfg(test)]
mod mcp_tests;
#[cfg(test)]
mod tests;
