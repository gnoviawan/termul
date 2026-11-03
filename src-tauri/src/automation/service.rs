//! The host's automation service: the one API the Tauri commands, the web
//! routes and the host MCP tools call. Every mutation emits one
//! [`AutomationChanged`] through [`AutomationService::subscribe`], which the
//! transports forward as `automation_changed`.

use std::fmt;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tokio::sync::broadcast;

use super::agents::{self, AgentRegistry, KnownAgent};
use super::engine::{Engine, EngineDeps, HttpConfig, ProjectRoots, SystemClock};
use super::graph::{self, OpError};
use super::mcp::{Lookup, McpFailure, McpServerEntry, ProjectMcpServers, RmcpClient, ToolSchema};
use super::model::{
    ApplyOpsResult, Automation, AutomationChanged, AutomationId, Issue, IssueCode, NamedTemplate,
    NodeId, NodeSpec, Op, Run, RunId, RunPolicy, RunTrigger, Schedule, Step,
};
use super::policy;
use super::schedule;
use super::secrets::{self, SecretError, Secrets};
use super::store::{AutomationStore, StoreError, DB_FILE_NAME};
use super::suggest::{self, Candidate, Prompt, PromptHistory, SessionHistory, Suggestion};
use crate::acp::config::AgentConfig;
use crate::acp::AcpManager;

const MAX_RUNS_LISTED: usize = 200;
const PREVIEW_RUNS: usize = 3;

static INSTALLED: OnceLock<Arc<AutomationService>> = OnceLock::new();

/// Make the host's service reachable by the transports and the agent spawn
/// path, which are built without a handle to it. The first call wins.
pub fn install(service: Arc<AutomationService>) {
    if INSTALLED.set(service).is_err() {
        log::warn!("[Automation] a service was already installed");
    }
}

pub fn installed() -> Option<Arc<AutomationService>> {
    INSTALLED.get().cloned()
}

/// Called by the agent spawn path every transport shares, so agent nodes can
/// launch any agent a client has started.
pub fn record_spawned_agent(config: &AgentConfig) {
    if let Some(service) = INSTALLED.get() {
        service.engine.agents().record(config);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServiceError {
    NotFound(String),
    RevisionConflict {
        current: u64,
    },
    HasIssues(Vec<Issue>),
    /// Only the approved revision may run.
    NotApproved,
    InvalidOps(OpError),
    InvalidInput(String),
    Secret(SecretError),
    Internal(String),
}

impl ServiceError {
    /// Stable wire code for transports.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::RevisionConflict { .. } => "revision_conflict",
            Self::HasIssues(_) => "has_issues",
            Self::NotApproved => "not_approved",
            Self::InvalidOps(_) => "invalid_ops",
            Self::InvalidInput(_) => "invalid_input",
            Self::Secret(SecretError::KeychainUnavailable) => "keychain_unavailable",
            Self::Secret(SecretError::Missing(_)) => "secret_missing",
            Self::Secret(SecretError::InvalidName(_) | SecretError::EmptyValue) => "invalid_input",
            Self::Secret(SecretError::Store(_)) | Self::Internal(_) => "internal",
        }
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(what) => write!(f, "{what} not found"),
            Self::RevisionConflict { current } => {
                write!(
                    f,
                    "revision conflict: the automation is at revision {current}"
                )
            }
            Self::HasIssues(issues) => write!(f, "{} open issue(s)", issues.len()),
            Self::NotApproved => f.write_str("approve the current revision before running it"),
            Self::InvalidOps(error) => write!(f, "{error}"),
            Self::InvalidInput(detail) => f.write_str(detail),
            Self::Secret(error) => write!(f, "{error}"),
            Self::Internal(detail) => f.write_str(detail),
        }
    }
}

impl std::error::Error for ServiceError {}

impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound(id) => Self::NotFound(id),
            StoreError::RevisionConflict { current } => Self::RevisionConflict { current },
            StoreError::HasIssues(issues) => Self::HasIssues(issues),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl From<SecretError> for ServiceError {
    fn from(error: SecretError) -> Self {
        Self::Secret(error)
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;

/// An automation with what its editor and approval card need.
#[derive(Debug, Clone, PartialEq, Serialize, schemars::JsonSchema)]
pub struct AutomationDetail {
    pub automation: Automation,
    pub issues: Vec<Issue>,
    pub policy: RunPolicy,
}

pub struct AutomationService {
    engine: Arc<Engine>,
    history: Arc<dyn PromptHistory>,
}

impl AutomationService {
    pub fn new(engine: Arc<Engine>, history: Arc<dyn PromptHistory>) -> Self {
        Self { engine, history }
    }

    /// The production wiring: `automations.sqlite` and the known-agents file
    /// in `data_dir`, secrets in the OS keychain or, without one, the file
    /// vault in `data_dir`, suggestions from the chats `acp` persists, and
    /// `mcp_tool` nodes calling the servers `mcp_servers` lists over rmcp.
    pub fn open(
        data_dir: &Path,
        acp: Arc<AcpManager>,
        project_roots: ProjectRoots,
        mcp_servers: ProjectMcpServers,
    ) -> Result<Self, String> {
        let store = Arc::new(
            AutomationStore::open(&data_dir.join(DB_FILE_NAME))
                .map_err(|e| format!("automation store: {e}"))?,
        );
        let history: Arc<dyn PromptHistory> = match acp.persistence() {
            Some(persistence) => Arc::new(SessionHistory::new(persistence)),
            None => Arc::new(|_: &str, _: i64| Vec::new()),
        };
        let engine = Engine::new(EngineDeps {
            secrets: Arc::new(Secrets::new(secrets::open_vault(data_dir), store.clone())),
            store,
            agents: Arc::new(AgentRegistry::open(data_dir.join(agents::FILE_NAME))),
            acp,
            project_roots,
            clock: Arc::new(SystemClock),
            http: HttpConfig::default(),
            mcp_servers,
            mcp_client: Arc::new(RmcpClient),
        })?;
        Ok(Self::new(engine, history))
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AutomationChanged> {
        self.engine.subscribe()
    }

    pub fn list(&self, project_id: &str) -> ServiceResult<Vec<Automation>> {
        Ok(self.engine.store().list(Some(project_id))?)
    }

    pub fn get(&self, id: &AutomationId) -> ServiceResult<AutomationDetail> {
        let automation = self.load(id)?;
        let servers = self.mcp_servers(&automation);
        Ok(AutomationDetail {
            issues: self.issues_with(&automation, &servers),
            policy: self.policy_with(&automation, &servers),
            automation,
        })
    }

    pub fn create(&self, project_id: &str, name: &str) -> ServiceResult<Automation> {
        let (project_id, name) = (project_id.trim(), name.trim());
        if project_id.is_empty() || name.is_empty() {
            return Err(ServiceError::InvalidInput(
                "an automation needs a project and a name".to_string(),
            ));
        }
        let now = self.engine.now_ms();
        let draft = Automation::new(project_id.to_string(), name.to_string(), now);
        let created = self.engine.store().create(&draft, now)?;
        log::info!(
            "[Automation] created {} in project {project_id}",
            created.id
        );
        self.changed(&created);
        Ok(created)
    }

    /// Applies `ops` atomically on top of `base_revision`. A batch that leaves
    /// issues still saves; the result lists them.
    pub fn apply_ops(
        &self,
        id: &AutomationId,
        base_revision: u64,
        ops: &[Op],
    ) -> ServiceResult<ApplyOpsResult> {
        let current = self.load(id)?;
        if current.revision != base_revision {
            return Err(ServiceError::RevisionConflict {
                current: current.revision,
            });
        }
        let next = graph::apply_ops(&current, ops).map_err(ServiceError::InvalidOps)?;
        let saved = self
            .engine
            .store()
            .save(&next, base_revision, self.engine.now_ms())?;
        let issues = self.issues(&saved);
        log::info!(
            "[Automation] {} ops applied to {id}: revision {} ({} issue(s))",
            ops.len(),
            saved.revision,
            issues.len()
        );
        self.changed(&saved);
        Ok(ApplyOpsResult {
            automation: saved,
            issues,
        })
    }

    /// Renames without a new revision: the name is not part of what runs, so
    /// an approval stands.
    pub fn rename(&self, id: &AutomationId, name: &str) -> ServiceResult<Automation> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ServiceError::InvalidInput(
                "a name cannot be empty".to_string(),
            ));
        }
        let mut automation = self.load(id)?;
        automation.name = name.to_string();
        let saved =
            self.engine
                .store()
                .save(&automation, automation.revision, self.engine.now_ms())?;
        self.changed(&saved);
        Ok(saved)
    }

    /// Soft-deletes and cancels a run in flight.
    pub fn delete(&self, id: &AutomationId) -> ServiceResult<()> {
        let automation = self.load(id)?;
        if !self.engine.store().soft_delete(id, self.engine.now_ms())? {
            return Err(ServiceError::NotFound(id.to_string()));
        }
        self.engine.cancel_automation(id);
        log::info!("[Automation] deleted {id}");
        self.changed(&automation);
        Ok(())
    }

    pub fn set_enabled(&self, id: &AutomationId, enabled: bool) -> ServiceResult<Automation> {
        let saved = self
            .engine
            .store()
            .set_enabled(id, enabled, self.engine.now_ms())?;
        log::info!("[Automation] {id} enabled={enabled}");
        self.changed(&saved);
        Ok(saved)
    }

    /// User approval of exactly `revision`. Refused while any issue, unknown
    /// agents included, is open.
    pub fn approve(&self, id: &AutomationId, revision: u64) -> ServiceResult<Automation> {
        let current = self.load(id)?;
        let issues = self.issues(&current);
        if current.revision == revision && !issues.is_empty() {
            return Err(ServiceError::HasIssues(issues));
        }
        let approved = self
            .engine
            .store()
            .approve(id, revision, self.engine.now_ms())?;
        self.changed(&approved);
        Ok(approved)
    }

    /// A chat agent (`by`, its display name when known) asks the user to
    /// review `id`: one change marked `proposed`. Never approves; refused
    /// while any issue is open.
    pub fn propose(&self, id: &AutomationId, by: Option<String>) -> ServiceResult<Automation> {
        let automation = self.load(id)?;
        let issues = self.issues(&automation);
        if !issues.is_empty() {
            return Err(ServiceError::HasIssues(issues));
        }
        log::info!(
            "[Automation] {id} proposed for review at revision {}",
            automation.revision
        );
        self.engine.announce(AutomationChanged {
            project_id: automation.project_id.clone(),
            automation_id: Some(automation.id.clone()),
            proposed: true,
            proposed_by: by,
        });
        Ok(automation)
    }

    /// Starts a manual run of the approved revision. While a run is in flight
    /// the new one is recorded `skipped`.
    pub fn run_now(&self, id: &AutomationId) -> ServiceResult<Run> {
        let automation = self.load(id)?;
        if automation.approved_revision != Some(automation.revision) {
            return Err(ServiceError::NotApproved);
        }
        let now = self.engine.now_ms();
        Ok(self
            .engine
            .start_run(&automation, RunTrigger::Manual, now)?)
    }

    /// `false` when the run is not in flight.
    pub fn cancel_run(&self, run_id: &RunId) -> ServiceResult<bool> {
        if self.engine.store().get_run(run_id)?.is_none() {
            return Err(ServiceError::NotFound(run_id.to_string()));
        }
        Ok(self.engine.cancel_run(run_id))
    }

    /// Newest first, at most 200.
    pub fn list_runs(&self, id: &AutomationId, limit: usize) -> ServiceResult<Vec<Run>> {
        Ok(self
            .engine
            .store()
            .list_runs(id, limit.min(MAX_RUNS_LISTED))?)
    }

    pub fn get_run_steps(&self, run_id: &RunId) -> ServiceResult<Vec<Step>> {
        Ok(self.engine.store().get_steps(run_id)?)
    }

    pub fn mark_seen(&self, id: &AutomationId) -> ServiceResult<()> {
        let automation = self.load(id)?;
        self.engine.store().mark_seen(id)?;
        self.changed(&automation);
        Ok(())
    }

    /// The next three slots of `schedule` from now.
    pub fn preview(&self, schedule: &Schedule) -> ServiceResult<Vec<i64>> {
        schedule::next_runs(schedule, self.engine.now_ms(), PREVIEW_RUNS)
            .map_err(|e| ServiceError::InvalidInput(e.to_string()))
    }

    pub fn policy(&self, id: &AutomationId) -> ServiceResult<RunPolicy> {
        let automation = self.load(id)?;
        Ok(self.policy_with(&automation, &self.mcp_servers(&automation)))
    }

    fn policy_with(&self, automation: &Automation, servers: &[McpServerEntry]) -> RunPolicy {
        let server_name = |id: &str| {
            servers
                .iter()
                .find(|s| s.server_id == id)
                .map(|s| s.name.clone())
        };
        policy::run_policy(automation, self.engine.now_ms(), &server_name)
    }

    /// The project's MCP servers, read only when a node calls one.
    fn mcp_servers(&self, automation: &Automation) -> Vec<McpServerEntry> {
        let calls_mcp = automation
            .graph
            .nodes
            .iter()
            .any(|n| matches!(n.spec, NodeSpec::McpTool { .. }));
        if calls_mcp {
            self.engine.mcp().servers(&automation.project_id)
        } else {
            Vec::new()
        }
    }

    pub fn list_agents(&self) -> Vec<KnownAgent> {
        self.engine.agents().list()
    }

    pub fn set_secret(&self, project_id: &str, name: &str, value: &str) -> ServiceResult<()> {
        self.engine.secrets().set(project_id, name, value)?;
        self.engine.notify(project_id, None);
        Ok(())
    }

    pub fn delete_secret(&self, project_id: &str, name: &str) -> ServiceResult<()> {
        self.engine.secrets().delete(project_id, name)?;
        self.engine.notify(project_id, None);
        Ok(())
    }

    pub fn list_secret_names(&self, project_id: &str) -> ServiceResult<Vec<String>> {
        Ok(self.engine.secrets().list_names(project_id)?)
    }

    /// Asks repeated across `project_id`'s chats that the user has neither
    /// dismissed nor accepted, most days first. Days and the cadence are
    /// local to `timezone` (IANA), the host's zone when absent or unknown.
    /// Reads chat logs: call it off the async runtime.
    pub fn list_suggestions(
        &self,
        project_id: &str,
        timezone: Option<&str>,
    ) -> ServiceResult<Vec<Suggestion>> {
        Ok(self
            .candidates(project_id, timezone, |prompts, _| prompts)?
            .into_iter()
            .map(|candidate| candidate.suggestion)
            .collect())
    }

    /// The open suggestion `text` repeats, if any, counted over the asks
    /// before this one: `text` was just sent and may already be in history.
    /// A hit tells the project's open screens to list suggestions again: the
    /// prompt that matched may have changed their counts.
    pub fn match_prompt(
        &self,
        project_id: &str,
        text: &str,
        timezone: Option<&str>,
    ) -> ServiceResult<Option<Suggestion>> {
        let candidates = self.candidates(project_id, timezone, |prompts, now| {
            suggest::before_send(prompts, text, now)
        })?;
        let hit = suggest::match_prompt(&candidates, text).cloned();
        if let Some(hit) = &hit {
            log::info!(
                "[Automation] a prompt in {project_id} repeats suggestion {}",
                hit.fingerprint
            );
            self.engine.notify(project_id.trim(), None);
        }
        Ok(hit)
    }

    /// Never offer `fingerprint` in `project_id` again.
    pub fn dismiss_suggestion(&self, project_id: &str, fingerprint: &str) -> ServiceResult<()> {
        let (project_id, fingerprint) = suggestion_key(project_id, fingerprint)?;
        self.engine
            .store()
            .dismiss_suggestion(project_id, fingerprint, self.engine.now_ms())?;
        log::info!("[Automation] suggestion {fingerprint} dismissed in {project_id}");
        self.engine.notify(project_id, None);
        Ok(())
    }

    /// The user turns `fingerprint` into an automation; it is not offered
    /// again.
    pub fn accept_suggestion(&self, project_id: &str, fingerprint: &str) -> ServiceResult<()> {
        let (project_id, fingerprint) = suggestion_key(project_id, fingerprint)?;
        self.engine
            .store()
            .accept_suggestion(project_id, fingerprint, self.engine.now_ms())?;
        log::info!("[Automation] suggestion {fingerprint} accepted in {project_id}");
        self.engine.notify(project_id, None);
        Ok(())
    }

    fn candidates(
        &self,
        project_id: &str,
        timezone: Option<&str>,
        history: impl FnOnce(Vec<Prompt>, i64) -> Vec<Prompt>,
    ) -> ServiceResult<Vec<Candidate>> {
        let project_id = project_id.trim();
        if project_id.is_empty() {
            return Err(ServiceError::InvalidInput(
                "suggestions need a project".to_string(),
            ));
        }
        let tz = timezone
            .and_then(|name| name.parse::<chrono_tz::Tz>().ok())
            .unwrap_or_else(suggest::host_timezone);
        let now = self.engine.now_ms();
        let answered = self.engine.store().answered_suggestions(project_id)?;
        let prompts = history(
            self.history.prompts(project_id, now - suggest::WINDOW_MS),
            now,
        );
        let mut candidates = suggest::detect(&prompts, now, tz);
        let found = candidates.len();
        candidates.retain(|c| !answered.contains(&c.suggestion.fingerprint));
        log::debug!(
            "[Automation] suggestions in {project_id}: {} prompts, {found} repeated, {} open",
            prompts.len(),
            candidates.len()
        );
        Ok(candidates)
    }

    fn load(&self, id: &AutomationId) -> ServiceResult<Automation> {
        self.engine
            .store()
            .get(id)?
            .ok_or_else(|| ServiceError::NotFound(id.to_string()))
    }

    fn issues(&self, automation: &Automation) -> Vec<Issue> {
        self.issues_with(automation, &self.mcp_servers(automation))
    }

    /// The pure validator's issues, agent nodes naming an agent this host
    /// has never spawned, and `mcp_tool` nodes checked against the live
    /// `tools/list` of `servers`. Never waits on a server.
    fn issues_with(&self, automation: &Automation, servers: &[McpServerEntry]) -> Vec<Issue> {
        let mut issues = graph::validate(automation);
        let agents = self.engine.agents();
        issues.extend(
            automation
                .graph
                .nodes
                .iter()
                .filter_map(|node| match &node.spec {
                    NodeSpec::Agent { agent_id, .. } if !agents.contains(agent_id) => Some(Issue {
                        node_id: Some(node.id.clone()),
                        code: IssueCode::UnknownAgent,
                        message: format!(
                            "agent {agent_id:?} is not known on this host; start it once in a chat"
                        ),
                    }),
                    _ => None,
                }),
        );
        let mcp = self.engine.mcp();
        for node in &automation.graph.nodes {
            if let NodeSpec::McpTool {
                server_id,
                tool,
                arguments,
                ..
            } = &node.spec
            {
                let lookup = mcp.lookup(&automation.project_id, servers, server_id);
                issues.extend(mcp_issues(&node.id, server_id, tool, arguments, lookup));
            }
        }
        issues
    }

    fn changed(&self, automation: &Automation) {
        self.engine
            .notify(&automation.project_id, Some(&automation.id));
    }
}

