//! One executor per node kind, dispatched by a single exhaustive match.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::executor::RunScope;
use super::{agent, http};
use crate::automation::graph;
use crate::automation::model::{ConditionOp, NamedTemplate, NodeId, NodeSpec, Port, Template};
use crate::automation::template::{self, RenderContext, RenderError};

pub(super) struct NodeScope<'a> {
    pub run: &'a RunScope<'a>,
    pub node_id: &'a NodeId,
    pub outputs: &'a HashMap<NodeId, Value>,
}

impl NodeScope<'_> {
    /// `secrets` is `Some` only for `http` nodes.
    pub(super) fn render_context<'s>(
        &'s self,
        secrets: Option<&'s HashMap<String, String>>,
    ) -> RenderContext<'s> {
        RenderContext {
            scheduled_for: self.run.run.scheduled_for,
            trigger: self.run.run.trigger,
            outputs: self.outputs,
            secrets,
        }
    }
}

pub(super) struct NodeSuccess {
    pub output: Value,
    pub port: Port,
}

#[derive(Debug)]
pub(super) enum NodeError {
    /// Routed to the node's `error` edges, or fails the run without one.
    /// `output` keeps what the node saw (an http error response).
    Failed {
        message: String,
        output: Option<Value>,
    },
    /// A `fail` node: the run fails with this message.
    Halt(String),
    Cancelled,
}

impl NodeError {
    pub(super) fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
            output: None,
        }
    }
}

pub(super) async fn run(scope: &NodeScope<'_>, spec: &NodeSpec) -> Result<NodeSuccess, NodeError> {
    let out = |output| NodeSuccess {
        output,
        port: Port::Out,
    };
    match spec {
        NodeSpec::Http {
            method,
            url,
            headers,
            body,
            allowed_hosts,
        } => {
            let request = http::HttpSpec {
                method: *method,
                url,
                headers,
                body: body.as_ref(),
                allowed_hosts,
                secret_names: graph::secret_names(spec),
            };
            http::run(scope, request).await.map(out)
        }
        NodeSpec::Agent {
            agent_id,
            model,
            prompt,
            output_schema,
            timeout_ms,
            max_attempts,
        } => {
            let request = agent::AgentSpec {
                agent_id,
                model: model.as_deref(),
                prompt,
                output_schema,
                timeout_ms: *timeout_ms,
                max_attempts: *max_attempts,
            };
            agent::run(scope, request).await.map(out)
        }
        NodeSpec::Transform { fields } => transform(scope, fields).map(out),
        NodeSpec::Condition { left, op, right } => condition(scope, left, *op, right.as_ref()),
        NodeSpec::Fail { message } => {
            let ctx = scope.render_context(None);
            Err(NodeError::Halt(render_text(message, &ctx)?))
        }
    }
}

pub(super) fn render(template: &Template, ctx: &RenderContext<'_>) -> Result<Value, NodeError> {
    try_render(template, ctx).map_err(NodeError::failed)
}

/// The rendered value as text: strings as-is, anything else as JSON.
pub(super) fn render_text(
    template: &Template,
    ctx: &RenderContext<'_>,
) -> Result<String, NodeError> {
    render(template, ctx).map(|value| text(&value))
}

fn try_render(template: &Template, ctx: &RenderContext<'_>) -> Result<Value, String> {
    let parsed = template::parse(template.as_str()).map_err(|e| e.to_string())?;
    parsed.render(ctx).map_err(|e| e.to_string())
}

fn transform(scope: &NodeScope<'_>, fields: &[NamedTemplate]) -> Result<Value, NodeError> {
    let ctx = scope.render_context(None);
    let mut object = Map::new();
    for field in fields {
        object.insert(field.name.clone(), render(&field.value, &ctx)?);
    }
    Ok(Value::Object(object))
}

fn condition(
    scope: &NodeScope<'_>,
    left: &Template,
    op: ConditionOp,
    right: Option<&Template>,
) -> Result<NodeSuccess, NodeError> {
    let ctx = scope.render_context(None);
    let operands = || -> Result<(Value, Value), NodeError> {
        let r = right.map(|t| render(t, &ctx)).transpose()?;
        Ok((render(left, &ctx)?, r.unwrap_or(Value::Null)))
    };
    let result = match op {
        ConditionOp::Exists => exists(left, &ctx)?,
        ConditionOp::Eq => {
            let (l, r) = operands()?;
            loosely_equal(&l, &r)
        }
        ConditionOp::Ne => {
            let (l, r) = operands()?;
            !loosely_equal(&l, &r)
        }
        ConditionOp::Contains => {
            let (l, r) = operands()?;
            match &l {
                Value::Array(items) => items.iter().any(|item| loosely_equal(item, &r)),
                other => text(other).contains(&text(&r)),
            }
        }
        ConditionOp::Gt | ConditionOp::Lt => {
            let (l, r) = operands()?;
            let (Some(a), Some(b)) = (number(&l), number(&r)) else {
                return Err(NodeError::failed(
                    "condition_not_comparable: gt and lt need two numbers",
                ));
            };
            if op == ConditionOp::Gt {
                a > b
            } else {
                a < b
            }
        }
    };
    Ok(NodeSuccess {
        output: json!({ "result": result }),
        port: if result { Port::True } else { Port::False },
    })
}

/// A missing output or field is `false`; other render errors still fail.
fn exists(template: &Template, ctx: &RenderContext<'_>) -> Result<bool, NodeError> {
    let parsed =
        template::parse(template.as_str()).map_err(|e| NodeError::failed(e.to_string()))?;
    match parsed.render(ctx) {
        Ok(value) => Ok(!value.is_null()),
        Err(RenderError::MissingOutput(_) | RenderError::MissingField { .. }) => Ok(false),
        Err(error) => Err(NodeError::failed(error.to_string())),
    }
}

/// Templates mix typed holes with literal text, so `3` and `"3"` (or `true`
/// and `"true"`) compare equal.
fn loosely_equal(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    match (number(a), number(b)) {
        (Some(x), Some(y)) => x == y,
        _ => text(a) == text(b),
    }
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub(super) fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
