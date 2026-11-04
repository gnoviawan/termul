//! The topological walk of one run. A node runs when one of its incoming
//! edges fired; `out` (or `true`/`false`) edges fire on success and `error`
//! edges on failure. A failure with no `error` edge, a `fail` node or a
//! cancel stops the walk, and every node not run is recorded `skipped`.
//!
//! The walk is resumable: a node that already has a terminal step (a run
//! resumed after a park) is replayed from that step, never run again. An
//! approval node ends the walk parked; the nodes after it stay unrecorded
//! until the park is resolved and the run walks again.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::nodes::{self, Advance, NodeError, NodeScope};
use super::Engine;
use crate::automation::graph;
use crate::automation::model::{
    wire_name, EdgeSource, Graph, NodeId, NodeKind, NodeSpec, Port, Run, SettledStatus, Step,
    StepStatus,
};

pub(super) const CANCELLED: &str = "cancelled";

pub(super) struct RunScope<'a> {
    pub engine: &'a Engine,
    pub run: &'a Run,
    pub project_id: &'a str,
    pub cwd: &'a Path,
    pub cancel: &'a CancellationToken,
}

pub(super) struct Outcome {
    pub status: SettledStatus,
    pub stop_reason: Option<String>,
}

impl Outcome {
    pub(super) fn failed(reason: impl Into<String>) -> Self {
        Self {
            status: SettledStatus::Failed,
            stop_reason: Some(reason.into()),
        }
    }

    pub(super) fn cancelled() -> Self {
        Self {
            status: SettledStatus::Cancelled,
            stop_reason: Some(CANCELLED.to_string()),
        }
    }
}

/// How a walk ends: the run settles, or it parks at a node until someone
/// resolves the park.
pub(super) enum WalkEnd {
    Settled(Outcome),
    Parked(ParkRequest),
}

pub(super) struct ParkRequest {
    pub node_id: NodeId,
    pub until: i64,
    pub output: Value,
}

/// A node's terminal result, from running it or from its recorded step.
enum Finished {
    Succeeded {
        output: Value,
        port: Port,
    },
    Failed {
        message: String,
        output: Option<Value>,
    },
    /// A `fail` node: the run fails with this message.
    Halted(String),
    Cancelled,
}

impl From<NodeError> for Finished {
    fn from(error: NodeError) -> Self {
        match error {
            NodeError::Failed { message, output } => Self::Failed { message, output },
            NodeError::Halt(message) => Self::Halted(message),
            NodeError::Cancelled => Self::Cancelled,
        }
    }
}

impl Finished {
    /// What a finished step fires on replay; `None` for a skipped one.
    fn from_step(spec: &NodeSpec, step: Step) -> Option<Self> {
        match step.status {
            StepStatus::Succeeded => {
                let output = step.output.unwrap_or(Value::Null);
                Some(Self::Succeeded {
                    port: nodes::replay_port(spec, &output),
                    output,
                })
            }
            StepStatus::Failed if spec.kind() == NodeKind::Fail => {
                Some(Self::Halted(step.error.unwrap_or_default()))
            }
            StepStatus::Failed => Some(Self::Failed {
                message: step.error.unwrap_or_default(),
                output: step.output,
            }),
            StepStatus::Skipped | StepStatus::Running | StepStatus::Waiting => None,
        }
    }

    fn step_fields(&self) -> (StepStatus, Option<Value>, Option<String>) {
        match self {
            Self::Succeeded { output, .. } => (StepStatus::Succeeded, Some(output.clone()), None),
            Self::Failed { message, output } => {
                (StepStatus::Failed, output.clone(), Some(message.clone()))
            }
            Self::Halted(message) => (StepStatus::Failed, None, Some(message.clone())),
            Self::Cancelled => (StepStatus::Failed, None, Some(CANCELLED.to_string())),
        }
    }
}

fn is_terminal(status: StepStatus) -> bool {
    match status {
        StepStatus::Succeeded | StepStatus::Failed | StepStatus::Skipped => true,
        StepStatus::Running | StepStatus::Waiting => false,
    }
}

/// What the walk has learned so far: which nodes an edge reached, what the
/// finished ones output, and why it stopped, if it did.
struct WalkState<'g> {
    graph: &'g Graph,
    reached: HashSet<NodeId>,
    outputs: HashMap<NodeId, Value>,
    stop: Option<Outcome>,
}

impl WalkState<'_> {
    fn apply(&mut self, id: &NodeId, finished: Finished) {
        let from = EdgeSource::Node(id.clone());
        match finished {
            Finished::Succeeded { output, port } => {
                self.outputs.insert(id.clone(), output);
                self.reached.extend(targets(self.graph, &from, port));
            }
            Finished::Failed { message, output } => {
                if let Some(output) = output {
                    self.outputs.insert(id.clone(), output);
                }
                let handlers = targets(self.graph, &from, Port::Error);
                if handlers.is_empty() {
                    self.stop = Some(Outcome::failed(format!("{id}: {message}")));
                }
                self.reached.extend(handlers);
            }
            Finished::Halted(message) => self.stop = Some(Outcome::failed(message)),
            Finished::Cancelled => self.stop = Some(Outcome::cancelled()),
        }
    }
}

