//! The topological walk of one run. A node runs when one of its incoming
//! edges fired (a `merge` in `all` mode: when every one did); `out` (or
//! `true`/`false`) edges fire on success and `error` edges on failure. A
//! failure with no `error` edge, a `fail` node or a cancel stops the walk,
//! and every node not run is recorded `skipped`. A `wait` parks the run: the
//! walk ends there and records nothing more.
//!
//! Every walk starts from the run's step rows, so a resumed run replays the
//! steps that already finished instead of running them again.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::nodes::{self, NodeError, NodeScope, NodeSuccess};
use super::Engine;
use crate::automation::graph;
use crate::automation::model::{
    wire_name, EdgeSource, MergeMode, Node, NodeId, NodeKind, NodeSpec, Port, Run, SettledStatus,
    Step, StepStatus,
};
use crate::automation::template::LoopFrame;

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

    fn cancelled() -> Self {
        Self {
            status: SettledStatus::Cancelled,
            stop_reason: Some(CANCELLED.to_string()),
        }
    }
}

/// How a walk ends: the run settles, or it parks on a `wait` and resumes
/// once `wait_until` passes.
pub(super) enum WalkResult {
    Settled(Outcome),
    Parked { wait_until: i64 },
}

/// Why a region stopped before its last node.
pub(super) enum Stop {
    /// `node` failed and has no `error` edge.
    Failed { node: NodeId, message: String },
    /// A `fail` node ran.
    Halt(String),
    Cancelled,
    Parked { wait_until: i64 },
}

/// The nodes one pass walks, in topo order: the run's top level, or one
/// iteration of a for_each body.
pub(super) struct Region<'a> {
    pub nodes: &'a [&'a Node],
    pub iteration: Option<u32>,
    pub frame: Option<&'a LoopFrame>,
    /// Indices into `graph.edges` of the edges that fired.
    pub fired: HashSet<usize>,
    pub outputs: HashMap<NodeId, Value>,
}

pub(super) struct Walk<'a> {
    pub scope: &'a RunScope<'a>,
    order: Vec<&'a Node>,
    bodies: HashMap<NodeId, HashSet<NodeId>>,
    /// Step rows earlier executions of this run left, by node and iteration.
    ledger: HashMap<(NodeId, Option<u32>), Step>,
}

pub(super) async fn walk(scope: &RunScope<'_>) -> WalkResult {
    let graph = &scope.run.graph;
    let Some(order) = graph::topo_order(graph) else {
        return WalkResult::Settled(Outcome::failed("graph has a cycle"));
    };
    let ledger = match scope.engine.store.get_steps(&scope.run.id) {
        Ok(rows) => rows
            .into_iter()
            .map(|s| ((s.node_id.clone(), s.iteration), s))
            .collect::<HashMap<_, _>>(),
        Err(error) => {
            return WalkResult::Settled(Outcome::failed(format!("steps unreadable: {error}")))
        }
    };
    if !ledger.is_empty() {
        log::info!(
            "[Automation] run {} resumes over {} recorded step(s)",
            scope.run.id,
            ledger.len()
        );
    }
    let walk = Walk {
        scope,
        order: order.iter().filter_map(|id| graph.node(id)).collect(),
        bodies: graph::loop_bodies(graph),
        ledger,
    };
    let top: Vec<&Node> = walk
        .order
        .iter()
        .copied()
        .filter(|n| !walk.bodies.values().any(|body| body.contains(&n.id)))
        .collect();
    let mut region = Region {
        nodes: &top,
        iteration: None,
        frame: None,
        fired: walk.edges_from(&EdgeSource::Trigger, Port::Out),
        outputs: HashMap::new(),
    };
    WalkResult::Settled(match walk.region(&mut region).await {
        Ok(()) => Outcome {
            status: SettledStatus::Succeeded,
            stop_reason: None,
        },
        Err(Stop::Failed { node, message }) => Outcome::failed(format!("{node}: {message}")),
        Err(Stop::Halt(message)) => Outcome::failed(message),
        Err(Stop::Cancelled) => Outcome::cancelled(),
        Err(Stop::Parked { wait_until }) => return WalkResult::Parked { wait_until },
    })
}