fn mcp_issues(
    node_id: &NodeId,
    server_id: &str,
    tool: &str,
    arguments: &[NamedTemplate],
    lookup: Lookup,
) -> Vec<Issue> {
    let issue = |code, message: String| Issue {
        node_id: Some(node_id.clone()),
        code,
        message,
    };
    let tools = match lookup {
        Lookup::UnknownServer => {
            return vec![issue(
                IssueCode::UnknownMcpServer,
                format!(
                    "{server_id:?} is not an enabled MCP server of this project; pick a server_id from automation_capabilities"
                ),
            )]
        }
        Lookup::Pending => {
            return vec![issue(
                IssueCode::McpToolsPending,
                format!("the tools of MCP server {server_id:?} are still being checked; read the automation again in a moment"),
            )]
        }
        Lookup::Failed(McpFailure::AuthRequired) => {
            return vec![issue(
                IssueCode::McpServerUnavailable,
                format!("MCP server {server_id:?} needs a sign-in; sign in to it in the MCP settings"),
            )]
        }
        Lookup::Failed(failure) => {
            let reason = match failure {
                McpFailure::Unavailable(reason) => reason,
                McpFailure::AuthRequired | McpFailure::UnknownTool => "no tool list".to_string(),
            };
            return vec![issue(
                IssueCode::McpServerUnavailable,
                format!("MCP server {server_id:?} did not list its tools: {reason}"),
            )];
        }
        Lookup::Ready(tools) => tools,
    };
    let Some(schema) = tools.iter().find(|t| t.name == tool) else {
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        return vec![issue(
            IssueCode::UnknownMcpTool,
            format!(
                "MCP server {server_id:?} has no tool {tool:?}; it has: {}",
                names.join(", ")
            ),
        )];
    };
    argument_issues(schema, arguments)
        .into_iter()
        .map(|message| issue(IssueCode::InvalidMcpArguments, message))
        .collect()
}

