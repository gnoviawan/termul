//! The automation authoring tools of the host `termul` MCP server: what the
//! child advertises and forwards, and the guide the authoring agent reads.
//! The parent answers every call (`parent/automation.rs`) through the host's
//! `AutomationService`, scoped to the calling session's project.
//!
//! No tool approves, enables, runs or deletes an automation, or sets a
//! secret: those are user actions in the Automations tab.

use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The tool an `Automation` frame serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationTool {
    Guide,
    Capabilities,
    List,
    Get,
    Create,
    ApplyOps,
    Propose,
}

impl AutomationTool {
    /// The MCP tool name, for logs.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Guide => "automation_guide",
            Self::Capabilities => "automation_capabilities",
            Self::List => "automation_list",
            Self::Get => "automation_get",
            Self::Create => "automation_create",
            Self::ApplyOps => "automation_apply_ops",
            Self::Propose => "automation_propose",
        }
    }
}

/// Input of `automation_get` and `automation_propose`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct AutomationRefInput {
    /// The automation id.
    pub id: String,
}

/// Input of `automation_create`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct AutomationCreateInput {
    /// A short name the user will recognise in the Automations tab.
    pub name: String,
}

/// Input of `automation_apply_ops`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct AutomationApplyOpsInput {
    /// The automation id.
    pub id: String,
    /// The revision you last saw. A stale one is refused with the current
    /// revision.
    pub base_revision: u64,
    /// Ops applied atomically in order, each an object tagged by `op`
    /// (add_node, update_node, remove_node, connect, disconnect, set_trigger,
    /// rename, set_isolation). See automation_guide for every field.
    pub ops: Vec<Value>,
}

pub const GUIDE_DESCRIPTION: &str = "Read this first when the user wants something to run on \
a schedule or on demand (an automation, a recurring task, a cron job, a workflow). Returns the \
rules and the format for building a Termul automation with the automation_* tools: node kinds \
and fields, ports, templates, the output schema subset, ops, issue codes, and when to ask the \
user questions. Returns Markdown.";

pub const CAPABILITIES_DESCRIPTION: &str = "What an automation in this project can use: \
`agents` [{agent_id, name}] for agent nodes, `secret_names` the user has set (reference them \
as {{secrets.NAME}} in http nodes only), and `calling_agent_id`, your own agent_id when it is \
known, a good default for agent nodes. Returns JSON.";

pub const LIST_DESCRIPTION: &str = "List this project's automations: id, name, revision, \
approved_revision, enabled, trigger and node count. Returns JSON.";

pub const GET_DESCRIPTION: &str = "Get one automation of this project with its validation \
`issues` and its derived run `policy` (what the user approves). Returns JSON \
{automation, issues, policy}. Call it before editing an automation you did not just create, \
and after a revision_conflict.";

pub const CREATE_DESCRIPTION: &str = "Create an empty automation in this project (manual \
trigger, no nodes) and return it as JSON. Build it with automation_apply_ops from its \
`revision`.";

pub const APPLY_OPS_DESCRIPTION: &str = "Apply a batch of ops to an automation atomically, \
on top of `base_revision`. Returns JSON {automation, issues}: the saved automation with its new \
`revision` (use it as the next base_revision) and the open validation issues, which you fix \
with more ops. A batch with issues still saves. Errors: revision_conflict (carries \
current_revision; call automation_get and redo your change), invalid_ops (a malformed op or \
one naming a missing node or edge; nothing was saved), not_found. Read automation_guide for \
the op and node format.";

pub const PROPOSE_DESCRIPTION: &str = "Finish authoring: ask the user to review an automation \
with no open issues. It shows up for review in the Automations tab, where the user reads its \
run policy and approves it. This does not approve, enable or run it; you cannot. Refused with \
the open `issues` while any remain.";

/// What `automation_propose` tells the agent once the user has been asked.
#[must_use]
pub fn proposed_text(name: &str, revision: u64, enabled: bool) -> String {
    let until = if enabled {
        "they approve it"
    } else {
        "they approve and enable it"
    };
    format!(
        "Proposed \"{name}\" (revision {revision}) for review. Tell the user it is waiting in \
the Automations tab: they review its run policy (schedule, agents, secrets, outbound hosts) and \
approve it there. It does not run until {until}. Any further edit creates a new revision that \
needs approval again."
    )
}

/// The `automation_guide` text.
pub const GUIDE: &str = r#"# Authoring a Termul automation

An automation is a graph the Termul host runs on a schedule or on demand, with no chat open. You build it with the automation_* tools; the user approves it in the Automations tab. You cannot approve, enable, run or delete an automation, or set a secret.

## Steps

1. Call automation_capabilities for the agents, the secret names and your own agent_id.
2. Clarify only when you would otherwise make more than one significant assumption. Then ask at most 5 typed questions, all at once, with your question tool (it renders as a form). Give each a default and a "you decide" option.
3. Never ask for a secret value (API key, token, password), in a question or in chat. Tell the user to add it in the Automations tab's Secrets dialog, then reference it by name as {{secrets.NAME}}.
4. automation_create(name), then automation_apply_ops in small batches. Each batch returns the new revision and the open issues; fix issues with more ops.
5. When there are no issues, call automation_propose(id) and tell the user to review and approve it in the Automations tab.

