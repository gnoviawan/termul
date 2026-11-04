//! Control-flow nodes: `for_each` walks its body once per item, `merge`
//! joins the branches that fired, `wait` parks the run.

use serde_json::{json, Map, Value};

use super::executor::{at_iteration, Region, Stop};
use super::nodes::{render, NodeError, NodeScope, NodeSuccess};
use crate::automation::model::{EdgeSource, Port, StepStatus, Template};
use crate::automation::template::LoopFrame;

/// Iterations run one after another. The output is one object per
/// iteration, keyed by the body nodes that produced an output in it. A
/// body failure with no `error` edge fails the loop; a `fail` node, a cancel
/// or a park inside the body propagates to the run.
pub(super) async fn for_each(
    scope: &NodeScope<'_>,
    items: &Template,
    max_iterations: u32,
) -> Result<NodeSuccess, NodeError> {
    let walk = scope.walk;
    let loop_id = scope.node_id;
    let list = match render(items, &scope.render_context(None)).and_then(|value| {
        checked_items(value, max_iterations)
    }) {
        Ok(list) => list,
        Err(error) => {
            walk.skip_body(loop_id);
            return Err(error);
        }
    };
    if list.is_empty() {
        walk.skip_body(loop_id);
    }
    log::info!(
        "[Automation] run {} for_each {loop_id} over {} item(s)",
        scope.run.run.id,
        list.len()
    );
    let body = walk.body(loop_id);
    let entries = walk.edges_from(&EdgeSource::Node(loop_id.clone()), Port::Item);
    let mut results = Vec::with_capacity(list.len());
    for (index, item) in (0u32..).zip(list) {
        let frame = LoopFrame {
            node: loop_id.clone(),
            item,
            index,
        };
        let mut region = Region {
            nodes: &body,
            iteration: Some(index),
            frame: Some(&frame),
            fired: entries.clone(),
            outputs: scope.outputs.clone(),
        };
        match Box::pin(walk.region(&mut region)).await {
            Ok(()) => results.push(Value::Object(
                body.iter()
                    .filter_map(|n| {
                        let output = region.outputs.get(&n.id)?;
                        Some((n.id.to_string(), output.clone()))
                    })
                    .collect(),
            )),
            Err(Stop::Failed { node, message }) => {
                return Err(NodeError::failed(format!(
                    "iteration {index}: {node}: {message}"
                )))
            }
            Err(Stop::Halt(message)) => return Err(NodeError::Halt(message)),
            Err(Stop::Cancelled) => return Err(NodeError::Cancelled),
            Err(Stop::Parked { wait_until }) => return Err(NodeError::Parked { wait_until }),
        }
    }
    Ok(NodeSuccess {
        output: Value::Array(results),
        port: Port::Out,
    })
}

/// `{ from, value, inputs }`: `from` is the first fired source in edge
/// declaration order and `value` its output, so after a condition
/// `value` is whichever branch ran.
pub(super) fn merge(scope: &NodeScope<'_>) -> Value {
    let edges = &scope.run.run.graph.edges;
    let mut sources: Vec<&EdgeSource> = Vec::new();
    for (i, edge) in edges.iter().enumerate() {
        if &edge.to == scope.node_id && scope.fired.contains(&i) && !sources.contains(&&edge.from)
        {
            sources.push(&edge.from);
        }
    }
    let output_of = |source: &EdgeSource| -> Option<&Value> {
        match source {
            EdgeSource::Node(id) => scope.outputs.get(id),
            EdgeSource::Trigger => None,
        }
    };
    let inputs: Map<String, Value> = sources
        .iter()
        .filter_map(|s| Some((String::from((*s).clone()), output_of(s)?.clone())))
        .collect();
    let from = sources.first().map(|s| String::from((*s).clone()));
    let value = sources
        .first()
        .and_then(|s| output_of(s))
        .cloned()
        .unwrap_or(Value::Null);
    json!({ "from": from, "value": value, "inputs": inputs })
}

/// Records the step `waiting` until `now + duration_ms` and parks the run.
/// The engine resumes it once that passes; see `park.rs`.
pub(super) fn wait(scope: &NodeScope<'_>, duration_ms: u64) -> NodeError {
    let now = scope.run.engine.now_ms();
    let wait_until = now.saturating_add(i64::try_from(duration_ms).unwrap_or(i64::MAX));
    let mut row = scope
        .walk
        .row(scope.node_id, scope.iteration, StepStatus::Waiting);
    row.started_at = Some(now);
    row.wait_until = Some(wait_until);
    scope.walk.record(row);
    log::info!(
        "[Automation] run {} parked at {}{} until {wait_until}",
        scope.run.run.id,
        scope.node_id,
        at_iteration(scope.iteration)
    );
    NodeError::Parked { wait_until }
}

/// The list to iterate: an array of at most `max_iterations` items, never
/// silently cut.
fn checked_items(value: Value, max_iterations: u32) -> Result<Vec<Value>, NodeError> {
    match value {
        Value::Array(list) if list.len() > max_iterations as usize => {
            Err(NodeError::failed(format!(
                "for_each_too_many_items: {} items, max_iterations is {max_iterations}",
                list.len()
            )))
        }
        Value::Array(list) => Ok(list),
        other => Err(NodeError::failed(format!(
            "for_each_not_array: items rendered to {}",
            json_type(&other)
        ))),
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}
