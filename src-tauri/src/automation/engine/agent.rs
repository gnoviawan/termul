//! `agent` nodes: one fresh ephemeral session per node, asked for a single
//! JSON value matching the node's schema. A reply that does not match is
//! re-prompted in the same session with the validation errors, up to
//! `max_attempts`, all inside the node's `timeout_ms`. The session is always
//! disposed.

use std::time::Duration;

use serde_json::Value;
use tokio::time::Instant;

use super::nodes::{render_text, NodeError, NodeScope};
use crate::acp::oneshot::{OneShotError, OneShotRequest, OneShotSession};
use crate::automation::model::{JsonSchemaSubset, Template};
use crate::automation::schema::{self, Schema};

pub(super) struct AgentSpec<'a> {
    pub agent_id: &'a str,
    pub model: Option<&'a str>,
    pub prompt: &'a Template,
    pub output_schema: &'a JsonSchemaSubset,
    pub timeout_ms: u64,
    pub max_attempts: u8,
}

pub(super) async fn run(scope: &NodeScope<'_>, spec: AgentSpec<'_>) -> Result<Value, NodeError> {
    let engine = scope.run.engine;
    let config = engine
        .agents
        .resolve(spec.agent_id)
        .ok_or_else(|| NodeError::failed("agent_unknown"))?;
    let schema = schema::parse(&spec.output_schema.0)
        .map_err(|e| NodeError::failed(format!("invalid_output_schema: {e}")))?;
    let prompt = render_text(spec.prompt, &scope.render_context(None))?;
    let first = format!(
        "{prompt}\n\nAnswer with exactly one JSON value that matches this JSON Schema, and nothing else. Do not use tools.\n```json\n{}\n```",
        spec.output_schema.0
    );
    let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
    let request = OneShotRequest {
        config,
        cwd: scope.run.cwd.to_string_lossy().into_owned(),
        model: spec.model.map(str::to_string),
        project_id: Some(scope.run.project_id.to_string()),
    };
    let started = tokio::select! {
        started = tokio::time::timeout_at(deadline, OneShotSession::start(&engine.acp, request)) => started,
        _ = scope.run.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let mut session = match started {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => return Err(NodeError::failed(format!("agent_failed: {error}"))),
        Err(_) => return Err(NodeError::failed("agent_timeout")),
    };
    let result = converse(
        scope,
        &mut session,
        first,
        &schema,
        spec.max_attempts,
        deadline,
    )
    .await;
    session.dispose().await;
    result
}

async fn converse(
    scope: &NodeScope<'_>,
    session: &mut OneShotSession,
    first: String,
    schema: &Schema,
    max_attempts: u8,
    deadline: Instant,
) -> Result<Value, NodeError> {
    let mut text = first;
    let mut problems = Vec::new();
    for attempt in 1..=max_attempts {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(NodeError::failed("agent_timeout"));
        }
        let reply = tokio::select! {
            reply = session.prompt(&text, remaining) => reply,
            _ = scope.run.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let reply = match reply {
            Ok(reply) => reply.text,
            Err(OneShotError::Timeout(_)) => return Err(NodeError::failed("agent_timeout")),
            Err(error) => return Err(NodeError::failed(format!("agent_failed: {error}"))),
        };
        problems = match extract_json(&reply) {
            None => vec!["the reply contains no JSON value".to_string()],
            Some(value) => {
                let errors = schema::validate(schema, &value);
                if errors.is_empty() {
                    return Ok(value);
                }
                errors.iter().map(ToString::to_string).collect()
            }
        };
        log::info!(
            "[Automation] run {} step {} attempt {attempt}/{max_attempts}: reply did not match the schema ({} problem(s))",
            scope.run.run.id,
            scope.node_id,
            problems.len()
        );
        text = format!(
            "Your answer did not match the JSON Schema:\n- {}\nAnswer again with only the corrected JSON value.",
            problems.join("\n- ")
        );
    }
    Err(NodeError::failed(format!(
        "agent_output_invalid: {}",
        problems.join("; ")
    )))
}

/// The JSON value in an agent reply: the whole reply, else the first fenced
/// block that parses, else the first `{` or `[` that starts a value.
pub(super) fn extract_json(reply: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(reply.trim()) {
        return Some(value);
    }
    let fenced = reply.split("```").skip(1).step_by(2).find_map(|block| {
        let body = match block.split_once('\n') {
            Some((tag, rest)) if !tag.trim_start().starts_with(['{', '[']) => rest,
            _ => block,
        };
        serde_json::from_str(body.trim()).ok()
    });
    fenced.or_else(|| {
        reply
            .char_indices()
            .filter(|(_, c)| matches!(c, '{' | '['))
            .find_map(|(i, _)| {
                serde_json::Deserializer::from_str(&reply[i..])
                    .into_iter::<Value>()
                    .next()?
                    .ok()
            })
    })
}