impl<'a> Walk<'a> {
    /// `loop_id`'s body nodes in topo order.
    pub(super) fn body(&self, loop_id: &NodeId) -> Vec<&'a Node> {
        let Some(body) = self.bodies.get(loop_id) else {
            return Vec::new();
        };
        self.order
            .iter()
            .copied()
            .filter(|n| body.contains(&n.id))
            .collect()
    }

    pub(super) fn edges_from(&self, from: &EdgeSource, port: Port) -> HashSet<usize> {
        self.scope
            .run
            .graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, e)| &e.from == from && e.port == port)
            .map(|(i, _)| i)
            .collect()
    }

    pub(super) async fn region(&self, region: &mut Region<'_>) -> Result<(), Stop> {
        let mut stop: Option<Stop> = None;
        for node in region.nodes {
            if stop.is_none() && self.scope.cancel.is_cancelled() {
                stop = Some(Stop::Cancelled);
            }
            if stop.is_some() || !self.reached(region, node) {
                self.skip(node, region.iteration);
                continue;
            }
            let id = &node.id;
            let result = self.step(region, node).await;
            match result {
                Ok(success) => {
                    region.outputs.insert(id.clone(), success.output);
                    self.fire(region, id, success.port);
                }
                Err(NodeError::Failed { message, output }) => {
                    if let Some(output) = output {
                        region.outputs.insert(id.clone(), output);
                    }
                    if self.fire(region, id, Port::Error) == 0 {
                        stop = Some(Stop::Failed {
                            node: id.clone(),
                            message,
                        });
                    }
                }
                Err(NodeError::Halt(message)) => stop = Some(Stop::Halt(message)),
                Err(NodeError::Cancelled) => stop = Some(Stop::Cancelled),
                Err(NodeError::Parked { wait_until }) => return Err(Stop::Parked { wait_until }),
            }
        }
        stop.map_or(Ok(()), Err)
    }

    fn reached(&self, region: &Region<'_>, node: &Node) -> bool {
        let mut incoming = self
            .scope
            .run
            .graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, e)| e.to == node.id)
            .map(|(i, _)| region.fired.contains(&i));
        match node.spec {
            NodeSpec::Merge {
                mode: MergeMode::All,
            } => incoming.all(|fired| fired),
            _ => incoming.any(|fired| fired),
        }
    }

    fn fire(&self, region: &mut Region<'_>, id: &NodeId, port: Port) -> usize {
        let edges = self.edges_from(&EdgeSource::Node(id.clone()), port);
        let count = edges.len();
        region.fired.extend(edges);
        count
    }

    /// Records `node` skipped; a skipped for_each skips its body too.
    fn skip(&self, node: &Node, iteration: Option<u32>) {
        self.record(self.row(&node.id, iteration, StepStatus::Skipped));
        if node.spec.kind() == NodeKind::ForEach {
            self.skip_body(&node.id);
        }
    }

    /// One `skipped` row per body node, outside any iteration: the loop ran
    /// no iteration.
    pub(super) fn skip_body(&self, loop_id: &NodeId) {
        for node in self.body(loop_id) {
            self.record(self.row(&node.id, None, StepStatus::Skipped));
        }
    }

    /// Replays a finished row, or runs the node and records it.
    async fn step(&self, region: &Region<'_>, node: &Node) -> Result<NodeSuccess, NodeError> {
        let (id, iteration) = (&node.id, region.iteration);
        if let Some(row) = self.ledger.get(&(id.clone(), iteration)) {
            if row.status.is_finished() {
                return replayed(row, node.spec.kind());
            }
            if row.status == StepStatus::Waiting {
                return Err(NodeError::Parked {
                    wait_until: row.wait_until.unwrap_or_default(),
                });
            }
        }
        let started_at = self.scope.engine.now_ms();
        let mut row = self.row(id, iteration, StepStatus::Running);
        row.started_at = Some(started_at);
        self.record(row);
        log::info!(
            "[Automation] run {} step {id}{} ({:?}) started",
            self.scope.run.id,
            at_iteration(iteration),
            node.spec.kind()
        );
        let node_scope = NodeScope {
            run: self.scope,
            walk: self,
            node_id: id,
            iteration,
            frame: region.frame,
            outputs: &region.outputs,
            fired: &region.fired,
        };
        let result = nodes::run(&node_scope, &node.spec).await;
        let (status, output, error) = match &result {
            Ok(success) => (StepStatus::Succeeded, Some(success.output.clone()), None),
            Err(NodeError::Failed { message, output }) => {
                (StepStatus::Failed, output.clone(), Some(message.clone()))
            }
            Err(NodeError::Halt(message)) => (StepStatus::Failed, None, Some(message.clone())),
            Err(NodeError::Cancelled) => (StepStatus::Failed, None, Some(CANCELLED.to_string())),
            Err(NodeError::Parked { .. }) => return result,
        };
        let mut row = self.row(id, iteration, status);
        row.output = output;
        row.error = error;
        row.started_at = Some(started_at);
        self.record(row);
        log::info!(
            "[Automation] run {} step {id}{} {}",
            self.scope.run.id,
            at_iteration(iteration),
            wire_name(&status)
        );
        result
    }

    pub(super) fn row(&self, node_id: &NodeId, iteration: Option<u32>, status: StepStatus) -> Step {
        let finished = !matches!(status, StepStatus::Running | StepStatus::Waiting);
        Step {
            run_id: self.scope.run.id.clone(),
            node_id: node_id.clone(),
            iteration,
            status,
            output: None,
            error: None,
            started_at: None,
            finished_at: finished.then(|| self.scope.engine.now_ms()),
            wait_until: None,
        }
    }

    pub(super) fn record(&self, step: Step) {
        if let Err(error) = self.scope.engine.store.upsert_step(&step) {
            log::error!(
                "[Automation] run {} step {} not recorded: {error}",
                self.scope.run.id,
                step.node_id
            );
        }
    }
}

/// A finished row as the result its node produced. The port is derived the
/// same way the live run chose it: failed routes `error`, a condition routes
/// `true`/`false` from its result, everything else routes `out`.
fn replayed(row: &Step, kind: NodeKind) -> Result<NodeSuccess, NodeError> {
    let output = row.output.clone();
    if row.status == StepStatus::Failed {
        return Err(NodeError::Failed {
            message: row.error.clone().unwrap_or_default(),
            output,
        });
    }
    let output = output.unwrap_or(Value::Null);
    let port = match kind {
        NodeKind::Condition if output["result"] == Value::Bool(true) => Port::True,
        NodeKind::Condition => Port::False,
        _ => Port::Out,
    };
    Ok(NodeSuccess { output, port })
}

pub(super) fn at_iteration(iteration: Option<u32>) -> String {
    iteration.map(|i| format!("[{i}]")).unwrap_or_default()
}
