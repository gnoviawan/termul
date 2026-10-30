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
use super::model::{
    ApplyOpsResult, Automation, AutomationChanged, AutomationId, Issue, IssueCode, NodeSpec, Op,
    Run, RunId, RunPolicy, RunTrigger, Schedule, Step,
};
use super::policy;
use super::schedule;
use super::secrets::{KeychainVault, SecretError, Secrets};
use super::store::{AutomationStore, StoreError, DB_FILE_NAME};
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
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AutomationDetail {
    pub automation: Automation,
    pub issues: Vec<Issue>,
    pub policy: RunPolicy,
}

pub struct AutomationService {
    engine: Arc<Engine>,
}

impl AutomationService {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self { engine }
    }

    /// The production wiring: `automations.sqlite` and the known-agents file
    /// in `data_dir`, secrets in the OS keychain.
    pub fn open(
        data_dir: &Path,
        acp: Arc<AcpManager>,
        project_roots: ProjectRoots,
    ) -> Result<Self, String> {
        let store = Arc::new(
            AutomationStore::open(&data_dir.join(DB_FILE_NAME))
                .map_err(|e| format!("automation store: {e}"))?,
        );
        let engine = Engine::new(EngineDeps {
            secrets: Arc::new(Secrets::new(Arc::new(KeychainVault), store.clone())),
            store,
            agents: Arc::new(AgentRegistry::open(data_dir.join(agents::FILE_NAME))),
            acp,
            project_roots,
            clock: Arc::new(SystemClock),
            http: HttpConfig::default(),
        })?;
        Ok(Self::new(engine))
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
        Ok(AutomationDetail {
            issues: self.issues(&automation),
            policy: policy::run_policy(&automation, self.engine.now_ms()),
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

    /// A chat agent asks the user to review `id`: one change marked
    /// `proposed`. Never approves; refused while any issue is open.
    pub fn propose(&self, id: &AutomationId) -> ServiceResult<Automation> {
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
        Ok(policy::run_policy(&self.load(id)?, self.engine.now_ms()))
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

    fn load(&self, id: &AutomationId) -> ServiceResult<Automation> {
        self.engine
            .store()
            .get(id)?
            .ok_or_else(|| ServiceError::NotFound(id.to_string()))
    }

    /// The pure validator's issues plus agent nodes naming an agent this host
    /// has never spawned.
    fn issues(&self, automation: &Automation) -> Vec<Issue> {
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
        issues
    }

    fn changed(&self, automation: &Automation) {
        self.engine
            .notify(&automation.project_id, Some(&automation.id));
    }
}
