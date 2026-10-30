//! `Automation` frames: the `automation_*` tools, answered by the host
//! automation service for the calling session's project. An automation of
//! another project is `not_found`. Logs carry the tool, the automation id and
//! counts, never op payloads.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use super::HostPlanServer;
use crate::acp::host_mcp::automation_tools::{
    self, AutomationApplyOpsInput, AutomationCreateInput, AutomationRefInput, AutomationTool,
};
use crate::acp::host_mcp::FrameReply;
use crate::acp::session_persistence::UNASSIGNED_PROJECT_ID;
use crate::automation::model::{AutomationId, Op, Trigger};
use crate::automation::service::{AutomationDetail, AutomationService, ServiceError};

/// The calling session as the tools see it.
struct Caller {
    project_id: String,
    /// The config id of the session's agent, when it was launched from a
    /// saved config: the id an agent node names.
    agent_id: Option<String>,
    /// Redacted, for logs.
    session: String,
}

/// A refused call: the wire code and the agent-facing body
/// `{code, message, ...}`, which carries what the agent needs to recover.
struct Refusal {
    code: &'static str,
    body: Value,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            body: json!({ "code": code, "message": message.into() }),
        }
    }

    fn with(mut self, key: &str, value: Value) -> Self {
        self.body[key] = value;
        self
    }

    fn reply(self) -> FrameReply {
        let message = self.body["message"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        FrameReply {
            result: Some(self.body),
            ..FrameReply::err_code(self.code, message)
        }
    }
}

impl From<ServiceError> for Refusal {
    fn from(error: ServiceError) -> Self {
        let refusal = Self::new(error.code(), error.to_string());
        match error {
            ServiceError::RevisionConflict { current } => {
                refusal.with("current_revision", json!(current))
            }
            ServiceError::HasIssues(issues) => refusal.with("issues", json!(issues)),
            _ => refusal,
        }
    }
}

/// One line per automation in `automation_list`.
#[derive(Serialize)]
struct Listed<'a> {
    id: &'a AutomationId,
    name: &'a str,
    revision: u64,
    approved_revision: Option<u64>,
    enabled: bool,
    trigger: &'a Trigger,
    nodes: usize,
}

impl HostPlanServer {
    pub(super) async fn automation_call(
        &self,
        session_id: &str,
        tool: Option<AutomationTool>,
        input: Option<Value>,
    ) -> FrameReply {
        let Some(tool) = tool else {
            return FrameReply::err("an automation frame needs a tool");
        };
        let session = crate::logging::redact_session_id(session_id);
        let Some(service) = self.automation_service() else {
            log::warn!(
                "[host-mcp] {} refused for session {session}: no automation service",
                tool.name()
            );
            return Refusal::new("unavailable", "automations are not available on this host")
                .reply();
        };
        let Some(caller) = self.caller(session_id) else {
            log::warn!(
                "[host-mcp] {} refused for session {session}: no project",
                tool.name()
            );
            return Refusal::new(
                "no_project",
                "this chat belongs to no project; automations live in a project",
            )
            .reply();
        };
        let input = input.unwrap_or(Value::Null);
        let answered =
            tokio::task::spawn_blocking(move || answer(&service, &caller, tool, input)).await;
        match answered {
            Ok(Ok(result)) => FrameReply::ok_with(result),
            Ok(Err(refusal)) => {
                log::warn!(
                    "[host-mcp] {} refused for session {session}: {}",
                    tool.name(),
                    refusal.code
                );
                refusal.reply()
            }
            Err(error) => {
                log::error!(
                    "[host-mcp] {} stopped for session {session}: {error}",
                    tool.name()
                );
                Refusal::new("internal", "the automation call stopped").reply()
            }
        }
    }

    fn automation_service(&self) -> Option<Arc<AutomationService>> {
        self.automation
            .get()
            .cloned()
            .or_else(crate::automation::service::installed)
    }

    /// Test seam: answer automation frames from `service` instead of the
    /// installed one.
    #[cfg(test)]
    pub(crate) fn use_automation_service(&self, service: Arc<AutomationService>) {
        let _ = self.automation.set(service);
    }

    fn caller(&self, session_id: &str) -> Option<Caller> {
        let metadata = self.persistence.as_ref()?.metadata(session_id).ok()?;
        let project_id = metadata
            .project_id
            .filter(|project| !project.is_empty() && project != UNASSIGNED_PROJECT_ID)?;
        let agent_id = metadata
            .stable_agent_namespace
            .as_deref()
            .and_then(|namespace| namespace.strip_prefix("config:"))
            .map(str::to_string);
        Some(Caller {
            project_id,
            agent_id,
            session: crate::logging::redact_session_id(session_id),
        })
    }
}

