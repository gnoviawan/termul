//! Parked runs. A run whose `wait` step is `waiting` has no task: its row
//! stays `running` (so the overlap guard still sees it) and its step rows
//! hold everything the resume needs. One idempotent path resumes it, called
//! by a timer armed at park time, by every tick and at boot; a CAS on the
//! waiting step lets exactly one caller win.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::workdir::Workdir;
use super::{ActiveRun, Engine};
use crate::automation::model::Run;
use crate::automation::store::ParkedRun;

impl Engine {
    /// Resumes every parked run whose wait is due.
    pub fn resume_due(self: &Arc<Self>) {
        if self.shutdown.is_cancelled() {
            return;
        }
        let now = self.now_ms();
        for parked in self.parked_runs() {
            if parked.wait_until <= now {
                self.resume(parked, now);
            }
        }
    }

    /// Boot: resumes the parked runs that are due and arms a timer for each
    /// of the others.
    pub(super) fn arm_parked(self: &Arc<Self>) {
        let now = self.now_ms();
        let parked = self.parked_runs();
        log::info!("[Automation] {} parked run(s) at boot", parked.len());
        for wait_until in parked.iter().map(|p| p.wait_until).filter(|at| *at > now) {
            self.arm_timer(wait_until);
        }
        self.resume_due();
    }

    /// Calls [`Engine::resume_due`] at `wait_until`, or never once the engine
    /// shuts down.
    pub(super) fn arm_timer(self: &Arc<Self>, wait_until: i64) {
        let delay = u64::try_from(wait_until - self.now_ms()).unwrap_or(0);
        let engine = Arc::clone(self);
        let shutdown = self.shutdown.clone();
        self.tasks.spawn(async move {
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(delay)) => engine.resume_due(),
                () = shutdown.cancelled() => {}
            }
        });
    }

    pub(super) fn parked_runs(&self) -> Vec<ParkedRun> {
        self.store.list_parked().unwrap_or_else(|error| {
            log::error!("[Automation] parked runs unreadable: {error}");
            Vec::new()
        })
    }

    fn resume(self: &Arc<Self>, parked: ParkedRun, now: i64) {
        let ParkedRun {
            run,
            node_id,
            iteration,
            wait_until,
        } = parked;
        let automation = match self.store.get(&run.automation_id) {
            Ok(Some(automation)) => automation,
            Ok(None) => {
                log::info!(
                    "[Automation] parked run {} belongs to a deleted automation",
                    run.id
                );
                self.cancel_parked(&run);
                return;
            }
            Err(error) => {
                log::error!("[Automation] resume of run {} failed: {error}", run.id);
                return;
            }
        };
        let mut active = self.active.lock();
        if active.contains_key(&run.automation_id) {
            return;
        }
        match self.store.claim_wait(&run.id, &node_id, iteration, now) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                log::error!("[Automation] wait claim of run {} failed: {error}", run.id);
                return;
            }
        }
        let cancel = CancellationToken::new();
        active.insert(
            run.automation_id.clone(),
            ActiveRun {
                run_id: run.id.clone(),
                cancel: cancel.clone(),
            },
        );
        drop(active);
        log::info!(
            "[Automation] resumed run {} at {node_id}{} (due {wait_until})",
            run.id,
            super::executor::at_iteration(iteration)
        );
        self.notify(&automation.project_id, Some(&automation.id));
        self.spawn_execute(run, automation.project_id, cancel);
    }

    /// Settles a parked run `cancelled` and removes its worktree. `false`
    /// when the run is not parked.
    pub(super) fn cancel_parked(&self, run: &Run) -> bool {
        match self.store.cancel_parked(&run.id, self.now_ms()) {
            Ok(Some(_)) => {}
            Ok(None) => return false,
            Err(error) => {
                log::error!("[Automation] cancel of parked run {} failed: {error}", run.id);
                return false;
            }
        }
        log::info!("[Automation] cancelled parked run {}", run.id);
        let project_id = match self.store.project_of(&run.automation_id) {
            Ok(project_id) => project_id,
            Err(error) => {
                log::warn!("[Automation] project of run {} unknown: {error}", run.id);
                None
            }
        };
        if let Some(project_id) = &project_id {
            self.notify(project_id, Some(&run.automation_id));
        }
        let root = project_id.and_then(|p| (self.project_roots)(&p));
        if let (Some(root), Some(name)) = (root, run.worktree_id.clone()) {
            self.tasks.spawn(async move {
                if let Some(dir) = Workdir::existing(root, &name).await {
                    dir.release().await;
                }
            });
        }
        true
    }
}
