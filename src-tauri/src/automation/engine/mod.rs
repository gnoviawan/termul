//! The run engine, one per host. A 30 s tick claims due automations and
//! starts runs; each run walks its graph snapshot on its own task and settles
//! exactly once. Boot settles runs a dead process left `running` and fires
//! one catch-up per past-due automation.

mod agent;
mod executor;
mod http;
mod nodes;
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
use super::model::{
    Automation, AutomationChanged, AutomationId, Isolation, Run, RunId, RunStatus, RunTrigger,
};
use super::secrets::Secrets;
use super::store::{AutomationStore, ClaimOutcome, StoreResult};
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
    changes: broadcast::Sender<AutomationChanged>,
    /// One entry per automation with a run in flight: the overlap guard and
    /// the cancel handle.
    active: Mutex<HashMap<AutomationId, ActiveRun>>,
    tasks: TaskTracker,
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
        } = deps;
        Ok(Arc::new(Self {
            store,
            agents,
            secrets,
            acp,
            project_roots,
            clock,
            http: http::HttpRunner::new(http)?,
            changes: broadcast::channel(256).0,
            active: Mutex::new(HashMap::new()),
            tasks: TaskTracker::new(),
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

    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AutomationChanged> {
        self.changes.subscribe()
    }

    pub fn notify(&self, project_id: &str, automation_id: Option<&AutomationId>) {
        let _ = self.changes.send(AutomationChanged {
            project_id: project_id.to_string(),
            automation_id: automation_id.cloned(),
        });
    }

    /// Settles runs a dead process left `running`, prunes, and fires one
    /// catch-up run per automation whose slot passed while the host was down.
    pub fn boot(self: &Arc<Self>) {
        let now = self.now_ms();
        if let Err(error) = self.store.reconcile_stranded(now) {
            log::error!("[Automation] boot reconcile failed: {error}");
        }
        self.fire_due(RunTrigger::CatchUp);
        self.prune(now);
    }

    pub fn tick(self: &Arc<Self>) {
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
        let engine = Arc::clone(self);
        let task_run = run.clone();
        let project_id = automation.project_id.clone();
        let isolation = automation.isolation;
        self.tasks.spawn(async move {
            engine
                .execute(task_run, project_id, isolation, cancel)
                .await;
        });
        Ok(run)
    }

    /// Cancels an in-flight run, including its agent prompt or request.
    /// `false` when no such run is in flight.
    pub fn cancel_run(&self, run_id: &RunId) -> bool {
        let active = self.active.lock();
        let Some(entry) = active.values().find(|a| &a.run_id == run_id) else {
            return false;
        };
        entry.cancel.cancel();
        log::info!("[Automation] cancel requested for run {run_id}");
        true
    }

    /// Cancels the in-flight run of `automation_id`, if any.
    pub fn cancel_automation(&self, automation_id: &AutomationId) {
        if let Some(entry) = self.active.lock().get(automation_id) {
            entry.cancel.cancel();
        }
    }

    async fn execute(
        self: Arc<Self>,
        run: Run,
        project_id: String,
        isolation: Isolation,
        cancel: CancellationToken,
    ) {
        let outcome = match workdir::Workdir::prepare(
            &self.project_roots,
            &project_id,
            isolation,
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
                let outcome = executor::walk(&scope).await;
                dir.release().await;
                outcome
            }
            Err(reason) => executor::Outcome::failed(reason),
        };
        if let Err(error) = self.store.settle_run(
            &run.id,
            outcome.status,
            outcome.stop_reason.as_deref(),
            None,
            self.now_ms(),
        ) {
            log::error!("[Automation] settle of run {} failed: {error}", run.id);
        }
        {
            let mut active = self.active.lock();
            if active
                .get(&run.automation_id)
                .is_some_and(|a| a.run_id == run.id)
            {
                active.remove(&run.automation_id);
            }
        }
        self.notify(&project_id, Some(&run.automation_id));
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
    async fn shutdown(&self) {
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
mod tests;
