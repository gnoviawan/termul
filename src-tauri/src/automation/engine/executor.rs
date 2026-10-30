//! The topological walk of one run. A node runs when one of its incoming
//! edges fired; `out` (or `true`/`false`) edges fire on success and `error`
//! edges on failure. A failure with no `error` edge, a `fail` node or a
//! cancel stops the walk, and every node not run is recorded `skipped`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::nodes::{self, NodeError, NodeScope};
use super::Engine;
use crate::automation::graph;
use crate::automation::model::{
    wire_name, EdgeSource, Graph, NodeId, Port, Run, SettledStatus, Step, StepStatus,
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

    fn cancelled() -> Self {
        Self {
            status: SettledStatus::Cancelled,
            stop_reason: Some(CANCELLED.to_string()),
        }
    }
}

pub(super) async fn walk(scope: &RunScope<'_>) -> Outcome {
    let graph = &scope.run.graph;
    let Some(order) = graph::topo_order(graph) else {
        return Outcome::failed("graph has a cycle");
    };
    let mut reached = targets(graph, &EdgeSource::Trigger, Port::Out);
    let mut outputs: HashMap<NodeId, Value> = HashMap::new();
    let mut stop: Option<Outcome> = None;
    for node in order.iter().filter_map(|id| graph.node(id)) {
        let id = &node.id;
        if stop.is_none() && scope.cancel.is_cancelled() {
            stop = Some(Outcome::cancelled());
        }
        if stop.is_some() || !reached.contains(id) {
            record(scope, id, StepStatus::Skipped, None, None, None);
            continue;
        }
        let started_at = scope.engine.now_ms();
        record(scope, id, StepStatus::Running, None, None, Some(started_at));
        log::info!(
            "[Automation] run {} step {id} ({:?}) started",
            scope.run.id,
            node.spec.kind()
        );
        let node_scope = NodeScope {
            run: scope,
            node_id: id,
            outputs: &outputs,
        };
        let result = nodes::run(&node_scope, &node.spec).await;
        let (status, port) = match result {
            Ok(success) => {
                record(
                    scope,
                    id,
                    StepStatus::Succeeded,
                    Some(success.output.clone()),
                    None,
                    Some(started_at),
                );
                outputs.insert(id.clone(), success.output);
                (StepStatus::Succeeded, Some(success.port))
            }
            Err(NodeError::Failed { message, output }) => {
                record(
                    scope,
                    id,
                    StepStatus::Failed,
                    output.clone(),
                    Some(message.clone()),
                    Some(started_at),
                );
                if let Some(output) = output {
                    outputs.insert(id.clone(), output);
                }
                let handlers = targets(graph, &EdgeSource::Node(id.clone()), Port::Error);
                if handlers.is_empty() {
                    stop = Some(Outcome::failed(format!("{id}: {message}")));
                }
                reached.extend(handlers);
                (StepStatus::Failed, None)
            }
            Err(NodeError::Halt(message)) => {
                record(
                    scope,
                    id,
                    StepStatus::Failed,
                    None,
                    Some(message.clone()),
                    Some(started_at),
                );
                stop = Some(Outcome::failed(message));
                (StepStatus::Failed, None)
            }
            Err(NodeError::Cancelled) => {
                record(
                    scope,
                    id,
                    StepStatus::Failed,
                    None,
                    Some(CANCELLED.to_string()),
                    Some(started_at),
                );
                stop = Some(Outcome::cancelled());
                (StepStatus::Failed, None)
            }
        };
        if let Some(port) = port {
            reached.extend(targets(graph, &EdgeSource::Node(id.clone()), port));
        }
        log::info!(
            "[Automation] run {} step {id} {}",
            scope.run.id,
            wire_name(&status)
        );
    }
    stop.unwrap_or(Outcome {
        status: SettledStatus::Succeeded,
        stop_reason: None,
    })
}

fn targets(graph: &Graph, from: &EdgeSource, port: Port) -> HashSet<NodeId> {
    graph
        .edges
        .iter()
        .filter(|e| &e.from == from && e.port == port)
        .map(|e| e.to.clone())
        .collect()
}

fn record(
    scope: &RunScope<'_>,
    node_id: &NodeId,
    status: StepStatus,
    output: Option<Value>,
    error: Option<String>,
    started_at: Option<i64>,
) {
    let finished_at = (status != StepStatus::Running).then(|| scope.engine.now_ms());
    let step = Step {
        run_id: scope.run.id.clone(),
        node_id: node_id.clone(),
        status,
        output,
        error,
        started_at,
        finished_at,
    };
    if let Err(error) = scope.engine.store.upsert_step(&step) {
        log::error!(
            "[Automation] run {} step {node_id} not recorded: {error}",
            scope.run.id
        );
    }
}