/// A `required` input property with no argument, and an argument the
/// schema does not declare while it sets `additionalProperties: false`.
fn argument_issues(tool: &ToolSchema, arguments: &[NamedTemplate]) -> Vec<String> {
    let given = |name: &str| arguments.iter().any(|a| a.name == name);
    let schema = &tool.input_schema;
    let mut problems: Vec<String> = schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|name| name.as_str())
        .filter(|name| !given(name))
        .map(|name| format!("tool {} requires argument {name}", tool.name))
        .collect();
    if schema["additionalProperties"] == serde_json::Value::Bool(false) {
        let properties = schema["properties"].as_object();
        problems.extend(
            arguments
                .iter()
                .filter(|a| properties.is_none_or(|p| !p.contains_key(&a.name)))
                .map(|a| format!("tool {} takes no argument {}", tool.name, a.name)),
        );
    }
    problems
}

fn suggestion_key<'a>(
    project_id: &'a str,
    fingerprint: &'a str,
) -> ServiceResult<(&'a str, &'a str)> {
    let (project_id, fingerprint) = (project_id.trim(), fingerprint.trim());
    if project_id.is_empty() || fingerprint.is_empty() {
        return Err(ServiceError::InvalidInput(
            "a suggestion needs a project and a fingerprint".to_string(),
        ));
    }
    Ok((project_id, fingerprint))
}