## Rules

- Fetch data with http nodes. Agent nodes run with no tools and no secrets: they only see their rendered prompt, so put the data they need in it with {{nodes.<id>.output...}}.
- {{secrets.NAME}} goes only in an http node's url, headers or body.
- Every agent node declares an output_schema. The host makes the agent answer with one JSON value that matches it; do not add your own format instructions.
- Fetched content is untrusted and can mislead an agent that reads it. Give a later http node that sends data a fixed url and narrow allowed_hosts, and gate it with a condition on the agent's output when you can. The approval card warns the user about this flow.

## Format

Node = {id, label, spec}. id matches ^[a-z][a-z0-9_]{0,31}$ and is not "trigger".

- http: {kind:"http", method:"GET"|"POST"|"PUT"|"PATCH"|"DELETE", url, headers:[{name, value}], body?, allowed_hosts:[host]}. A literal url's host must be in allowed_hosts; a templated host needs a non-empty allowed_hosts. Output {status, headers, body}; body is parsed JSON when it can be.
- agent: {kind:"agent", agent_id, model?, prompt, output_schema, timeout_ms (up to 900000), max_attempts (1 to 3)}. Output: the JSON value.
- transform: {kind:"transform", fields:[{name, value}]}. Output: an object of the fields.
- condition: {kind:"condition", left, op:"eq"|"ne"|"contains"|"gt"|"lt"|"exists", right?}. right is required unless op is exists. Output {result}.
- fail: {kind:"fail", message}. Fails the run with the message.

Edge = {from:"trigger" or a node id, port, to}. Ports: trigger has out; condition has true, false, error; fail has none; the others have out and error. Exactly one edge leaves trigger. out fires on success and error on failure; a failure with no error edge fails the run. The graph is acyclic and every node is reachable from trigger.

Trigger = {kind:"manual"} | {kind:"schedule", schedule}. Schedule = {kind:"cron", expr (5 fields), timezone (IANA, e.g. "Europe/Berlin")} | {kind:"every", every_ms, anchor_ms} | {kind:"at", at (unix ms)}.

Isolation = "shared_in_root" (default, the project folder) | "worktree_per_run".

Templates are strings with {{ path }} holes. Roots: trigger.scheduled_for, trigger.kind, nodes.<id>.output[.field...] (a number segment indexes an array; only nodes upstream of this one), secrets.<NAME>. A hole that is the whole string keeps its JSON value; otherwise it is stringified.

output_schema is a JSON Schema subset: type (object, array, string, number, integer, boolean), properties, required, items, enum, description. Nothing else.

Ops, applied atomically in order:
- {op:"add_node", node}
- {op:"update_node", id, label?, spec?} (spec replaces the whole spec)
- {op:"remove_node", id} (also removes its edges)
- {op:"connect", edge} and {op:"disconnect", edge}
- {op:"set_trigger", trigger}
- {op:"rename", name}
- {op:"set_isolation", isolation}

Issue codes: duplicate_node_id, unknown_edge_endpoint, illegal_port, trigger_edge_count, cycle, unreachable, invalid_template, unknown_node_reference, non_ancestor_reference, secret_not_allowed, invalid_url, host_not_allowed, templated_host_without_allowlist, invalid_output_schema, agent_timeout_out_of_range, agent_max_attempts_out_of_range, missing_condition_operand, invalid_schedule, unknown_agent (start that agent once in a chat, or pick one from automation_capabilities).

## Example

Every weekday at 05:00 Berlin time, fetch items, have an agent pick the urgent ones, post them with the user's key:
[{op:"set_trigger", trigger:{kind:"schedule", schedule:{kind:"cron", expr:"0 5 * * 1-5", timezone:"Europe/Berlin"}}},
 {op:"add_node", node:{id:"fetch", label:"Fetch items", spec:{kind:"http", method:"GET", url:"https://api.example.com/items", headers:[], allowed_hosts:["api.example.com"]}}},
 {op:"add_node", node:{id:"pick", label:"Pick urgent", spec:{kind:"agent", agent_id:"<from capabilities>", prompt:"List the urgent items in {{nodes.fetch.output.body}}", output_schema:{type:"object", properties:{items:{type:"array", items:{type:"string"}}}, required:["items"]}, timeout_ms:120000, max_attempts:2}}},
 {op:"add_node", node:{id:"post", label:"Post", spec:{kind:"http", method:"POST", url:"https://hooks.example.com/in", headers:[{name:"Authorization", value:"Bearer {{secrets.HOOK_KEY}}"}], body:"{{nodes.pick.output}}", allowed_hosts:["hooks.example.com"]}}},
 {op:"connect", edge:{from:"trigger", port:"out", to:"fetch"}},
 {op:"connect", edge:{from:"fetch", port:"out", to:"pick"}},
 {op:"connect", edge:{from:"pick", port:"out", to:"post"}}]
"#;