fn answer(
    service: &AutomationService,
    caller: &Caller,
    tool: AutomationTool,
    input: Value,
) -> Result<Value, Refusal> {
    let project = caller.project_id.as_str();
    let session = caller.session.as_str();
    match tool {
        AutomationTool::Guide => {
            log::info!("[host-mcp] automation_guide for session {session}");
            Ok(Value::String(automation_tools::GUIDE.to_string()))
        }
        AutomationTool::Capabilities => {
            let agents = service.list_agents();
            let calling_agent_id = caller
                .agent_id
                .as_ref()
                .filter(|id| agents.iter().any(|agent| &agent.agent_id == *id));
            let secret_names = service.list_secret_names(project)?;
            log::info!(
                "[host-mcp] automation_capabilities for session {session}: {} agent(s), {} secret name(s)",
                agents.len(),
                secret_names.len()
            );
            Ok(json!({
                "agents": agents,
                "secret_names": secret_names,
                "calling_agent_id": calling_agent_id,
            }))
        }
        AutomationTool::List => {
            let automations = service.list(project)?;
            log::info!(
                "[host-mcp] automation_list for session {session}: {} automation(s)",
                automations.len()
            );
            let listed: Vec<Listed<'_>> = automations
                .iter()
                .map(|a| Listed {
                    id: &a.id,
                    name: &a.name,
                    revision: a.revision,
                    approved_revision: a.approved_revision,
                    enabled: a.enabled,
                    trigger: &a.trigger,
                    nodes: a.graph.nodes.len(),
                })
                .collect();
            Ok(json!({ "automations": listed }))
        }
        AutomationTool::Get => {
            let AutomationRefInput { id } = parse(input)?;
            let detail = owned(service, project, id)?;
            log::info!(
                "[host-mcp] automation_get {} for session {session}: {} issue(s)",
                detail.automation.id,
                detail.issues.len()
            );
            to_json(&detail)
        }
        AutomationTool::Create => {
            let AutomationCreateInput { name } = parse(input)?;
            let created = service.create(project, &name)?;
            log::info!(
                "[host-mcp] automation_create {} for session {session}",
                created.id
            );
            to_json(&created)
        }
        AutomationTool::ApplyOps => {
            let input: AutomationApplyOpsInput = parse(input)?;
            let ops = parse_ops(input.ops)?;
            let id = owned(service, project, input.id)?.automation.id;
            let applied = service.apply_ops(&id, input.base_revision, &ops)?;
            log::info!(
                "[host-mcp] automation_apply_ops {id} for session {session}: {} op(s), revision {}, {} issue(s)",
                ops.len(),
                applied.automation.revision,
                applied.issues.len()
            );
            to_json(&applied)
        }
        AutomationTool::Propose => {
            let AutomationRefInput { id } = parse(input)?;
            let id = owned(service, project, id)?.automation.id;
            let proposed = service.propose(&id)?;
            log::info!(
                "[host-mcp] automation_propose {id} for session {session}: revision {}",
                proposed.revision
            );
            Ok(Value::String(automation_tools::proposed_text(
                &proposed.name,
                proposed.revision,
            )))
        }
    }
}

/// `id` when it belongs to `project`; any other automation is not found.
fn owned(
    service: &AutomationService,
    project: &str,
    id: String,
) -> Result<AutomationDetail, Refusal> {
    let id = AutomationId::from(id);
    match service.get(&id) {
        Ok(detail) if detail.automation.project_id == project => Ok(detail),
        Ok(_) => Err(ServiceError::NotFound(id.to_string()).into()),
        Err(error) => Err(error.into()),
    }
}

fn parse<T: DeserializeOwned>(input: Value) -> Result<T, Refusal> {
    serde_json::from_value(input).map_err(|error| Refusal::new("invalid_input", error.to_string()))
}

fn parse_ops(ops: Vec<Value>) -> Result<Vec<Op>, Refusal> {
    ops.into_iter()
        .enumerate()
        .map(|(index, op)| {
            serde_json::from_value(op)
                .map_err(|error| Refusal::new("invalid_ops", format!("op {index}: {error}")))
        })
        .collect()
}

fn to_json(value: &impl Serialize) -> Result<Value, Refusal> {
    serde_json::to_value(value)
        .map_err(|error| Refusal::new("internal", format!("unencodable result: {error}")))
}