pub(super) async fn walk(scope: &RunScope<'_>) -> WalkEnd {
    let graph = &scope.run.graph;
    let Some(order) = graph::topo_order(graph) else {
        return WalkEnd::Settled(Outcome::failed("graph has a cycle"));
    };
    let mut recorded: HashMap<NodeId, Step> = match scope.engine.store.get_steps(&scope.run.id) {
        Ok(steps) => steps.into_iter().map(|s| (s.node_id.clone(), s)).collect(),
        Err(error) => {
            log::error!(
                "[Automation] run {} steps unreadable: {error}",
                scope.run.id
            );
            return WalkEnd::Settled(Outcome::failed("steps_unreadable"));
        }
    };
    let mut state = WalkState {
        graph,
        reached: targets(graph, &EdgeSource::Trigger, Port::Out),
        outputs: HashMap::new(),
        stop: None,
    };
    for node in order.iter().filter_map(|id| graph.node(id)) {
        let id = &node.id;
        if state.stop.is_none() && scope.cancel.is_cancelled() {
            state.stop = Some(Outcome::cancelled());
        }
        if state.stop.is_some() || !state.reached.contains(id) {
            record(
                scope.engine,
                scope.run,
                id,
                StepStatus::Skipped,
                None,
                None,
                None,
            );
            continue;
        }
        if let Some(step) = recorded.remove(id).filter(|s| is_terminal(s.status)) {
            if let Some(finished) = Finished::from_step(&node.spec, step) {
                state.apply(id, finished);
            }
            continue;
        }
        let started_at = scope.engine.now_ms();
        record(
            scope.engine,
            scope.run,
            id,
            StepStatus::Running,
            None,
            None,
            Some(started_at),
        );
        log::info!(
            "[Automation] run {} step {id} ({:?}) started",
            scope.run.id,
            node.spec.kind()
        );
        let node_scope = NodeScope {
            run: scope,
            node_id: id,
            outputs: &state.outputs,
        };
        let finished = match nodes::run(&node_scope, &node.spec).await {
            Ok(Advance::Next(success)) => Finished::Succeeded {
                output: success.output,
                port: success.port,
            },
            Ok(Advance::Park { until, output }) => {
                return WalkEnd::Parked(ParkRequest {
                    node_id: id.clone(),
                    until,
                    output,
                });
            }
            Err(error) => Finished::from(error),
        };
        let (status, output, error) = finished.step_fields();
        let recorded = record(
            scope.engine,
            scope.run,
            id,
            status,
            output,
            error,
            Some(started_at),
        );
        state.apply(id, finished);
        // An unrecorded step stays `running`, and a resume after a later
        // park would run it again.
        if !recorded && state.stop.is_none() {
            state.stop = Some(Outcome::failed(format!("{id}: step_not_recorded")));
        }
        log::info!(
            "[Automation] run {} step {id} {}",
            scope.run.id,
            wire_name(&status)
        );
    }
    WalkEnd::Settled(state.stop.unwrap_or(Outcome {
        status: SettledStatus::Succeeded,
        stop_reason: None,
    }))
}

/// A run cancelled before it walks (a park resolved as cancelled) records
/// every node it never ran as skipped, with no workdir.
pub(super) fn skip_unrun(engine: &Engine, run: &Run) -> Outcome {
    for node in &run.graph.nodes {
        record(engine, run, &node.id, StepStatus::Skipped, None, None, None);
    }
    Outcome::cancelled()
}

fn targets(graph: &Graph, from: &EdgeSource, port: Port) -> HashSet<NodeId> {
    graph
        .edges
        .iter()
        .filter(|e| &e.from == from && e.port == port)
        .map(|e| e.to.clone())
        .collect()
}

/// `upsert_step` never overwrites a finished step, so recording `skipped`
/// over a replayed node is a no-op. `false` when the write failed.
pub(super) fn record(
    engine: &Engine,
    run: &Run,
    node_id: &NodeId,
    status: StepStatus,
    output: Option<Value>,
    error: Option<String>,
    started_at: Option<i64>,
) -> bool {
    let finished_at = (status != StepStatus::Running).then(|| engine.now_ms());
    let step = Step {
        run_id: run.id.clone(),
        node_id: node_id.clone(),
        status,
        output,
        error,
        started_at,
        finished_at,
    };
    match engine.store.upsert_step(&step) {
        Ok(_) => true,
        Err(error) => {
            log::error!(
                "[Automation] run {} step {node_id} not recorded: {error}",
                run.id
            );
            false
        }
    }
}
