//! `{{ path }}` templates: parsing, reference listing and rendering.
//!
//! Roots: `trigger.scheduled_for`, `trigger.kind`,
//! `nodes.<id>.output[.field...]`, `secrets.<NAME>`, and inside a
//! `for_each` body `nodes.<loop>.item[.field...]` and `nodes.<loop>.index`.

use std::collections::HashMap;
use std::fmt;

use serde_json::Value;

use super::model::{wire_name, NodeId, RunTrigger};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reference {
    TriggerScheduledFor,
    TriggerKind,
    NodeOutput { node: NodeId, path: Vec<String> },
    Secret(String),
    /// The current element of `node`'s for_each.
    LoopItem { node: NodeId, path: Vec<String> },
    /// The 0-based index of the current element of `node`'s for_each.
    LoopIndex { node: NodeId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    Literal(String),
    Hole(Reference),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTemplate {
    parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    Unterminated { offset: usize },
    InvalidPath { path: String, reason: String },
}

impl fmt::Display for TemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TemplateError::Unterminated { offset } => {
                write!(f, "unterminated '{{{{' at byte {offset}")
            }
            TemplateError::InvalidPath { path, reason } => {
                write!(f, "invalid reference {{{{ {path} }}}}: {reason}")
            }
        }
    }
}

impl std::error::Error for TemplateError {}

pub fn parse(source: &str) -> Result<ParsedTemplate, TemplateError> {
    let mut parts = Vec::new();
    let mut rest = source;
    let mut consumed = 0;
    while let Some(open) = rest.find("{{") {
        if open > 0 {
            parts.push(Part::Literal(rest[..open].to_string()));
        }
        let after_open = &rest[open + 2..];
        let close = after_open.find("}}").ok_or(TemplateError::Unterminated {
            offset: consumed + open,
        })?;
        parts.push(Part::Hole(parse_reference(after_open[..close].trim())?));
        let advance = open + 2 + close + 2;
        consumed += advance;
        rest = &rest[advance..];
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest.to_string()));
    }
    Ok(ParsedTemplate { parts })
}

fn parse_reference(path: &str) -> Result<Reference, TemplateError> {
    let invalid = |reason: &str| TemplateError::InvalidPath {
        path: path.to_string(),
        reason: reason.to_string(),
    };
    let segments: Vec<&str> = path.split('.').collect();
    if segments.iter().any(|s| !is_segment(s)) {
        return Err(invalid(
            "segments must be non-empty and use letters, digits, _ or -",
        ));
    }
    match segments.as_slice() {
        ["trigger", "scheduled_for"] => Ok(Reference::TriggerScheduledFor),
        ["trigger", "kind"] => Ok(Reference::TriggerKind),
        ["trigger", ..] => Err(invalid("trigger exposes only scheduled_for and kind")),
        ["nodes", id, root @ ("output" | "item" | "index"), field @ ..] => {
            let node = NodeId::parse(*id).map_err(|e| invalid(&e.to_string()))?;
            let path = field.iter().map(|s| s.to_string()).collect();
            match *root {
                "output" => Ok(Reference::NodeOutput { node, path }),
                "item" => Ok(Reference::LoopItem { node, path }),
                _ if field.is_empty() => Ok(Reference::LoopIndex { node }),
                _ => Err(invalid("nodes.<loop>.index has no fields")),
            }
        }
        ["nodes", ..] => Err(invalid(
            "use nodes.<id>.output[.field...], nodes.<loop>.item[.field...] or nodes.<loop>.index",
        )),
        ["secrets", name] => Ok(Reference::Secret(name.to_string())),
        ["secrets", ..] => Err(invalid("use secrets.<NAME>")),
        _ => Err(invalid("root must be trigger, nodes or secrets")),
    }
}

fn is_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The iteration a `for_each` body is rendering in.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopFrame {
    pub node: NodeId,
    pub item: Value,
    pub index: u32,
}

