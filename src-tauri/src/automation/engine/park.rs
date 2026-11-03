//! Parking: a run that reaches an approval node leaves memory and waits in
//! the store. Every way a park ends (approve, reject, timeout, cancel) goes
//! through [`Engine::resolve`], whose store claim lets exactly one of them
//! win, and resumes the run on a new task.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::executor::{self, ParkRequest};
use super::{ActiveRun, Engine};
use crate::automation::model::{wire_name, AutomationId, NodeId, Run, RunId, StepStatus};
use crate::automation::store::StoreResult;

/// How an approval park ended. The wire name is the step output's
/// `decision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approved,
    Rejected,
    TimedOut,
    Cancelled,
}

impl Decision {
    /// The parked step's terminal status and error. Approved fires `out`;
    /// the rest fail the step, so its `error` edges fire (a cancelled run
    /// stops before routing anything).
    fn step(self) -> (StepStatus, Option<&'static str>) {
        match self {
            Self::Approved => (StepStatus::Succeeded, None),
            Self::Rejected => (StepStatus::Failed, Some("rejected")),
            Self::TimedOut => (StepStatus::Failed, Some("approval_timed_out")),
            Self::Cancelled => (StepStatus::Failed, Some(executor::CANCELLED)),
        }
    }

    /// Fields merged into the waiting step's output.
    fn fields(self, now_ms: i64) -> Map<String, Value> {
        match json!({ "decision": wire_name(&self), "decided_at": now_ms }) {
            Value::Object(fields) => fields,
            _ => Map::new(),
        }
    }
}

impl Engine {
    /// Commits a walk's park and drops the run's active entry. A cancel that
    /// fired before the commit resolves the park as cancelled right away.
    pub(super) fn park(
        self: &Arc<Self>,
        run: &Run,
        request: ParkRequest,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let now = self.now_ms();
        let mut active = self.active.lock();
        match self.store.park_run(
            &run.id,
            &request.node_id,
            request.until,
            &request.output,
            now,
        ) {
            Ok(true) => {}
            Ok(false) => return Err("park_failed: the run is not running".to_string()),
            Err(error) => {
                log::error!("[Automation] park of run {} failed: {error}", run.id);
                executor::record(
                    self,
                    run,
                    &request.node_id,
                    StepStatus::Failed,
                    None,
                    Some("park_failed".to_string()),
                    None,
                );
                return Err("park_failed".to_string());
            }
        }
        if active
            .get(&run.automation_id)
            .is_some_and(|a| a.run_id == run.id)
        {
            active.remove(&run.automation_id);
        }
        log::info!(
            "[Automation] run {} parked at {} until {}",
            run.id,
            request.node_id,
            request.until
        );
        if cancel.is_cancelled() {
            if let Err(error) =
                self.resolve_locked(&mut active, &run.id, &request.node_id, Decision::Cancelled)
            {
                log::error!(
                    "[Automation] cancel of parked run {} failed: {error}",
                    run.id
                );
            }
        }
        Ok(())
    }

    /// Ends the park of `run_id` at `node_id` with `decision` and resumes the
    /// run. `false` when it is no longer parked there: another decision, the
    /// timeout or a cancel won.
    pub fn resolve(
        self: &Arc<Self>,
        run_id: &RunId,
        node_id: &NodeId,
        decision: Decision,
    ) -> StoreResult<bool> {
        let mut active = self.active.lock();
        self.resolve_locked(&mut active, run_id, node_id, decision)
    }

    pub(super) fn resolve_locked(
        self: &Arc<Self>,
        active: &mut HashMap<AutomationId, ActiveRun>,
        run_id: &RunId,
        node_id: &NodeId,
        decision: Decision,
    ) -> StoreResult<bool> {
        // Looked up before the claim, so a won claim always gets its task.
        let Some(project_id) = self.store.run_project_id(run_id)? else {
            return Ok(false);
        };
        let now = self.now_ms();
        let (status, error) = decision.step();
        let Some(run) =
            self.store
                .resume_parked(run_id, node_id, status, error, decision.fields(now), now)?
        else {
            log::info!(
                "[Automation] run {run_id} is not waiting at {node_id}; {} ignored",
                wire_name(&decision)
            );
            return Ok(false);
        };
        let cancel = CancellationToken::new();
        if decision == Decision::Cancelled {
            cancel.cancel();
        }
        active.insert(
            run.automation_id.clone(),
            ActiveRun {
                run_id: run.id.clone(),
                cancel: cancel.clone(),
            },
        );
        log::info!(
            "[Automation] run {run_id} at {node_id} resolved {}",
            wire_name(&decision)
        );
        self.notify(&project_id, Some(&run.automation_id));
        self.spawn_execute(run, project_id, cancel);
        Ok(true)
    }

    /// Resolves every park whose deadline passed as timed out.
    pub(super) fn expire_parks(self: &Arc<Self>, now_ms: i64) {
        let expired = match self.store.list_expired_parks(now_ms) {
            Ok(expired) => expired,
            Err(error) => {
                log::error!("[Automation] list expired parks failed: {error}");
                return;
            }
        };
        for parked in expired {
            log::info!(
                "[Automation] run {} park at {} expired",
                parked.run_id,
                parked.parked.node_id
            );
            if let Err(error) =
                self.resolve(&parked.run_id, &parked.parked.node_id, Decision::TimedOut)
            {
                log::error!(
                    "[Automation] timeout of run {} failed: {error}",
                    parked.run_id
                );
            }
        }
    }
}
