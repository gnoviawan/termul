//! Wire and storage shapes for chat-authored automations.
//!
//! `src/shared/types/automation.types.ts` mirrors every type here; the shared
//! fixture `src/shared/types/__fixtures__/automation.json` pins both sides.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The serde name of a unit enum variant, e.g. `RunStatus::CatchUp` -> `catch_up`.
pub fn wire_name<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(name)) => name,
        other => format!("{other:?}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AutomationId(String);

impl AutomationId {
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for AutomationId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Display for AutomationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(String);

impl RunId {
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for RunId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// `^[a-z][a-z0-9_]{0,31}$`, never `trigger`. Parsing rejects anything else,
/// so every `NodeId` in memory is well-formed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NodeId(String);

pub const TRIGGER_SOURCE: &str = "trigger";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidNodeId(pub String);

impl fmt::Display for InvalidNodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid node id {:?}: use 1-32 chars of a-z, 0-9 or _, starting with a letter, and not \"trigger\"",
            self.0
        )
    }
}

impl std::error::Error for InvalidNodeId {}

impl NodeId {
    pub fn parse(value: impl Into<String>) -> Result<Self, InvalidNodeId> {
        let value = value.into();
        let mut chars = value.chars();
        let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_lowercase());
        let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if starts_with_letter && rest_ok && value.len() <= 32 && value != TRIGGER_SOURCE {
            Ok(Self(value))
        } else {
            Err(InvalidNodeId(value))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NodeId {
    type Error = InvalidNodeId;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<NodeId> for String {
    fn from(value: NodeId) -> Self {
        value.0
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A string with `{{ path }}` holes; see `template.rs` for the grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Template(pub String);

impl Template {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A JSON Schema document as authored. `schema::parse` decides whether it is
/// inside the supported subset; a schema outside it is a validation issue, not
/// a parse failure, so the agent can save and then fix it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonSchemaSubset(pub Value);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Automation {
    pub id: AutomationId,
    pub project_id: String,
    pub name: String,
    pub revision: u64,
    pub approved_revision: Option<u64>,
    pub enabled: bool,
    pub trigger: Trigger,
    pub graph: Graph,
    pub isolation: Isolation,
    pub next_run_at: Option<i64>,
    pub consecutive_errors: u32,
    pub schedule_error_count: u32,
    pub unseen_failures: u32,
    pub last_run: Option<LastRun>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

impl Automation {
    pub fn new(project_id: String, name: String, now_ms: i64) -> Self {
        Self {
            id: AutomationId::generate(),
            project_id,
            name,
            revision: 1,
            approved_revision: None,
            enabled: true,
            trigger: Trigger::Manual,
            graph: Graph::default(),
            isolation: Isolation::SharedInRoot,
            next_run_at: None,
            consecutive_errors: 0,
            schedule_error_count: 0,
            unseen_failures: 0,
            last_run: None,
            created_at: now_ms,
            updated_at: now_ms,
            deleted_at: None,
        }
    }

    pub fn armed(&self) -> bool {
        self.enabled && self.deleted_at.is_none() && self.approved_revision == Some(self.revision)
    }

    pub fn schedule(&self) -> Option<&Schedule> {
        match &self.trigger {
            Trigger::Manual => None,
            Trigger::Schedule { schedule } => Some(schedule),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastRun {
    pub run_id: RunId,
    pub status: RunStatus,
    pub finished_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Isolation {
    SharedInRoot,
    WorktreePerRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    Schedule { schedule: Schedule },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    Cron { expr: String, timezone: String },
    Every { every_ms: u64, anchor_ms: i64 },
    At { at: i64 },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.iter().find(|n| &n.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub label: String,
    pub spec: NodeSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeSpec {
    Http {
        method: HttpMethod,
        url: Template,
        #[serde(default)]
        headers: Vec<NamedTemplate>,
        #[serde(default)]
        body: Option<Template>,
        #[serde(default)]
        allowed_hosts: Vec<String>,
    },
    Agent {
        agent_id: String,
        #[serde(default)]
        model: Option<String>,
        prompt: Template,
        output_schema: JsonSchemaSubset,
        timeout_ms: u64,
        max_attempts: u8,
    },
    Transform {
        fields: Vec<NamedTemplate>,
    },
    Condition {
        left: Template,
        op: ConditionOp,
        #[serde(default)]
        right: Option<Template>,
    },
    Fail {
        message: Template,
    },
}

pub const AGENT_MAX_TIMEOUT_MS: u64 = 900_000;
pub const AGENT_MAX_ATTEMPTS: u8 = 3;

impl NodeSpec {
    pub fn kind(&self) -> NodeKind {
        match self {
            NodeSpec::Http { .. } => NodeKind::Http,
            NodeSpec::Agent { .. } => NodeKind::Agent,
            NodeSpec::Transform { .. } => NodeKind::Transform,
            NodeSpec::Condition { .. } => NodeKind::Condition,
            NodeSpec::Fail { .. } => NodeKind::Fail,
        }
    }

    /// Every template the node renders, tagged with where it sits so issues
    /// and the secret rule can name the field.
    pub fn templates(&self) -> Vec<(String, &Template)> {
        match self {
            NodeSpec::Http {
                url, headers, body, ..
            } => {
                let mut out = vec![("url".to_string(), url)];
                out.extend(
                    headers
                        .iter()
                        .map(|h| (format!("headers.{}", h.name), &h.value)),
                );
                out.extend(body.iter().map(|b| ("body".to_string(), b)));
                out
            }
            NodeSpec::Agent { prompt, .. } => vec![("prompt".to_string(), prompt)],
            NodeSpec::Transform { fields } => fields
                .iter()
                .map(|f| (format!("fields.{}", f.name), &f.value))
                .collect(),
            NodeSpec::Condition { left, right, .. } => {
                let mut out = vec![("left".to_string(), left)];
                out.extend(right.iter().map(|r| ("right".to_string(), r)));
                out
            }
            NodeSpec::Fail { message } => vec![("message".to_string(), message)],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Http,
    Agent,
    Transform,
    Condition,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedTemplate {
    pub name: String,
    pub value: Template,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Eq,
    Ne,
    Contains,
    Gt,
    Lt,
    Exists,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Edge {
    pub from: EdgeSource,
    pub port: Port,
    pub to: NodeId,
}

/// Wire form is a plain string: `"trigger"` or a node id. `NodeId` refuses
/// `"trigger"`, so the two never collide.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum EdgeSource {
    Trigger,
    Node(NodeId),
}

impl TryFrom<String> for EdgeSource {
    type Error = InvalidNodeId;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value == TRIGGER_SOURCE {
            Ok(Self::Trigger)
        } else {
            NodeId::parse(value).map(Self::Node)
        }
    }
}

impl From<EdgeSource> for String {
    fn from(value: EdgeSource) -> Self {
        match value {
            EdgeSource::Trigger => TRIGGER_SOURCE.to_string(),
            EdgeSource::Node(id) => id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Port {
    Out,
    Error,
    True,
    False,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    AddNode {
        node: Node,
    },
    UpdateNode {
        id: NodeId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spec: Option<NodeSpec>,
    },
    RemoveNode {
        id: NodeId,
    },
    Connect {
        edge: Edge,
    },
    Disconnect {
        edge: Edge,
    },
    SetTrigger {
        trigger: Trigger,
    },
    Rename {
        name: String,
    },
    SetIsolation {
        isolation: Isolation,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub node_id: Option<NodeId>,
    pub code: IssueCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueCode {
    DuplicateNodeId,
    UnknownEdgeEndpoint,
    IllegalPort,
    TriggerEdgeCount,
    Cycle,
    Unreachable,
    InvalidTemplate,
    UnknownNodeReference,
    NonAncestorReference,
    SecretNotAllowed,
    InvalidUrl,
    HostNotAllowed,
    TemplatedHostWithoutAllowlist,
    InvalidOutputSchema,
    AgentTimeoutOutOfRange,
    AgentMaxAttemptsOutOfRange,
    MissingConditionOperand,
    InvalidSchedule,
    /// Added by the service, which owns the agent registry.
    UnknownAgent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApplyOpsResult {
    pub automation: Automation,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

/// The terminal subset of [`RunStatus`]; settling can never target `running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettledStatus {
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

impl From<SettledStatus> for RunStatus {
    fn from(value: SettledStatus) -> Self {
        match value {
            SettledStatus::Succeeded => RunStatus::Succeeded,
            SettledStatus::Failed => RunStatus::Failed,
            SettledStatus::Cancelled => RunStatus::Cancelled,
            SettledStatus::Skipped => RunStatus::Skipped,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    Scheduled,
    CatchUp,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub id: RunId,
    pub automation_id: AutomationId,
    pub revision: u64,
    /// Snapshot of the graph at `revision`; later edits never change a run.
    pub graph: Graph,
    pub trigger: RunTrigger,
    /// Claimed slot for scheduled runs, request instant for manual ones.
    pub scheduled_for: i64,
    pub status: RunStatus,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub stop_reason: Option<String>,
    pub summary: Option<String>,
    pub conversation_id: Option<String>,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Running,
    Succeeded,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub status: StepStatus,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunPolicy {
    pub trigger_summary: String,
    pub next_runs: Vec<i64>,
    pub agents: Vec<AgentPolicy>,
    pub secrets: Vec<NodeSecrets>,
    pub outbound_hosts: Vec<NodeHosts>,
    pub untrusted_flow: bool,
    pub failure_policy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPolicy {
    pub node_id: NodeId,
    pub agent_id: String,
    pub model: Option<String>,
    pub timeout_ms: u64,
    pub tools: AgentTools,
}

/// v1 agents run with no tools; the enum leaves room for allowlists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTools {
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSecrets {
    pub node_id: NodeId,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeHosts {
    pub node_id: NodeId,
    pub hosts: Vec<String>,
}

/// Wire event name of [`AutomationChanged`].
pub const EVENT_AUTOMATION_CHANGED: &str = "automation_changed";

/// Something about an automation changed: its definition, its approval, or a
/// run. `automation_id` is `None` for project-wide changes (secret names).
/// `proposed` marks a chat agent asking the user to review and approve it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationChanged {
    pub project_id: String,
    pub automation_id: Option<AutomationId>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub proposed: bool,
}