/// What a render may read. `secrets` is `None` where secrets are forbidden,
/// so a forbidden render cannot reach a secret value by construction.
/// `frame` is `Some` only inside a for_each body.
pub struct RenderContext<'a> {
    pub scheduled_for: i64,
    pub trigger: RunTrigger,
    pub outputs: &'a HashMap<NodeId, Value>,
    pub secrets: Option<&'a HashMap<String, String>>,
    pub frame: Option<&'a LoopFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    MissingOutput(NodeId),
    /// `reference` is the dotted path as written, e.g. `nodes.a.output.x`.
    MissingField { reference: String },
    SecretForbidden(String),
    SecretMissing(String),
    /// `nodes.<loop>.item` or `.index` rendered outside that loop's body.
    NotInLoop(NodeId),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::MissingOutput(node) => write!(f, "node {node} has no output"),
            RenderError::MissingField { reference } => write!(f, "{reference} is missing"),
            RenderError::SecretForbidden(name) => {
                write!(f, "secrets.{name} is not allowed here")
            }
            RenderError::SecretMissing(name) => write!(f, "secret_missing:{name}"),
            RenderError::NotInLoop(node) => {
                write!(f, "nodes.{node}.item is only available inside {node}'s loop body")
            }
        }
    }
}

impl std::error::Error for RenderError {}

impl ParsedTemplate {
    pub fn references(&self) -> impl Iterator<Item = &Reference> {
        self.parts.iter().filter_map(|p| match p {
            Part::Hole(r) => Some(r),
            Part::Literal(_) => None,
        })
    }

    pub fn has_holes(&self) -> bool {
        self.references().next().is_some()
    }

    /// Text with every hole replaced by `marker`; lets callers inspect the
    /// literal structure (for example a URL's host) without rendering.
    pub fn with_holes_as(&self, marker: &str) -> String {
        self.parts
            .iter()
            .map(|p| match p {
                Part::Literal(text) => text.as_str(),
                Part::Hole(_) => marker,
            })
            .collect()
    }

    /// A template that is exactly one hole keeps the referenced JSON value;
    /// anything else renders to a string.
    pub fn render(&self, ctx: &RenderContext<'_>) -> Result<Value, RenderError> {
        if let [Part::Hole(reference)] = self.parts.as_slice() {
            return resolve(reference, ctx);
        }
        let mut out = String::new();
        for part in &self.parts {
            match part {
                Part::Literal(text) => out.push_str(text),
                Part::Hole(reference) => out.push_str(&stringify(&resolve(reference, ctx)?)),
            }
        }
        Ok(Value::String(out))
    }
}

fn resolve(reference: &Reference, ctx: &RenderContext<'_>) -> Result<Value, RenderError> {
    match reference {
        Reference::TriggerScheduledFor => Ok(Value::from(ctx.scheduled_for)),
        Reference::TriggerKind => Ok(Value::String(wire_name(&ctx.trigger))),
        Reference::NodeOutput { node, path } => {
            let value = ctx
                .outputs
                .get(node)
                .ok_or_else(|| RenderError::MissingOutput(node.clone()))?;
            field(value, path, || format!("nodes.{node}.output"))
        }
        Reference::LoopItem { node, path } => {
            let frame = loop_frame(ctx, node)?;
            field(&frame.item, path, || format!("nodes.{node}.item"))
        }
        Reference::LoopIndex { node } => Ok(Value::from(loop_frame(ctx, node)?.index)),
        Reference::Secret(name) => {
            let secrets = ctx
                .secrets
                .ok_or_else(|| RenderError::SecretForbidden(name.clone()))?;
            secrets
                .get(name)
                .map(|v| Value::String(v.clone()))
                .ok_or_else(|| RenderError::SecretMissing(name.clone()))
        }
    }
}

fn loop_frame<'a>(ctx: &RenderContext<'a>, node: &NodeId) -> Result<&'a LoopFrame, RenderError> {
    ctx.frame
        .filter(|frame| &frame.node == node)
        .ok_or_else(|| RenderError::NotInLoop(node.clone()))
}

fn field(value: &Value, path: &[String], root: impl Fn() -> String) -> Result<Value, RenderError> {
    let mut value = value;
    for segment in path {
        let next = match value {
            Value::Object(map) => map.get(segment),
            Value::Array(items) => segment.parse::<usize>().ok().and_then(|i| items.get(i)),
            _ => None,
        };
        value = next.ok_or_else(|| RenderError::MissingField {
            reference: std::iter::once(root()).chain(path.iter().cloned()).collect::<Vec<_>>().join("."),
        })?;
    }
    Ok(value.clone())
}

fn stringify(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
