//! The `automation_*` tools: each forwards its arguments to the parent as an
//! `Automation` frame and returns the parent's JSON or text verbatim.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_router};
use serde_json::Value;

use super::TermulPlanServer;
use crate::acp::host_mcp::automation_tools::{
    AutomationApplyOpsInput, AutomationCreateInput, AutomationRefInput, AutomationTool,
    APPLY_OPS_DESCRIPTION, CAPABILITIES_DESCRIPTION, CREATE_DESCRIPTION, GET_DESCRIPTION,
    GUIDE_DESCRIPTION, LIST_DESCRIPTION, PROPOSE_DESCRIPTION,
};
use crate::acp::host_mcp::{FrameKind, FrameRequest};

/// Service calls are local SQLite reads and writes.
const ROUND_TRIP: std::time::Duration = std::time::Duration::from_secs(10);

/// `automation_capabilities` also lists the project's MCP servers, so it
/// waits past their listing deadline and still answers `unavailable`.
fn round_trip(tool: AutomationTool) -> std::time::Duration {
    match tool {
        AutomationTool::Capabilities => crate::automation::mcp::LISTING_DEADLINE + ROUND_TRIP,
        _ => ROUND_TRIP,
    }
}

impl TermulPlanServer {
    async fn automation(&self, tool: AutomationTool, input: Option<Value>) -> CallToolResult {
        let request = FrameRequest {
            automation_tool: Some(tool),
            automation_input: input,
            ..self.frame(FrameKind::Automation)
        };
        self.text_call(tool.name(), request, round_trip(tool)).await
    }
}

fn arguments<T: serde::Serialize>(input: T) -> Option<Value> {
    serde_json::to_value(input).ok()
}

#[tool_router(router = automation_tool_router, vis = "pub(super)")]
impl TermulPlanServer {
    #[tool(
        name = "automation_guide",
        description = GUIDE_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_guide(&self) -> CallToolResult {
        self.automation(AutomationTool::Guide, None).await
    }

    #[tool(
        name = "automation_capabilities",
        description = CAPABILITIES_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_capabilities(&self) -> CallToolResult {
        self.automation(AutomationTool::Capabilities, None).await
    }

    #[tool(
        name = "automation_list",
        description = LIST_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_list(&self) -> CallToolResult {
        self.automation(AutomationTool::List, None).await
    }

    #[tool(
        name = "automation_get",
        description = GET_DESCRIPTION,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn automation_get(
        &self,
        Parameters(input): Parameters<AutomationRefInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Get, arguments(input)).await
    }

    #[tool(
        name = "automation_create",
        description = CREATE_DESCRIPTION,
        annotations(destructive_hint = false, open_world_hint = false)
    )]
    async fn automation_create(
        &self,
        Parameters(input): Parameters<AutomationCreateInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Create, arguments(input))
            .await
    }

    #[tool(
        name = "automation_apply_ops",
        description = APPLY_OPS_DESCRIPTION,
        annotations(destructive_hint = true, open_world_hint = false)
    )]
    async fn automation_apply_ops(
        &self,
        Parameters(input): Parameters<AutomationApplyOpsInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::ApplyOps, arguments(input))
            .await
    }

    #[tool(
        name = "automation_propose",
        description = PROPOSE_DESCRIPTION,
        annotations(destructive_hint = false, open_world_hint = false)
    )]
    async fn automation_propose(
        &self,
        Parameters(input): Parameters<AutomationRefInput>,
    ) -> CallToolResult {
        self.automation(AutomationTool::Propose, arguments(input))
            .await
    }
}
